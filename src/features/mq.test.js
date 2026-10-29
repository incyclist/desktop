const EventEmitter = require('node:events')

jest.mock('gd-eventlog', () => ({
    EventLogger: jest.fn().mockImplementation(() => ({ logEvent: jest.fn() }))
}))
jest.mock('./utils/index.js', () => ({
    ipcCall: jest.fn(),
    ipcSendEvent: jest.fn(),
    ipcResponse: jest.fn(),
    isTrue: jest.fn()
}))
jest.mock('./secrets/feature', () => ({
    getInstance: () => ({ getSecret: (key) => `${key}-value` })
}))
jest.mock('mqtt', () => ({ connectAsync: jest.fn() }))

const mqtt = require('mqtt')
const { ipcSendEvent } = require('./utils/index.js')
const MessageQueueFeature = require('./mq')

const CONNECT_RETRY_INTERVAL = 10000

class FakeClient extends EventEmitter {
    constructor() {
        super()
        this.subscribe = jest.fn((_topic, cb) => cb(null))
        this.unsubscribe = jest.fn((_topic, cb) => cb(null))
        this.publish = jest.fn()
        this.end = jest.fn()
    }
}

describe('MessageQueueFeature', () => {

    let clients
    let mq
    const event = { sender: { send: jest.fn() } }

    beforeEach(() => {
        jest.useFakeTimers()
        clients = []
        mqtt.connectAsync.mockImplementation(async () => {
            const client = new FakeClient()
            clients.push(client)
            return client
        })
        mq = new MessageQueueFeature()
    })

    afterEach(() => {
        clearInterval(mq.keepAliveIv)
        jest.useRealTimers()
        jest.clearAllMocks()
    })

    describe('connect', () => {
        test('resolves true once the broker connection is established', async () => {
            const connected = await mq.connect()

            expect(connected).toBe(true)
            expect(clients).toHaveLength(1)
        })

        test('resolves true without creating a new client if already connected', async () => {
            await mq.connect()
            const connected = await mq.connect()

            expect(connected).toBe(true)
            expect(clients).toHaveLength(1)
        })
    })

    describe('subscribe after reconnect', () => {
        // Regression test: subscriptions only exist on the broker for the lifetime of one client.
        // After a connection loss keepAlive() creates a new client, but connect() resolved
        // undefined, so subscribe() was never called and the stale `subscribed` flags would
        // have skipped it anyway - the app stayed deaf for the rest of the session.
        test('keepAlive re-subscribes all topics on the new client after the connection was lost', async () => {
            mq.addSubscription(event, 1, 'incyclist/activity/+/hash/+')
            mq.addSubscription(event, 2, 'incyclist/session/abc/info')
            await jest.advanceTimersByTimeAsync(0)

            const [first] = clients
            expect(first.subscribe).toHaveBeenCalledWith('incyclist/activity/+/hash/+', expect.any(Function))
            expect(first.subscribe).toHaveBeenCalledWith('incyclist/session/abc/info', expect.any(Function))

            mq.keepAlive()
            first.emit('close')
            await jest.advanceTimersByTimeAsync(CONNECT_RETRY_INTERVAL)

            expect(clients).toHaveLength(2)
            const second = clients[1]
            expect(second.subscribe).toHaveBeenCalledWith('incyclist/activity/+/hash/+', expect.any(Function))
            expect(second.subscribe).toHaveBeenCalledWith('incyclist/session/abc/info', expect.any(Function))
        })

        test('renderer is told again that the topics are subscribed', async () => {
            mq.addSubscription(event, 1, 'incyclist/session/abc/info')
            await jest.advanceTimersByTimeAsync(0)
            ipcSendEvent.mockClear()

            mq.keepAlive()
            clients[0].emit('close')
            await jest.advanceTimersByTimeAsync(CONNECT_RETRY_INTERVAL)

            expect(ipcSendEvent).toHaveBeenCalledWith('mq-event', 'mq-subscribed', 'incyclist/session/abc/info')
        })

        test('topic whose subscribe was still pending when the connection closed is subscribed again', async () => {
            // the broker never acknowledges, the connection drops while the SUBSCRIBE is in flight
            mqtt.connectAsync.mockImplementationOnce(async () => {
                const client = new FakeClient()
                client.subscribe = jest.fn()
                clients.push(client)
                return client
            })

            mq.addSubscription(event, 1, 'incyclist/session/abc/info')
            await jest.advanceTimersByTimeAsync(0)

            mq.keepAlive()
            clients[0].emit('close')
            await jest.advanceTimersByTimeAsync(CONNECT_RETRY_INTERVAL)

            expect(clients[1].subscribe).toHaveBeenCalledWith('incyclist/session/abc/info', expect.any(Function))
        })
    })

    describe('subscribeTopic', () => {
        test('does not send a second SUBSCRIBE for a topic that is still waiting for its acknowledgement', async () => {
            mqtt.connectAsync.mockImplementationOnce(async () => {
                const client = new FakeClient()
                client.subscribe = jest.fn()       // never acknowledges
                clients.push(client)
                return client
            })

            // the second addSubscription triggers subscribe() for all topics again
            mq.addSubscription(event, 1, 'incyclist/activity/+/hash/+')
            await jest.advanceTimersByTimeAsync(0)
            mq.addSubscription(event, 2, 'incyclist/session/abc/info')
            await jest.advanceTimersByTimeAsync(0)

            const calls = clients[0].subscribe.mock.calls.map(([topic]) => topic)
            expect(calls.filter(t => t === 'incyclist/activity/+/hash/+')).toHaveLength(1)
            expect(calls.filter(t => t === 'incyclist/session/abc/info')).toHaveLength(1)
        })
    })

    describe('removeSubscription while the SUBSCRIBE is pending', () => {
        const connectWithManualAck = () => {
            const acks = []
            mqtt.connectAsync.mockImplementationOnce(async () => {
                const client = new FakeClient()
                client.subscribe = jest.fn((_topic, cb) => { acks.push(cb) })
                clients.push(client)
                return client
            })
            // acknowledges the first (now stale) SUBSCRIBE
            return () => acks[0](null)
        }

        test('undoes the broker subscription once the late ack arrives', async () => {
            const acknowledge = connectWithManualAck()
            mq.addSubscription(event, 1, 'incyclist/session/abc/info')
            await jest.advanceTimersByTimeAsync(0)

            mq.removeSubscription(event, 2, 'incyclist/session/abc/info')
            await jest.advanceTimersByTimeAsync(0)
            ipcSendEvent.mockClear()

            acknowledge()

            expect(clients[0].unsubscribe).toHaveBeenCalledWith('incyclist/session/abc/info', expect.any(Function))
            expect(ipcSendEvent).not.toHaveBeenCalledWith('mq-event', 'mq-subscribed', 'incyclist/session/abc/info')
        })

        test('keeps the broker subscription if the topic was added again in the meantime', async () => {
            const acknowledge = connectWithManualAck()
            mq.addSubscription(event, 1, 'incyclist/session/abc/info')
            await jest.advanceTimersByTimeAsync(0)

            mq.removeSubscription(event, 2, 'incyclist/session/abc/info')
            mq.addSubscription(event, 3, 'incyclist/session/abc/info')
            await jest.advanceTimersByTimeAsync(0)

            acknowledge()

            expect(clients[0].unsubscribe).not.toHaveBeenCalled()
        })
    })

    describe('onClose', () => {
        test('ends the closed client so it cannot keep reconnecting in the background', async () => {
            await mq.connect()
            const [client] = clients

            client.emit('close')

            expect(client.end).toHaveBeenCalledWith(true)
            expect(mq.isConnected()).toBe(false)
            expect(client.listenerCount('message')).toBe(0)
        })

        test('does not throw if ending the client fails', async () => {
            await mq.connect()
            const [client] = clients
            client.end.mockImplementation(() => { throw new Error('boom') })

            expect(() => client.emit('close')).not.toThrow()
        })
    })
})
