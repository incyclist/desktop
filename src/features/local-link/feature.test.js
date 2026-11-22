jest.mock('electron', () => ({
    ipcMain: { on: jest.fn() },
    app: { incyclistApp: undefined },
}))

const mockInstances = []
let mockPublishError
jest.mock('bonjour-service', () => {
    const { EventEmitter } = require('node:events')
    class Bonjour {
        constructor() {
            this.published = []
            this.destroyed = false
            this.publish = jest.fn(config => {
                if (mockPublishError)
                    throw mockPublishError
                const service = new EventEmitter()
                service.config = config
                this.published.push(service)
                return service
            })
            this.destroy = jest.fn(() => { this.destroyed = true })
            mockInstances.push(this)
        }
    }
    return { Bonjour }
})

const net = require('node:net')
const { EventEmitter } = require('node:events')
const crypto = require('node:crypto')
const electron = require('electron')
const LocalLinkFeature = require('./feature')

describe('LocalLinkFeature', () => {
    let feature

    beforeEach(() => {
        feature = new LocalLinkFeature()
        feature.emitEvent = jest.fn()
        feature.media.emit = feature.emitEvent
    })

    afterEach(async () => {
        await feature.stop()
        mockPublishError = undefined
        mockInstances.length = 0
        delete electron.powerMonitor
        electron.app.incyclistApp = undefined
    })

    test('is a singleton', () => {
        expect(LocalLinkFeature.getInstance()).toBe(LocalLinkFeature.getInstance())
    })

    test('getCapabilities reports transport version 1', async () => {
        const caps = await feature.getCapabilities()
        expect(caps.transportVersion).toBe(1)
        expect(caps.capabilities).toEqual(expect.arrayContaining(['http-media', 'range', 'peer-filter']))
    })

    test('start/getStatus/stop for the media listener', async () => {
        const res = await feature.start({ media: { port: 0, host: '127.0.0.1' } })
        expect(res.media.ok).toBe(true)
        expect(res.control).toBeUndefined()
        expect(Array.isArray(res.addresses)).toBe(true)

        const again = await feature.start({ media: { port: 0, host: '127.0.0.1' } })
        expect(again.media).toMatchObject({ ok: true, alreadyRunning: true, port: res.media.port })

        let status = await feature.getStatus()
        expect(status.running).toEqual({ control: false, media: true })
        expect(status.ports.media).toBe(res.media.port)
        expect(status.announced).toBeNull()

        expect(await feature.stop({ listener: 'media' })).toEqual({ ok: true })
        status = await feature.getStatus()
        expect(status.running.media).toBe(false)
    })

    test('start without a media request does not start it', async () => {
        await feature.start({})
        expect((await feature.getStatus()).running.media).toBe(false)
    })

    test('publishMedia is reflected in the status counts', async () => {
        const digest = crypto.createHash('sha256').update('t').digest('base64url')
        const res = await feature.publishMedia({ documents: {}, handles: [{ handle: 'h1', path: '/tmp/x.mp4' }], tokens: [{ digest, id: 'a' }] })
        expect(res).toEqual({ ok: true, rejectedHandles: [], rejectedTokens: 0 })
        const status = await feature.getStatus()
        expect(status.handleCount).toBe(1)
        expect(status.tokenCount).toBe(1)
    })

    test('setPeerPolicy validates', async () => {
        expect((await feature.setPeerPolicy({ defaultPrivate: true, allow: ['100.64.0.0/10'] })).ok).toBe(true)
        expect((await feature.setPeerPolicy({ defaultPrivate: true, allow: ['nope'] })).ok).toBe(false)
    })

    describe('control listener', () => {
        test('start reports control and media independently, with real ports in the status', async () => {
            const res = await feature.start({ control: { port: 0, host: '127.0.0.1' }, media: { port: 0, host: '127.0.0.1' } })
            expect(res.control.ok).toBe(true)
            expect(res.media.ok).toBe(true)

            const status = await feature.getStatus()
            expect(status.running).toEqual({ control: true, media: true })
            expect(status.ports).toEqual({ control: res.control.port, media: res.media.port })
            expect(status.connections).toBe(0)
        })

        test('an EADDRINUSE on control does not hide the media result', async () => {
            const blocker = net.createServer()
            await new Promise(r => blocker.listen(0, '127.0.0.1', r))
            try {
                const res = await feature.start({
                    control: { port: blocker.address().port, host: '127.0.0.1' }, media: { port: 0, host: '127.0.0.1' }
                })
                expect(res.control).toEqual({ ok: false, error: { code: 'EADDRINUSE' } })
                expect(res.media.ok).toBe(true)
            }
            finally {
                blocker.close()
            }
        })

        test('send and close go to the control connections', async () => {
            const { control } = await feature.start({ control: { port: 0, host: '127.0.0.1' } })
            const socket = net.connect(control.port, '127.0.0.1')
            let data = Buffer.alloc(0)
            socket.on('data', d => { data = Buffer.concat([data, d]) })
            socket.write(Buffer.concat([Buffer.from('INCYLINK'), Buffer.from([1])]))
            await new Promise(r => socket.once('data', r))

            const connection = feature.emitEvent.mock.calls.map(c => c[0]).find(e => e.type === 'connection')
            expect(await feature.send(connection.connectionId, '{"t":"x"}')).toEqual({ ok: true })
            expect(await feature.send('unknown', '{}')).toEqual({ ok: false })
            expect((await feature.getStatus()).connections).toBe(1)

            await feature.close(connection.connectionId, 'bye')
            await new Promise(r => socket.once('close', r))
            expect(data.length).toBeGreaterThan(9)
        })

        test('setLimits applies per listener and clamps to the ceilings', async () => {
            const res = await feature.setLimits({ control: { maxConnections: 999, maxFrameBytes: 2048 }, media: { maxPerPeer: 999 } })
            expect(res.ok).toBe(true)
            expect(res.applied.control).toMatchObject({ maxConnections: 64, maxFrameBytes: 2048 })
            expect(res.applied.media.maxPerPeer).toBe(64)
            expect((await feature.setLimits({})).applied).toEqual({})
        })

        test('capabilities include the control and network names', async () => {
            const caps = await feature.getCapabilities()
            expect(caps.capabilities).toEqual(expect.arrayContaining(['tcp-control', 'reannounce', 'network-watch']))
        })
    })

    describe('renderer lifetime', () => {
        async function connectedClient() {
            const { control } = await feature.start({ control: { port: 0, host: '127.0.0.1' } })
            const socket = net.connect(control.port, '127.0.0.1')
            socket.on('error', () => { /* closed by the server */ })
            socket.write(Buffer.concat([Buffer.from('INCYLINK'), Buffer.from([1])]))
            await new Promise(r => socket.once('data', r))
            return socket
        }
        const closedEvents = () => feature.emitEvent.mock.calls.map(c => c[0]).filter(e => e.type === 'connection-closed')

        test('onRendererGone closes all control connections but keeps the listener', async () => {
            const socket = await connectedClient()
            feature.onRendererGone()
            await new Promise(r => socket.once('close', r))
            expect(closedEvents()).toEqual([expect.objectContaining({ reason: 'renderer-gone' })])
            expect((await feature.getStatus()).running.control).toBe(true)
        })

        test('a main-frame navigation of the main window triggers the close', async () => {
            const contents = new EventEmitter()
            const win = new EventEmitter()
            win.webContents = contents
            electron.app.incyclistApp = { getMainWindow: () => ({ win }) }

            const socket = await connectedClient()
            contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
            contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
            expect(closedEvents()).toHaveLength(0)

            contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
            await new Promise(r => socket.once('close', r))
            expect(closedEvents()[0].reason).toBe('renderer-gone')
        })

        test('render process crash and window close trigger the close', async () => {
            const contents = new EventEmitter()
            const win = new EventEmitter()
            win.webContents = contents
            electron.app.incyclistApp = { getMainWindow: () => ({ win }) }
            const spy = jest.spyOn(feature, 'onRendererGone')

            await connectedClient()
            contents.emit('render-process-gone')
            win.emit('closed')
            expect(spy).toHaveBeenCalledTimes(2)
        })

        test('the webContents is watched only once', async () => {
            const contents = new EventEmitter()
            electron.app.incyclistApp = { getMainWindow: () => ({ win: { webContents: contents } }) }
            feature.watchRenderer()
            feature.watchRenderer()
            expect(contents.listenerCount('did-start-navigation')).toBe(1)
        })

        test('a missing main window is tolerated', () => {
            electron.app.incyclistApp = { getMainWindow: () => { throw new Error('no window') } }
            expect(() => feature.watchRenderer()).not.toThrow()
        })

        test('the quit hook closes everything with plain close/destroy', async () => {
            const socket = await connectedClient()
            await feature.start({ media: { port: 0, host: '127.0.0.1' } })
            await feature.announce({ instanceName: 'PC', hostLabel: 'incyclist-ab12' })

            await feature.shutdown()
            await new Promise(r => socket.once('close', r))
            const status = await feature.getStatus()
            expect(status.running).toEqual({ control: false, media: false })
            expect(status.announced).toBeNull()
            expect(mockInstances.every(b => b.destroyed)).toBe(true)
        })
    })

    describe('mDNS', () => {
        const valid = { instanceName: 'Office PC (a1b2)', hostLabel: 'incyclist-a1b2c3d4' }

        beforeEach(async () => {
            await feature.start({ control: { port: 0, host: '127.0.0.1' } })
        })

        test('publishes _incyclist._tcp on the control port with the given host label', async () => {
            const res = await feature.announce(valid)
            expect(res).toEqual({ ok: true })

            const bonjour = mockInstances[0]
            const port = (await feature.getStatus()).ports.control
            expect(bonjour.publish).toHaveBeenCalledWith({
                name: 'Office PC (a1b2)', type: 'incyclist', protocol: 'tcp', port, host: 'incyclist-a1b2c3d4.local'
            })

            bonjour.published[0].emit('up')
            expect(feature.emitEvent).toHaveBeenCalledWith({ type: 'announced', instanceName: 'Office PC (a1b2)' })
            expect((await feature.getStatus()).announced).toEqual({ instanceName: 'Office PC (a1b2)' })
        })

        test('an explicit port overrides the control port', async () => {
            await feature.announce({ ...valid, port: 4711 })
            expect(mockInstances[0].publish.mock.calls[0][0].port).toBe(4711)
        })

        test.each([
            ['empty name', { ...valid, instanceName: '' }],
            ['non-string name', { ...valid, instanceName: 5 }],
            ['name over 63 bytes', { ...valid, instanceName: 'x'.repeat(64) }],
            ['name over 63 bytes in UTF-8', { ...valid, instanceName: '\u00fc'.repeat(32) }],
            ['control character in name', { ...valid, instanceName: 'a\nb' }],
            ['host label with a dot', { ...valid, hostLabel: 'a.b' }],
            ['host label with a space', { ...valid, hostLabel: 'a b' }],
            ['empty host label', { ...valid, hostLabel: '' }],
            ['missing host label', { instanceName: 'PC' }],
            ['host label over 63 chars', { ...valid, hostLabel: 'a'.repeat(64) }],
            ['invalid port', { ...valid, port: 70000 }],
        ])('rejects %s', async (_n, input) => {
            const res = await feature.announce(input)
            expect(res.ok).toBe(false)
            expect(res.error).toEqual(expect.any(String))
            expect(mockInstances).toHaveLength(0)
        })

        test('accepts a 63-byte name', async () => {
            expect((await feature.announce({ ...valid, instanceName: 'x'.repeat(63) })).ok).toBe(true)
        })

        test('fails without a running control listener and no explicit port', async () => {
            await feature.stop({ listener: 'control' })
            expect((await feature.announce(valid)).ok).toBe(false)
        })

        test('announce(null) withdraws', async () => {
            await feature.announce(valid)
            expect(await feature.announce(null)).toEqual({ ok: true })
            expect(mockInstances[0].destroyed).toBe(true)
            expect((await feature.getStatus()).announced).toBeNull()
        })

        test('a new announcement replaces the previous one', async () => {
            await feature.announce(valid)
            await feature.announce({ ...valid, instanceName: 'Other (zz99)' })
            expect(mockInstances).toHaveLength(2)
            expect(mockInstances[0].destroyed).toBe(true)
            expect((await feature.getStatus()).announced.instanceName).toBe('Other (zz99)')
        })

        test('reannounce destroys, recreates and republishes the same announcement', async () => {
            await feature.announce(valid)
            expect(await feature.reannounce()).toEqual({ ok: true })

            expect(mockInstances).toHaveLength(2)
            expect(mockInstances[0].destroyed).toBe(true)
            expect(mockInstances[1].destroyed).toBe(false)
            expect(mockInstances[1].publish.mock.calls[0][0]).toEqual(mockInstances[0].publish.mock.calls[0][0])
        })

        test('reannounce without an announcement does nothing', async () => {
            expect(await feature.reannounce()).toEqual({ ok: false })
            expect(mockInstances).toHaveLength(0)
        })

        test('a late up event of a replaced service is ignored', async () => {
            await feature.announce(valid)
            const old = mockInstances[0].published[0]
            await feature.reannounce()
            feature.emitEvent.mockClear()
            old.emit('up')
            old.emit('error', { code: 'X' })
            expect(feature.emitEvent).not.toHaveBeenCalled()
        })

        test('service errors become announce-error events', async () => {
            await feature.announce(valid)
            mockInstances[0].published[0].emit('error', Object.assign(new Error('x'), { code: 'EFAIL' }))
            expect(feature.emitEvent).toHaveBeenCalledWith({ type: 'announce-error', code: 'EFAIL' })
        })

        test('a throwing publish is reported and leaves nothing announced', async () => {
            mockPublishError = Object.assign(new Error('boom'), { code: 'EBOOM' })
            try {
                const res = await feature.announce(valid)
                expect(res).toEqual({ ok: false, error: 'EBOOM' })
            }
            finally {
                mockPublishError = undefined
            }
            expect(feature.emitEvent).toHaveBeenCalledWith({ type: 'announce-error', code: 'EBOOM' })
            expect((await feature.getStatus()).announced).toBeNull()
            expect(mockInstances.every(b => b.destroyed)).toBe(true)
        })

        test('stopping the control listener withdraws the announcement', async () => {
            await feature.announce(valid)
            await feature.stop({ listener: 'control' })
            expect(mockInstances[0].destroyed).toBe(true)
            expect((await feature.getStatus()).announced).toBeNull()
        })
    })

    describe('network watcher', () => {
        const addr = (address, extra = {}) => ({ address, family: 'IPv4', interface: 'eth0', internal: false, private: true, ...extra })
        const lo = addr('127.0.0.1', { interface: 'lo', internal: true })
        const networkEvents = () => feature.emitEvent.mock.calls.map(c => c[0]).filter(e => e.type === 'network-changed')

        test('emits network-changed only when the set of non-internal addresses differs', () => {
            let current = [lo, addr('192.168.1.10')]
            feature.listAddresses = () => current
            feature.startWatcher()

            feature.checkNetwork()
            expect(networkEvents()).toHaveLength(0)

            current = [lo, addr('192.168.1.10')]
            feature.checkNetwork()
            expect(networkEvents()).toHaveLength(0)

            current = [lo, addr('192.168.7.20')]
            feature.checkNetwork()
            expect(networkEvents()).toEqual([{ type: 'network-changed', addresses: current }])

            feature.checkNetwork()
            expect(networkEvents()).toHaveLength(1)

            current = [lo]
            feature.checkNetwork()
            expect(networkEvents()).toHaveLength(2)
        })

        test('polls every 5 seconds while a listener is running', async () => {
            jest.useFakeTimers()
            try {
                let current = [addr('10.0.0.5')]
                feature.listAddresses = () => current
                await feature.start({ media: { port: 0, host: '127.0.0.1' } })

                current = [addr('10.0.0.6')]
                jest.advanceTimersByTime(4999)
                expect(networkEvents()).toHaveLength(0)
                jest.advanceTimersByTime(2)
                expect(networkEvents()).toHaveLength(1)

                await feature.stop()
                current = [addr('10.0.0.7')]
                jest.advanceTimersByTime(20000)
                expect(networkEvents()).toHaveLength(1)
            }
            finally {
                jest.useRealTimers()
            }
        })

        test('powerMonitor resume and unlock-screen emit resumed; stop removes the listeners', () => {
            electron.powerMonitor = new EventEmitter()
            feature.listAddresses = () => []
            feature.startWatcher()

            electron.powerMonitor.emit('resume')
            electron.powerMonitor.emit('unlock-screen')
            const resumed = feature.emitEvent.mock.calls.map(c => c[0]).filter(e => e.type === 'resumed')
            expect(resumed).toHaveLength(2)

            feature.stopWatcher()
            expect(electron.powerMonitor.listenerCount('resume')).toBe(0)
            expect(electron.powerMonitor.listenerCount('unlock-screen')).toBe(0)
        })

        test('works without a powerMonitor', () => {
            feature.startWatcher()
            expect(() => feature.stopWatcher()).not.toThrow()
        })
    })
})
