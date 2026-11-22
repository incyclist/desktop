const net = require('node:net')
const { assert, sleep, skip } = require('../lib/harness')
const { PhoneClient } = require('../lib/phone')
const discovery = require('../lib/discovery')

async function rawSocket(ctx, bytes, { wait = 1500 } = {}) {
    const target = await ctx.target()
    return await new Promise(resolve => {
        const chunks = []
        const socket = net.connect(target.port, target.host, () => bytes && socket.write(bytes))
        const t0 = Date.now()
        socket.on('data', c => chunks.push(c))
        socket.on('error', () => undefined)
        socket.on('close', () => resolve({ closed: true, received: Buffer.concat(chunks), ms: Date.now() - t0 }))
        setTimeout(() => { if (!socket.destroyed) { socket.destroy(); resolve({ closed: false, received: Buffer.concat(chunks), ms: Date.now() - t0 }) } }, wait)
    })
}

async function run(ctx) {
    ctx.reporter.group('(ii)', 'bidirectional TCP control channel')
    const wire = ctx.wire
    const host = ctx.host

    await ctx.ensureCreds().catch(() => undefined)      // brings the transport up (pairing opens the listeners)

    await ctx.check('1', 'preamble: answered with INCYLINK + accepted version (requested 1 -> 1, requested 9 -> 1)', async () => {
        const a = await ctx.phone({ preamble: { version: 1 } })
        assert.eq(a.preambleVersion, 1)
        const b = await ctx.phone({ preamble: { version: 9 } })
        assert.eq(b.preambleVersion, 1, 'highest supported version <= requested')
    })

    await ctx.check('2', 'preamble rejection: wrong magic, HTTP, version 0 -> closed without a single byte back', async () => {
        const cases = {
            'HTTP request': Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'),
            'wrong magic': Buffer.from('INCYLIXX\x01'),
            'first byte wrong': Buffer.from('XNCYLINK\x01'),
            'version 0': Buffer.concat([Buffer.from('INCYLINK'), Buffer.from([0])]),
        }
        for (const [name, bytes] of Object.entries(cases)) {
            const res = await rawSocket(ctx, bytes, { wait: 2000 })
            assert.ok(res.closed, `${name}: connection closed`)
            assert.eq(res.received.length, 0, `${name}: bytes sent back`)
        }
    })

    await ctx.check('3', 'preamble timeout: a silent or half-sent preamble is closed', async () => {
        if (host)
            await host.setLimits({ preambleTimeoutMs: 700 })
        try {
            const limit = host ? 700 : 5000
            for (const bytes of [undefined, Buffer.from('INCY')]) {
                const res = await rawSocket(ctx, bytes, { wait: limit + 2500 })
                assert.ok(res.closed, 'closed')
                assert.ok(res.ms >= limit - 100 && res.ms < limit + 2000, `closed after ${res.ms} ms (limit ${limit})`)
            }
        }
        finally {
            await host?.restoreLimits()
        }
    }, { timeout: 40000 })

    await ctx.check('4', 'echo request/response correlates by id and repeats data (incl. unicode and a 40 KB body)', async () => {
        const { phone } = await ctx.login()
        const data = { a: [1, 2, { b: null }], s: 'Grüße 🚴 日本語', big: 'x'.repeat(40_000) }
        const res = await phone.request('echo', { data }, 'echo-1')
        assert.eq(res.t, 'echo')
        assert.eq(res.id, 'echo-1')
        assert.deepEq(res.b.data, data)
        assert.ok(res.m, 'response is signed')
        const ids = await Promise.all([1, 2, 3].map(i => phone.request('echo', { data: i }, `par-${i}`)))
        assert.deepEq(ids.map(m => m.b.data), [1, 2, 3], 'interleaved requests')
    })

    await ctx.check('5', 'ping/pong keepalive: pong carries the ping id and is signed', async () => {
        const { phone } = await ctx.login()
        const res = await phone.request('ping', {}, 'ping-1')
        assert.eq(res.t, 'pong')
        assert.eq(res.id, 'ping-1')
        assert.ok(res.m)
    })

    await ctx.check('6', 'sequence numbers: both directions strictly increase, unknown message types are ignored', async () => {
        const { phone } = await ctx.login()
        phone.send('future-message', { x: 1 }, 'u1')
        const pong = await phone.request('ping', {}, 'ping-2')
        assert.eq(pong.t, 'pong', 'connection survives an unknown type')
        assert.ok(!phone.inbox.some(m => m.id === 'u1'), 'unknown type got no answer')
        assert.eq(phone.rejected.length, 0, 'every frame from the desktop verified')
    })

    await ctx.check('7', 'before authentication: echo -> not-authenticated, bad JSON -> bad-request; connection stays usable', async () => {
        const phone = await ctx.helloPhone()
        phone.send('echo', { data: 1 }, 'x1')
        const res = await phone.next(m => m.t === 'error', 3000, 'not-authenticated error')     // errors carry no id
        assert.eq(res.b.code, 'not-authenticated')
        phone.writeRaw(wire.encodeLinkFrame('this is not json'))
        const bad = await phone.next(m => m.t === 'error' && m.b.code === 'bad-request', 3000, 'bad-request')
        assert.ok(bad)
        const again = await phone.hello()
        assert.eq(again.t, 'hello', 'still answering after errors')
    })

    await ctx.check('8', 'unsupported protocol major -> error with supported range, then closed', async () => {
        const phone = await ctx.phone()
        phone.send('hello', { role: 'client', protocol: { min: { major: 2, minor: 0 }, max: { major: 3, minor: 1 } } }, 'h2')
        const err = await phone.next(m => m.t === 'error', 3000, 'unsupported-protocol error')
        assert.eq(err.b.code, 'unsupported-protocol')
        assert.deepEq(err.b.supported, wire.LINK_PROTOCOL_RANGE)
        assert.ok(await phone.closedWithin(3000), 'closed')
    })

    await ctx.check('9', 'desktop-initiated push: a signed frame without a request reaches the phone', async () => {
        if (!host)
            return skip('the product has no push message yet; self-host injects one through the real session channel')
        const { phone } = await ctx.login()
        const clientId = host.clients().find(c => c.secret === ctx.creds.secret).clientId
        await host.push(clientId, 'echo', { data: 'pushed' })
        const msg = await phone.next(m => m.t === 'echo' && m.id === undefined, 3000, 'pushed frame')
        assert.eq(msg.b.data, 'pushed')
        assert.ok(msg.m, 'signed')
        const reply = await phone.request('ping', {}, 'after-push')
        assert.eq(reply.t, 'pong', 'request/response and push share one connection')
    })

    await ctx.check('10', 'idle timeout closes a silent client; pings keep a client alive', async () => {
        if (!host && !ctx.opts.slow)
            return skip('real idle timeout is 60 s; run with --slow')
        const idle = host ? 1500 : 60_000
        if (host)
            await host.setLimits({ idleTimeoutMs: idle })
        try {
            const mark = host?.mark()
            const silent = (await ctx.login()).phone
            const t0 = Date.now()
            const alive = (await ctx.login()).phone
            const keepAlive = setInterval(() => alive.send('ping', {}), Math.max(300, idle / 3))
            try {
                assert.ok(await silent.closedWithin(idle + 4000), 'silent client closed')
                const waited = Date.now() - t0
                assert.ok(waited >= idle - 200, `closed no earlier than the idle limit (${waited} ms)`)
                assert.eq(alive.closed, false, 'pinging client still connected')
            }
            finally {
                clearInterval(keepAlive)
            }
            if (host) {
                await sleep(100)
                const reasons = host.eventsSince(mark).filter(e => e.type === 'connection-closed').map(e => e.reason)
                assert.ok(reasons.includes('idle-timeout'), `transport reports reason idle-timeout (got ${reasons})`)
            }
        }
        finally {
            await host?.restoreLimits()
        }
    }, { timeout: 90_000 })

    await ctx.check('11', 'frame limits: oversized or empty frame closes the connection; a 60 KB frame is fine', async () => {
        const mark = host?.mark()
        const { phone } = await ctx.login()
        const ok = await phone.request('echo', { data: 'y'.repeat(30_000) }, 'sz1')
        assert.eq(ok.t, 'echo', 'sizable frame answered')

        const big = await ctx.login()
        const header = Buffer.alloc(4)
        header.writeUInt32BE(64 * 1024 + 1)
        big.phone.writeRaw(header)
        assert.ok(await big.phone.closedWithin(3000), 'oversized frame header closes')

        const empty = await ctx.login()
        empty.phone.writeRaw(Buffer.alloc(4))
        assert.ok(await empty.phone.closedWithin(3000), 'zero-length frame closes')

        if (host) {
            await sleep(100)
            const reasons = host.eventsSince(mark).filter(e => e.type === 'connection-closed').map(e => e.reason)
            assert.ok(reasons.includes('frame-too-large'), `reasons: ${reasons}`)
            assert.ok(reasons.includes('invalid-frame'), `reasons: ${reasons}`)
        }
    })

    await ctx.check('12', 'frames per second limit (20/s) closes a flooding client', async () => {
        const mark = host?.mark()
        const { phone } = await ctx.login()
        for (let i = 0; i < 40; i++)
            phone.send('ping', {})
        assert.ok(await phone.closedWithin(3000), 'flooding connection closed')
        if (host) {
            await sleep(100)
            const reasons = host.eventsSince(mark).filter(e => e.type === 'connection-closed').map(e => e.reason)
            assert.ok(reasons.includes('rate-limited'), `reasons: ${reasons}`)
        }
    })

    await ctx.check('13', 'connections per peer are limited (4): further connections are dropped', async () => {
        const phones = []
        const results = []
        for (let i = 0; i < 6; i++) {
            const p = new PhoneClient(wire, await ctx.target(), {})
            ctx.phones.push(p)
            phones.push(p)
            results.push(p.connect().then(() => true, () => false))
        }
        const accepted = (await Promise.all(results)).filter(Boolean).length
        assert.eq(accepted, 4, 'connections accepted')
    })

    await ctx.check('14', 'renderer reload closes control connections (reason renderer-gone); reconnect and re-auth work', async () => {
        const { phone } = await ctx.login()
        await ctx.step('reload the app window (Ctrl+R) in the running dev app', async () => {
            host.rendererReload()
        })
        assert.ok(await phone.closedWithin(host ? 3000 : 60_000), 'control connection closed')
        if (host) {
            assert.ok(host.events.some(e => e.type === 'connection-closed' && e.reason === 'renderer-gone'), 'transport reports reason renderer-gone')
        }
        await sleep(host ? 200 : 3000)
        const again = await ctx.login()
        assert.ok(again.session.mediaToken, 'new session after reload')
    }, { timeout: 90_000 })

    await ctx.check('15', 'network change event triggers a re-announcement; the phone recovers (browse + challenge-response)', async () => {
        if (!host)
            return skip('simulation needs the in-process host; the real thing is 15b')
        const { phone } = await ctx.login()
        const watch = discovery.watch()
        try {
            host.feature.emitEvent({ type: 'network-changed', addresses: [] })        // what the 5 s poll emits
            await sleep(3500)
            const names = [...new Set(watch.events.filter(e => e.kind === 'up').map(e => e.name))]
            assert.eq(names.length, 1, `announced again: ${JSON.stringify(watch.events.map(e => [e.kind, e.name]))}`)
        }
        finally {
            watch.stop()
        }
        phone.close()
        const found = await discovery.browse({ timeout: 4000, until: l => l.length > 0 })
        assert.ok(found.length > 0, 'discovered by a fresh browse')
        const target = { host: found[0].addresses[0] ?? '127.0.0.1', port: found[0].port }
        const recovered = new PhoneClient(wire, target, {})
        ctx.phones.push(recovered)
        await recovered.connect()
        await recovered.hello()
        const res = await recovered.authenticate([{ linkId: ctx.creds.linkId, secret: ctx.creds.secret }])
        assert.eq(res.ok, true, 'new session at the discovered address')
        return 'simulated with the network-changed event, not a real address change (see 15b)'
    }, { timeout: 40000 })

    await ctx.check('15b', 'real address change (second NIC / DHCP renew): network-changed -> reannounce -> browse -> new session', async () => {
        await ctx.step('change the computer\'s IP address (DHCP renew, switch Wi-Fi, or add/remove a NIC), then wait ~10 s')
        const found = await discovery.browse({ timeout: 8000, until: l => l.length > 0 })
        assert.ok(found.length > 0, 'announcement found after the change')
        const target = { host: found[0].addresses[0], port: found[0].port }
        const phone = new PhoneClient(wire, target, {})
        ctx.phones.push(phone)
        await phone.connect()
        await phone.hello()
        const creds = await ctx.ensureCreds()
        const res = await phone.authenticate([{ linkId: creds.linkId, secret: creds.secret }])
        assert.eq(res.ok, true, 'new session at the new address')
    }, { timeout: 300_000 })
}

module.exports = { run }
