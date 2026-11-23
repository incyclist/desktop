// Bridge-mode rule: nothing in the local-link transport may throw or reject uncaught. For every
// target the dependency is made to throw; the call must not throw/reject, must return the fallback
// and must have logged the error.
jest.mock('electron', () => ({
    ipcMain: { on: jest.fn() },
    app: { incyclistApp: undefined },
}))

jest.mock('bonjour-service', () => ({
    Bonjour: class {
        constructor() { throw new Error('bonjour boom') }
    }
}))

const net = require('node:net')
const os = require('node:os')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const electron = require('electron')
const LocalLinkFeature = require('./feature')
const { ControlServer } = require('./control-server')
const { MediaServer } = require('./media-server')
const { PeerFilter } = require('./peer-filter')
const { listLocalAddresses } = require('./network')
const { ipcSubscribe } = require('../utils')

const boom = () => { throw new Error('boom') }
const rejects = () => Promise.reject(new Error('boom'))

const makeSocket = (props = {}) => {
    const socket = new EventEmitter()
    Object.assign(socket, {
        remoteAddress: '127.0.0.1', remotePort: 4711, destroyed: false, writableLength: 0,
        destroy: jest.fn(), end: jest.fn(), write: jest.fn(), setNoDelay: jest.fn(), setTimeout: jest.fn(),
    }, props)
    return socket
}

const logged = (logger, fn) => expect(logger.logEvent).toHaveBeenCalledWith(expect.objectContaining({ fn, error: expect.any(String) }))

afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
    electron.app.incyclistApp = undefined
    delete electron.powerMonitor
})

