const net = require('node:net')
const { ControlServer } = require('./control-server')
const { PeerFilter } = require('./peer-filter')

const MAGIC = Buffer.from('INCYLINK', 'ascii')
const preamble = (v = 1) => Buffer.concat([MAGIC, Buffer.from([v])])
const frame = (text) => {
    const body = Buffer.from(text, 'utf8')
    const h = Buffer.alloc(4)
    h.writeUInt32BE(body.length)
    return Buffer.concat([h, body])
}
const wait = (ms) => new Promise(r => setTimeout(r, ms))

async function until(fn, ms = 2000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (fn())
            return
        await wait(5)
    }
    throw new Error('condition not met in time')
}

describe('ControlServer', () => {
    let server, events, sockets, peerFilter

    const ofType = (type) => events.filter(e => e.type === type)

    beforeEach(async () => {
        // late events of a previous test's server must not leak into this test's array
        const mine = []
        events = mine
        sockets = []
        peerFilter = new PeerFilter({ onRefused: (l, c, n) => mine.push({ type: 'peer-refused', listener: l, addressClass: c, count: n }) })
        server = new ControlServer({ emit: e => mine.push(e), peerFilter })
    })

    afterEach(async () => {
        sockets.forEach(s => s.destroy())
        await server.stop()
        peerFilter.dispose()
    })

    async function startServer(limits) {
        if (limits)
            server.setLimits(limits)
        const res = await server.start({ port: 0, host: '127.0.0.1' })
        expect(res.ok).toBe(true)
        return res.port
    }

    async function connect(port) {
        const socket = net.connect({ port, host: '127.0.0.1' })
        const received = { data: Buffer.alloc(0), closed: false }
        socket.on('data', d => { received.data = Buffer.concat([received.data, d]) })
        socket.on('close', () => { received.closed = true })
        socket.on('error', () => { /* checked via closed */ })
        await new Promise(r => socket.once('connect', r))
        sockets.push(socket)
        return { socket, received }
    }

    async function handshake(port) {
        const c = await connect(port)
        c.socket.write(preamble())
        await until(() => ofType('connection').length > 0 && c.received.data.length >= 9)
        return c
    }

    test('echoes the accepted version and emits a connection event', async () => {
        const port = await startServer()
        const { socket, received } = await connect(port)
        socket.write(preamble(1))
        await until(() => received.data.length >= 9)
        expect(received.data.equals(preamble(1))).toBe(true)

        const [conn] = ofType('connection')
        expect(conn.connectionId).toMatch(/^[0-9a-f]{16}$/)
        expect(conn.peer.address).toBeDefined()
        expect(server.getConnectionCount()).toBe(1)
    })

    test('answers a higher requested version with the highest supported one', async () => {
        const port = await startServer()
        const { socket, received } = await connect(port)
        socket.write(preamble(7))
        await until(() => received.data.length >= 9)
        expect(received.data[8]).toBe(1)
    })

    test('refuses version 0', async () => {
        const port = await startServer()
        const { socket, received } = await connect(port)
        socket.write(preamble(0))
        await until(() => received.closed)
        expect(ofType('connection')).toHaveLength(0)
    })

    test('reassembles a preamble and frames split over several chunks', async () => {
        const port = await startServer()
        const { socket, received } = await connect(port)
        const bytes = Buffer.concat([preamble(), frame('{"t":"hello"}')])
        for (let i = 0; i < bytes.length; i++) {
            socket.write(bytes.subarray(i, i + 1))
            await wait(1)
        }
        await until(() => ofType('frame').length === 1)
        expect(ofType('frame')[0].payload).toBe('{"t":"hello"}')
        expect(received.closed).toBe(false)
    })

    test('splits merged chunks into frames, relayed unparsed', async () => {
        const port = await startServer()
        const { socket } = await connect(port)
        socket.write(Buffer.concat([preamble(), frame('a'), frame('not json {'), frame('ü')]))
        await until(() => ofType('frame').length === 3)
        expect(ofType('frame').map(f => f.payload)).toEqual(['a', 'not json {', 'ü'])
    })

    test('closes on a frame over the size limit', async () => {
        const port = await startServer({ maxFrameBytes: 16 })
        const { socket, received } = await connect(port)
        socket.write(Buffer.concat([preamble(), frame('x'.repeat(17))]))
        await until(() => received.closed)
        expect(ofType('frame')).toHaveLength(0)
        await until(() => ofType('connection-closed').length === 1)
        expect(ofType('connection-closed')[0].reason).toBe('frame-too-large')
    })

    test('rejects an oversize announcement before the body arrives', async () => {
        const port = await startServer({ maxFrameBytes: 16 })
        const { socket, received } = await connect(port)
        const header = Buffer.alloc(4)
        header.writeUInt32BE(1000)
        socket.write(Buffer.concat([preamble(), header]))
        await until(() => received.closed)
    })

    test('default inbound frame cap is 16 KB', async () => {
        expect(server.setLimits({}).maxFrameBytes).toBe(16384)
        const port = await startServer()
        const { socket, received } = await connect(port)
        const header = Buffer.alloc(4)
        header.writeUInt32BE(16385)
        socket.write(Buffer.concat([preamble(), header]))
        await until(() => received.closed)
        expect(ofType('frame')).toHaveLength(0)
    })

    test('a frame at the default cap is accepted', async () => {
        const port = await startServer()
        const { socket } = await handshake(port)
        socket.write(frame('x'.repeat(16384)))
        await until(() => ofType('frame').length === 1)
    })

    test('an emit that throws does not escape the network handlers', async () => {
        const logs = []
        const throwing = new ControlServer({
            emit: () => { throw new Error('Object has been destroyed') },
            peerFilter, logger: { logEvent: e => logs.push(e) }
        })
        const res = await throwing.start({ port: 0, host: '127.0.0.1' })
        const uncaught = jest.fn()
        process.on('uncaughtException', uncaught)
        try {
            const socket = net.connect({ port: res.port, host: '127.0.0.1' })
            socket.on('error', () => { /* ignore */ })
            sockets.push(socket)
            await new Promise(r => socket.once('connect', r))
            socket.write(Buffer.concat([preamble(), frame('hello')]))
            await wait(100)
            socket.destroy()
            await wait(100)
            expect(uncaught).not.toHaveBeenCalled()
            expect(logs.some(l => l.message === 'local-link control emit failed')).toBe(true)
            expect(JSON.stringify(logs)).not.toContain('127.0.0.1')
            expect(JSON.stringify(logs)).not.toContain('hello')
        }
        finally {
            process.off('uncaughtException', uncaught)
            await throwing.stop()
        }
    })

    test('per-peer count keys on the /64 for IPv6 peers', () => {
        const mk = (address) => {
            const handlers = {}
            return {
                remoteAddress: address, remotePort: 1, destroy: jest.fn(),
                setNoDelay: jest.fn(), on: (e, f) => { handlers[e] = f }, once: (e, f) => { handlers[e] = f }
            }
        }
        const open = new PeerFilter()
        const srv = new ControlServer({ emit: () => { /* unused */ }, peerFilter: open })
        srv.setLimits({ maxPerPeer: 2 })
        const a = mk('fe80::1'), b = mk('fe80::2'), c = mk('fe80::3'), other = mk('fe80:0:0:1::1')
        for (const s of [a, b, c, other])
            srv.onConnection(s)
        expect(c.destroy).toHaveBeenCalled()
        expect(a.destroy).not.toHaveBeenCalled()
        expect(b.destroy).not.toHaveBeenCalled()
        expect(other.destroy).not.toHaveBeenCalled()
        srv.closeAll('test')
        open.dispose()
    })

    test('clamps limits to the hard ceilings', () => {
        const applied = server.setLimits({
            maxConnections: 1e6, maxPerPeer: 1e6, preambleTimeoutMs: 1e9, idleTimeoutMs: 1e9,
            maxFrameBytes: 1e9, maxFramesPerSec: 1e6
        })
        expect(applied).toEqual({
            maxConnections: 64, maxPerPeer: 16, preambleTimeoutMs: 30000, idleTimeoutMs: 600000,
            maxFrameBytes: 1048576, maxFramesPerSec: 200
        })
        expect(server.setLimits({}).maxConnections).toBe(16)
        expect(server.setLimits({ maxConnections: -3 }).maxConnections).toBe(16)
    })

    test('closes a connection with a wrong preamble, without any bytes sent back', async () => {
        const port = await startServer()
        const { socket, received } = await connect(port)
        socket.write(Buffer.from('GET / HTTP/1.1\r\n\r\n'))
        await until(() => received.closed)
        expect(received.data.length).toBe(0)
        expect(ofType('connection')).toHaveLength(0)
    })

    test('closes on a wrong preamble prefix without waiting for all bytes', async () => {
        const port = await startServer()
        const { socket, received } = await connect(port)
        socket.write(Buffer.from('INCX'))
        await until(() => received.closed)
    })

    test('closes when the preamble does not complete in time', async () => {
        const port = await startServer({ preambleTimeoutMs: 80 })
        const { socket, received } = await connect(port)
        socket.write(Buffer.from('INCY'))
        await until(() => received.closed)
        expect(ofType('connection')).toHaveLength(0)
    })

    test('closes an idle connection', async () => {
        const port = await startServer({ idleTimeoutMs: 100 })
        await handshake(port)
        await until(() => ofType('connection-closed').length === 1)
        expect(ofType('connection-closed')[0].reason).toBe('idle-timeout')
    })

    test('inbound frames keep a connection alive', async () => {
        const port = await startServer({ idleTimeoutMs: 150 })
        const { socket, received } = await handshake(port)
        for (let i = 0; i < 4; i++) {
            await wait(60)
            socket.write(frame('ping'))
        }
        expect(received.closed).toBe(false)
    })

    test('closes a connection exceeding the frame rate', async () => {
        const port = await startServer({ maxFramesPerSec: 3 })
        const { socket, received } = await connect(port)
        socket.write(Buffer.concat([preamble(), ...[1, 2, 3, 4, 5].map(i => frame(`f${i}`))]))
        await until(() => received.closed)
        expect(ofType('frame')).toHaveLength(3)
        await until(() => ofType('connection-closed').length === 1)
        expect(ofType('connection-closed')[0].reason).toBe('rate-limited')
    })

    test('limits connections per peer', async () => {
        const port = await startServer({ maxPerPeer: 2 })
        await handshake(port)
        const c2 = await connect(port)
        c2.socket.write(preamble())
        await until(() => c2.received.data.length >= 9)
        const c3 = await connect(port)
        await until(() => c3.received.closed)
        expect(server.getConnectionCount()).toBe(2)
    })

    test('limits total connections', async () => {
        const port = await startServer({ maxConnections: 1, maxPerPeer: 4 })
        await handshake(port)
        const c2 = await connect(port)
        await until(() => c2.received.closed)
        expect(server.getConnectionCount()).toBe(1)
    })

    test('releases the per-peer slot when a connection closes', async () => {
        const port = await startServer({ maxPerPeer: 1 })
        const first = await handshake(port)
        first.socket.destroy()
        await until(() => server.getConnectionCount() === 0)
        const second = await connect(port)
        second.socket.write(preamble())
        await until(() => second.received.data.length >= 9)
    })

    test('applies the peer filter to the control listener first', async () => {
        peerFilter.setPolicy({ defaultPrivate: true, deny: ['127.0.0.0/8'] })
        const port = await startServer()
        const { socket, received } = await connect(port)
        socket.write(preamble())
        await until(() => received.closed)
        expect(received.data.length).toBe(0)
        expect(ofType('connection')).toHaveLength(0)

        peerFilter.flush()
        expect(ofType('peer-refused')).toEqual([{ type: 'peer-refused', listener: 'control', addressClass: 'other', count: 1 }])
    })

    test('send writes a length-prefixed frame to the peer', async () => {
        const port = await startServer()
        const { received } = await handshake(port)
        const id = ofType('connection')[0].connectionId

        expect(server.send(id, '{"t":"pong"}')).toBe(true)
        await until(() => received.data.length >= 9 + 4 + 12)
        expect(received.data.subarray(9).equals(frame('{"t":"pong"}'))).toBe(true)
    })

    test('send fails for unknown connections, empty or oversize payloads', async () => {
        const port = await startServer({ maxFrameBytes: 8 })
        await handshake(port)
        const id = ofType('connection')[0].connectionId

        expect(server.send('nope', 'x')).toBe(false)
        expect(server.send(id, '')).toBe(false)
        expect(server.send(id, 'x'.repeat(9))).toBe(false)
        expect(server.send(id, 5)).toBe(false)
    })

    test('close ends the connection and reports the reason', async () => {
        const port = await startServer()
        const { received } = await handshake(port)
        const id = ofType('connection')[0].connectionId

        server.close(id, 'bye')
        await until(() => received.closed)
        await until(() => ofType('connection-closed').length === 1)
        expect(ofType('connection-closed')[0]).toEqual({ type: 'connection-closed', connectionId: id, reason: 'bye' })
        expect(() => server.close(id)).not.toThrow()
    })

    test('reports a peer-initiated close', async () => {
        const port = await startServer()
        const { socket } = await handshake(port)
        socket.destroy()
        await until(() => ofType('connection-closed').length === 1)
        expect(ofType('connection-closed')[0].reason).toBe('peer-closed')
    })

    test('closeAll closes every connection with the given reason', async () => {
        const port = await startServer()
        await handshake(port)
        const c2 = await connect(port)
        c2.socket.write(preamble())
        await until(() => ofType('connection').length === 2)

        server.closeAll('renderer-gone')
        await until(() => ofType('connection-closed').length === 2)
        expect(ofType('connection-closed').map(e => e.reason)).toEqual(['renderer-gone', 'renderer-gone'])
        expect(server.getConnectionCount()).toBe(0)
        expect(server.isRunning()).toBe(true)
    })

    test('reports EADDRINUSE per listener and is idempotent', async () => {
        const port = await startServer()
        const again = await server.start({ port: 0, host: '127.0.0.1' })
        expect(again).toEqual({ ok: true, port, alreadyRunning: true })

        const other = new ControlServer({ emit: e => events.push(e), peerFilter })
        const res = await other.start({ port, host: '127.0.0.1' })
        expect(res).toEqual({ ok: false, error: { code: 'EADDRINUSE' } })
        expect(events.find(e => e.type === 'error')).toMatchObject({ listener: 'control', phase: 'listen', code: 'EADDRINUSE' })
    })

    test('rejects invalid start options', async () => {
        expect(await server.start({ port: -1 })).toEqual({ ok: false, error: { code: 'EINVAL' } })
        expect(await server.start({ port: 70000 })).toEqual({ ok: false, error: { code: 'EINVAL' } })
    })

    test('stop closes connections and the listener', async () => {
        const port = await startServer()
        const { received } = await handshake(port)
        await server.stop()
        await until(() => received.closed)
        expect(server.isRunning()).toBe(false)
        expect(server.getPort()).toBeUndefined()
        expect(ofType('stopped')).toHaveLength(1)
        expect(ofType('connection-closed')[0].reason).toBe('stopped')
    })
})
