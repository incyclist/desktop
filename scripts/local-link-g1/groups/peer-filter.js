const net = require('node:net')
const os = require('node:os')
const { assert, sleep, skip } = require('../lib/harness')
const { PhoneClient } = require('../lib/phone')
const http = require('../lib/http')

const lanAddresses = () => Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
    .map(a => a.address)

/** What a refused client sees on the control port: connection closed, zero bytes. */
async function controlProbe(wire, target) {
    return await new Promise(resolve => {
        const chunks = []
        const socket = net.connect(target.port, target.host, () => socket.write(wire.encodeLinkPreamble(1)))
        socket.on('data', c => chunks.push(c))
        socket.on('error', () => undefined)
        socket.on('close', () => resolve(Buffer.concat(chunks)))
        setTimeout(() => { socket.destroy(); resolve(Buffer.concat(chunks)) }, 2000)
    })
}

async function run(ctx) {
    ctx.reporter.group('(iv)', 'peer filtering')
    const wire = ctx.wire
    const host = ctx.host

    const { session } = await ctx.login().catch(() => ({}))
    ctx.cleanup()

    await ctx.check('1', 'loopback and private (LAN) clients are accepted on both listeners (default policy)', async () => {
        const status = host ? await host.status() : undefined
        const ctrl = await ctx.target()
        const addresses = host ? ['127.0.0.1', ...lanAddresses()] : [ctrl.host]
        assert.ok(session, 'a session is needed')
        for (const address of addresses) {
            const phone = new PhoneClient(wire, { host: address, port: ctrl.port })
            ctx.phones.push(phone)
            await phone.connect()
            assert.eq((await phone.hello()).t, 'hello', `control via ${address === '127.0.0.1' ? 'loopback' : 'LAN address'}`)
            const res = await http.get({ host: address, port: session.mediaPort }, '/catalog', { token: session.mediaToken })
            assert.eq(res.status, 200, `media via ${address === '127.0.0.1' ? 'loopback' : 'LAN address'}`)
        }
        if (host && lanAddresses().length === 0)
            return `only loopback exercised (no private IPv4 address on this machine); listeners: ${JSON.stringify(status.ports)}`
        return `tested via ${addresses.length} address(es)`
    })

    await ctx.check('2', 'address classification and policy precedence (deny > allow > default); invalid CIDR rejects the whole call', async () => {
        if (!host)
            return skip('needs setPeerPolicy, which only the in-process host can call; remote: see 3')
        const filter = host.feature.peerFilter
        const expectations = {
            '10.1.2.3': true, '172.16.0.1': true, '172.32.0.1': false, '192.168.1.1': true, '169.254.1.1': true, '127.0.0.1': true,
            '8.8.8.8': false, '100.64.1.1': false, '::1': true, 'fe80::1%en0': true, 'fd00::1': true, '2001:db8::1': false,
            '::ffff:192.168.1.5': true, '::ffff:8.8.8.8': false, '::ffff:127.0.0.1': true, '': false, 'garbage': false,
        }
        for (const [address, allowed] of Object.entries(expectations))
            assert.eq(filter.isAllowed(address), allowed, `default policy for "${address}"`)
        assert.eq(filter.isAllowed(undefined), false, 'undefined remoteAddress')

        const apply = async (p) => await host.binding.setPeerPolicy(p)
        assert.eq((await apply({ defaultPrivate: true, allow: ['100.64.0.0/10'] })).ok, true)
        assert.eq(filter.isAllowed('100.64.1.1'), true, 'CGNAT widened by allow')
        assert.eq((await apply({ defaultPrivate: true, deny: ['192.168.1.0/24'] })).ok, true)
        assert.eq(filter.isAllowed('192.168.1.5'), false, 'narrowed by deny')
        assert.eq((await apply({ defaultPrivate: false, allow: [] })).ok, true)
        assert.eq(filter.isAllowed('127.0.0.1'), false, 'defaultPrivate:false + empty allow refuses everything')
        assert.eq((await apply({ defaultPrivate: false, allow: ['10.0.0.0/8'], deny: ['10.9.0.0/16'] })).ok, true)
        assert.deepEq([filter.isAllowed('10.1.1.1'), filter.isAllowed('10.9.1.1')], [true, false], 'deny beats allow')
        const bad = await apply({ defaultPrivate: true, allow: ['10.0.0.0/8', 'not-a-cidr'] })
        assert.eq(bad.ok, false, 'invalid CIDR')
        assert.eq(filter.isAllowed('10.1.1.1'), true, 'previous policy stays after a rejected call')
        await apply({ defaultPrivate: true })
    })

    await ctx.check('3', 'a refused peer is dropped before any byte: no response on control, no HTTP answer on media', async () => {
        if (!host)
            return { status: 'MANUAL', reason: 'connect from a public-address host (e.g. a VPS port-forwarded to this computer, or a phone on mobile data via a router port-forward) and confirm the connection is dropped silently' }
        const ctrl = await ctx.target()
        const mark = host.mark()
        const spied = []
        const spy = (logger) => { const orig = logger.logEvent; logger.logEvent = (...a) => { spied.push(JSON.stringify(a)); return orig.apply(logger, a) }; return () => { logger.logEvent = orig } }
        const unspy = [spy(host.feature.logger), spy(host.service)]
        try {
            // "public" = anything the policy does not allow; here loopback is made unacceptable
            assert.eq((await host.binding.setPeerPolicy({ defaultPrivate: true, deny: ['127.0.0.0/8'] })).ok, true)
            const received = await controlProbe(wire, ctrl)
            assert.eq(received.length, 0, 'bytes received from the control listener')
            const reply = await http.get({ host: '127.0.0.1', port: session.mediaPort }, '/catalog', { token: session.mediaToken })
            assert.ok(reply.error && reply.status === undefined, `media listener answered ${reply.status}`)
            const rawReply = await http.raw({ host: '127.0.0.1', port: session.mediaPort }, `GET /catalog?t=${session.mediaToken} HTTP/1.1\r\nHost: x\r\n\r\n`)
            assert.eq(rawReply.length, 0, 'raw bytes from the media listener')
            assert.eq(host.status && (await host.status()).connections, 0, 'no control connection was established')
            assert.ok(!host.eventsSince(mark).some(e => e.type === 'connection'), 'no connection event reached the renderer')

            await host.binding.setPeerPolicy({ defaultPrivate: false, allow: ['127.0.0.1/32'] })
            const allowed = await controlProbe(wire, ctrl).then(b => b, () => Buffer.alloc(0))
            assert.eq(allowed.length, 9, 'allow list admits loopback again (preamble answer received)')
            await host.binding.setPeerPolicy({ defaultPrivate: true, deny: ['127.0.0.0/8'], allow: ['127.0.0.1/32'] })
            assert.eq((await controlProbe(wire, ctrl)).length, 0, 'deny beats allow on the wire')

            host.feature.peerFilter.flush()
            await sleep(200)
            const refused = host.eventsSince(mark).filter(e => e.type === 'peer-refused')
            assert.ok(refused.length >= 2, `peer-refused aggregates: ${JSON.stringify(refused)}`)
            assert.deepEq([...new Set(refused.map(e => e.listener))].sort(), ['control', 'media'])
            for (const e of refused) {
                assert.deepEq(Object.keys(e).filter(k => k !== 'at').sort(), ['addressClass', 'count', 'listener', 'type'], 'aggregate fields')
                assert.ok(e.count >= 1 && /^(public-v4|public-v6|cgnat|other)$/.test(e.addressClass), `class ${e.addressClass}`)
            }
            await sleep(100)
            const logged = spied.join('\n')
            assert.ok(logged.includes('peer refused'), 'services logs the aggregate')
            assert.ok(!/127\.0\.0\.1|::1|::ffff/.test(logged), 'no peer address in any log line')
        }
        finally {
            unspy.forEach(u => u())
            await host.binding.setPeerPolicy({ defaultPrivate: true })
        }
    })

    await ctx.check('4', 'IPv4-mapped IPv6 peers on a dual-stack listener are normalised before matching', async () => {
        if (!host)
            return skip('the product binds IPv4 0.0.0.0 only; this uses a standalone dual-stack listener of the same classes')
        const { ControlServer } = require('../../../src/features/local-link/control-server')
        const { PeerFilter } = require('../../../src/features/local-link/peer-filter')
        const filter = new PeerFilter({ flushIntervalMs: 60_000 })
        const events = []
        const server = new ControlServer({ emit: e => events.push(e), peerFilter: filter })
        const started = await server.start({ port: 0, host: '::' })
        if (!started.ok)
            return skip(`no dual-stack socket available (${started.error?.code})`)
        try {
            const probe = () => controlProbe(wire, { host: '127.0.0.1', port: started.port })
            assert.eq((await probe()).length, 9, 'accepted under the default policy')
            const connection = events.find(e => e.type === 'connection')
            assert.match(connection.peer.address, /^::ffff:127\.0\.0\.1$/, 'node reports the mapped form')
            filter.setPolicy({ defaultPrivate: true, deny: ['127.0.0.0/8'] })
            assert.eq((await probe()).length, 0, 'an IPv4 deny rule matches the mapped address')
            filter.setPolicy({ defaultPrivate: false, allow: ['127.0.0.0/8'] })
            assert.eq((await probe()).length, 9, 'an IPv4 allow rule matches the mapped address')
        }
        finally {
            await server.stop()
            filter.dispose()
        }
    })
}

module.exports = { run }