describe('LocalLinkFeature', () => {
    let feature
    let logger

    beforeEach(() => {
        feature = new LocalLinkFeature()
        logger = { logEvent: jest.fn() }
        feature.logger = logger
    })

    afterEach(() => { feature.stopWatcher() })

    test('getStatus resolves a stopped status', async () => {
        feature.media.getStats = boom
        await expect(feature.getStatus()).resolves.toEqual({
            running: { control: false, media: false }, ports: {}, addresses: [], announced: null,
            connections: 0, handleCount: 0, tokenCount: 0
        })
        logged(logger, 'getStatus')
    })

    test('start resolves ok:false for the requested listeners', async () => {
        feature.control.start = rejects
        feature.media.start = boom
        const res = await feature.start({ control: {}, media: {} })
        expect(res.control).toEqual({ ok: false, error: { code: 'UNKNOWN' } })
        expect(res.media).toEqual({ ok: false, error: { code: 'UNKNOWN' } })
        expect(res.addresses).toEqual([])
        logged(logger, 'start')
    })

    test('stop resolves ok:false', async () => {
        feature.control.stop = rejects
        await expect(feature.stop()).resolves.toEqual({ ok: false })
        logged(logger, 'stop')
    })

    test.each([
        ['setPeerPolicy', () => { feature.peerFilter.setPolicy = boom }, [{}], { ok: false, error: 'internal error' }],
        ['setLimits', () => { feature.control.setLimits = boom }, [{ control: {} }], { ok: false, applied: {} }],
        ['publishMedia', () => { feature.media.publish = boom }, [{}], { ok: false, rejectedHandles: [], rejectedTokens: 0 }],
        ['send', () => { feature.control.send = boom }, ['c', '{}'], { ok: false }],
        ['close', () => { feature.control.close = boom }, ['c'], undefined],
    ])('%s resolves the fallback when the dependency throws', async (fn, arrange, args, fallback) => {
        arrange()
        await expect(feature[fn](...args)).resolves.toEqual(fallback)
        logged(logger, fn)
    })

    test('announce resolves ok:false when bonjour cannot be created', async () => {
        await feature.start({ control: { port: 0, host: '127.0.0.1' } })
        const res = await feature.announce({ instanceName: 'Office', hostLabel: 'office' })
        expect(res.ok).toBe(false)
        await feature.stop()
    })

    test('announce resolves ok:false when validation throws', async () => {
        feature.control.getPort = boom
        await expect(feature.announce({ instanceName: 'Office', hostLabel: 'office' })).resolves.toMatchObject({ ok: false })
        logged(logger, 'validateAnnouncement')
    })

    test('reannounce resolves ok:false when the republish fails', async () => {
        feature.announcement = { instanceName: 'Office', hostLabel: 'office', port: 1234 }
        await expect(feature.reannounce()).resolves.toMatchObject({ ok: false })
    })

    test('withdraw resolves when the bonjour teardown throws', async () => {
        feature.bonjour = { unpublishAll: boom, destroy: boom }
        await expect(feature.withdraw()).resolves.toBeUndefined()
    })

    test('emitEvent swallows a destroyed webContents', () => {
        electron.app.incyclistApp = { getMainWindow: () => ({ win: { webContents: { send: boom } } }) }
        expect(() => feature.emitEvent({ type: 'resumed' })).not.toThrow()
        logged(logger, 'emitEvent')
    })

    test('checkNetwork does not throw when the interfaces cannot be listed', () => {
        feature.listAddresses = boom
        expect(() => feature.checkNetwork()).not.toThrow()
        logged(logger, 'checkNetwork')
    })

    test('startWatcher does not throw, and the interval handler survives a failing poll', () => {
        jest.useFakeTimers()
        feature.listAddresses = jest.fn(() => [])
        feature.startWatcher()
        feature.listAddresses = boom
        expect(() => jest.advanceTimersByTime(5001)).not.toThrow()
        logged(logger, 'checkNetwork')
    })

    test('startWatcher logs when listing addresses throws', () => {
        feature.listAddresses = boom
        expect(() => feature.startWatcher()).not.toThrow()
        logged(logger, 'startWatcher')
    })

    test('powerMonitor listeners cannot throw into the main process', () => {
        const handlers = {}
        electron.powerMonitor = { on: (name, cb) => { handlers[name] = cb }, removeListener: jest.fn() }
        feature.listAddresses = () => []
        feature.startWatcher()
        electron.app.incyclistApp = { getMainWindow: () => ({ win: { webContents: { send: boom } } }) }
        expect(() => handlers.resume()).not.toThrow()
        expect(() => handlers['unlock-screen']()).not.toThrow()
        electron.powerMonitor.removeListener = boom
        expect(() => feature.stopWatcher()).not.toThrow()
        logged(logger, 'stopWatcher')
    })

    test('watchRenderer and the webContents listeners do not throw', () => {
        const handlers = {}
        const contents = { on: (name, cb) => { handlers[name] = cb } }
        const win = { webContents: contents, once: (name, cb) => { handlers[name] = cb } }
        electron.app.incyclistApp = { getMainWindow: () => ({ win }) }
        feature.control.closeAll = boom
        expect(() => feature.watchRenderer()).not.toThrow()
        expect(() => handlers['render-process-gone']()).not.toThrow()
        expect(() => handlers.destroyed()).not.toThrow()
        expect(() => handlers.closed()).not.toThrow()
        logged(logger, 'onRendererGone')

        electron.app.incyclistApp = { getMainWindow: boom }
        expect(() => feature.watchRenderer()).not.toThrow()
    })

    test('shutdown (quit hook) never rejects', async () => {
        feature.control.stop = rejects
        feature.media.stop = rejects
        feature.peerFilter.dispose = boom
        await expect(feature.shutdown()).resolves.toBeUndefined()
        logged(logger, 'shutdown')
    })

    test('register and registerRenderer do not throw', () => {
        electron.ipcMain.on.mockImplementationOnce(boom)
        expect(() => feature.register({})).not.toThrow()
        logged(logger, 'register')
        expect(() => feature.registerRenderer({}, { on: jest.fn(), send: jest.fn(), once: jest.fn() })).not.toThrow()
        logged(logger, 'registerRenderer')
    })
})

describe('ControlServer', () => {
    let logger
    let emit
    let server
    let peerFilter

    beforeEach(() => {
        logger = { logEvent: jest.fn() }
        emit = jest.fn()
        peerFilter = { guard: jest.fn(() => true) }
        server = new ControlServer({ emit, peerFilter, logger, requestLogger: logger })
    })

    test('start resolves ok:false when the server cannot be created', async () => {
        jest.spyOn(net, 'createServer').mockImplementation(boom)
        await expect(server.start({ port: 0 })).resolves.toMatchObject({ ok: false })
        logged(logger, 'start.listen')
    })

    test('stop resolves when close throws', async () => {
        server.server = { close: boom }
        await expect(server.stop()).resolves.toBeUndefined()
        logged(logger, 'stop.close')
    })

    test('getters fall back', () => {
        server.server = { get listening() { throw new Error('boom') } }
        expect(server.isRunning()).toBe(false)
        server.established = { get size() { throw new Error('boom') } }
        expect(server.getConnectionCount()).toBe(0)
    })

    test('a throwing peer filter destroys the socket', () => {
        peerFilter.guard.mockImplementation(boom)
        const socket = makeSocket()
        expect(() => server.onConnection(socket)).not.toThrow()
        expect(socket.destroy).toHaveBeenCalled()
        logged(logger, 'onConnection')
    })

    test('a failing write in the data handler destroys the connection without throwing', () => {
        const socket = makeSocket({ write: boom })
        server.onConnection(socket)
        const preamble = Buffer.concat([Buffer.from('INCYLINK', 'ascii'), Buffer.from([1])])
        expect(() => socket.emit('data', preamble)).not.toThrow()
        expect(socket.destroy).toHaveBeenCalled()
        logged(logger, 'processPreamble')
    })

    test('a throwing consumer cannot break the frame loop', () => {
        emit.mockImplementation(boom)
        const socket = makeSocket()
        server.onConnection(socket)
        const body = Buffer.from('{}')
        const header = Buffer.alloc(4)
        header.writeUInt32BE(body.length)
        const preamble = Buffer.concat([Buffer.from('INCYLINK', 'ascii'), Buffer.from([1])])
        expect(() => socket.emit('data', Buffer.concat([preamble, header, body]))).not.toThrow()
        expect(logger.logEvent).toHaveBeenCalledWith(expect.objectContaining({ message: 'local-link control emit failed' }))
    })

    test('send returns false when the socket write throws', () => {
        const socket = makeSocket()
        server.onConnection(socket)
        socket.emit('data', Buffer.concat([Buffer.from('INCYLINK', 'ascii'), Buffer.from([1])]))
        const id = [...server.established.keys()][0]
        socket.write = boom
        expect(server.send(id, '{}')).toBe(false)
        logged(logger, 'send')
    })

    test('close and the timers survive a throwing socket', () => {
        jest.useFakeTimers()
        const socket = makeSocket({ destroy: boom, end: boom })
        server.onConnection(socket)
        socket.emit('data', Buffer.concat([Buffer.from('INCYLINK', 'ascii'), Buffer.from([1])]))
        const id = [...server.established.keys()][0]
        expect(() => server.close(id, 'bye')).not.toThrow()
        expect(() => jest.advanceTimersByTime(120000)).not.toThrow()
        expect(() => server.closeAll('x')).not.toThrow()
        logged(logger, 'endConnection')
    })

    test('closing handlers and setLimits do not throw', () => {
        const socket = makeSocket()
        server.onConnection(socket)
        server.peerCounts = null
        expect(() => socket.emit('close')).not.toThrow()
        logged(logger, 'onClosed')
        server.resolveLimits = boom
        expect(() => server.setLimits({})).not.toThrow()
    })
})

describe('MediaServer', () => {
    let logger
    let server
    let peerFilter

    beforeEach(() => {
        logger = { logEvent: jest.fn() }
        peerFilter = { guard: jest.fn(() => true) }
        server = new MediaServer({ emit: jest.fn(), peerFilter, logger, requestLogger: logger })
    })

    test('start resolves ok:false when the server cannot be created', async () => {
        jest.spyOn(http, 'createServer').mockImplementation(boom)
        await expect(server.start({ port: 0 })).resolves.toMatchObject({ ok: false })
        logged(logger, 'start.listen')
    })

    test('stop resolves when close and the sockets throw', async () => {
        server.netServer = { close: boom }
        server.sockets.add({ destroy: boom })
        server.active.add({ abort: boom })
        await expect(server.stop()).resolves.toBeUndefined()
        logged(logger, 'stop.close')
    })

    test('publish returns ok:false when the input throws', () => {
        const input = { get documents() { throw new Error('boom') } }
        expect(server.publish(input)).toEqual({ ok: false, rejectedHandles: [], rejectedTokens: 0 })
        logged(logger, 'publish')
    })

    test('getStats and setLimits fall back', () => {
        server.state = { get handles() { throw new Error('boom') } }
        expect(server.getStats()).toEqual({ handleCount: 0, tokenCount: 0 })
        server.resolveLimits = boom
        expect(() => server.setLimits({})).not.toThrow()
    })

    test('a throwing peer filter destroys the socket', () => {
        peerFilter.guard.mockImplementation(boom)
        const socket = makeSocket()
        expect(() => server.onConnection(socket)).not.toThrow()
        expect(socket.destroy).toHaveBeenCalled()
        logged(logger, 'onConnection')
    })

    test('onRequest never rejects when the request is unreadable and the response is broken', async () => {
        const req = { get headers() { throw new Error('boom') }, get url() { throw new Error('boom') }, socket: undefined }
        const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writeHead: boom, end: boom, destroy: jest.fn() })
        await expect(server.onRequest(req, res)).resolves.toBeUndefined()
        expect(res.destroy).toHaveBeenCalled()
        expect(logger.logEvent).toHaveBeenCalledWith(expect.objectContaining({ error: 'boom' }))
    })

    test('the response close handler does not throw', async () => {
        const socket = makeSocket({ setTimeout: boom })
        const req = { headers: {}, url: '/x', method: 'GET', socket }
        const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writeHead: jest.fn(), end: jest.fn(() => res.emit('close')), destroy: jest.fn() })
        socket.setTimeout = jest.fn()
        await server.onRequest(req, res)
        socket.setTimeout = boom
        expect(() => res.emit('close')).not.toThrow()
    })

    test('timers and socket handlers survive a throwing socket', () => {
        jest.useFakeTimers()
        const socket = makeSocket({ destroy: boom })
        server.httpServer = { emit: jest.fn() }
        server.onConnection(socket)
        expect(() => socket.emit('timeout')).not.toThrow()
        expect(() => jest.advanceTimersByTime(20000)).not.toThrow()
        expect(() => socket.emit('close')).not.toThrow()
        logged(logger, 'onConnection.timeout')
    })
})

describe('PeerFilter', () => {
    let logger
    let filter

    beforeEach(() => {
        logger = { logEvent: jest.fn() }
        filter = new PeerFilter({ logger })
    })

    test('guard refuses and destroys when the address cannot be read', () => {
        const socket = makeSocket()
        Object.defineProperty(socket, 'remoteAddress', { get: boom })
        expect(filter.guard('control', socket)).toBe(false)
        expect(socket.destroy).toHaveBeenCalled()
        logged(logger, 'guard')
    })

    test('isAllowed refuses and setPolicy fails closed when the policy is corrupt', () => {
        filter.policy = null
        expect(filter.isAllowed('10.0.0.1')).toBe(false)
        logged(logger, 'isAllowed')
        expect(filter.setPolicy({ get defaultPrivate() { throw new Error('boom') } })).toEqual({ ok: false, error: 'invalid policy' })
        logged(logger, 'setPolicy')
    })

    test('flush delivers the other aggregates when onRefused throws', () => {
        const onRefused = jest.fn().mockImplementationOnce(boom)
        const f = new PeerFilter({ logger, onRefused })
        f.record('control', 'public-v4')
        f.record('media', 'public-v6')
        expect(() => f.flush()).not.toThrow()
        expect(onRefused).toHaveBeenCalledTimes(2)
        logged(logger, 'flush.onRefused')
        f.dispose()
    })

    test('the flush timer does not throw', () => {
        jest.useFakeTimers()
        filter.onRefused = boom
        filter.record('control', 'public-v4')
        expect(() => jest.advanceTimersByTime(10001)).not.toThrow()
    })
})

describe('network', () => {
    test('listLocalAddresses returns [] when the OS call throws', () => {
        jest.spyOn(os, 'networkInterfaces').mockImplementation(boom)
        expect(listLocalAddresses()).toEqual([])
    })
})

describe('ipcSubscribe (renderer side)', () => {
    let log

    beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}) })

    test('a throwing listener does not propagate', () => {
        let handler
        const ipcRenderer = { on: (_e, h) => { handler = h }, removeListener: jest.fn() }
        ipcSubscribe('chan', ipcRenderer)(boom)
        expect(() => handler({}, 1, 2)).not.toThrow()
        expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
    })

    test('subscribing on a broken ipcRenderer returns a no-op unsubscribe', () => {
        const off = ipcSubscribe('chan', { on: boom })(() => {})
        expect(() => off()).not.toThrow()
    })

    test('a throwing removeListener does not propagate', () => {
        const off = ipcSubscribe('chan', { on: jest.fn(), removeListener: boom })(() => {})
        expect(() => off()).not.toThrow()
    })

    test('a missing ipcRenderer yields a no-op', () => {
        expect(() => ipcSubscribe('chan', undefined)(() => {})()).not.toThrow()
    })
})
