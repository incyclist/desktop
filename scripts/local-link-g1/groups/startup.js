const net = require('node:net')
const { assert, sleep, skip } = require('../lib/harness')
const discovery = require('../lib/discovery')

const listening = (port) => new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
})

const occupy = (port) => new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve(server))
})

const closeServer = (server) => new Promise(resolve => server.close(() => resolve()))

async function run(ctx) {
    ctx.reporter.group('(v)', 'start at launch when paired, port reuse')
    const host = ctx.host

    if (!host) {
        await remote(ctx)
        return
    }

    // a clean slate: no paired phone, as on a fresh install
    await host.shutdown()
    Object.keys(host.settings).forEach(k => delete host.settings[k])
    host.boot()
    ctx.creds = undefined
    ctx.pairTimes.length = 0

    await ctx.check('1', 'with 0 paired phones nothing listens or announces after launch', async () => {
        await host.init()
        const status = await host.status()
        assert.deepEq(status.running, { control: false, media: false })
        assert.eq(status.announced, null)
        assert.eq((await discovery.browse({ timeout: 3000 })).length, 0, 'browse')
    })

    let ports, name
    await ctx.check('2', 'pair one phone, quit, relaunch: both listeners and the announcement are back on the SAME ports without any UI action', async () => {
        await ctx.pairNew('G1 startup')
        await host.service.closePairing()
        const before = await host.status()
        ports = before.ports
        name = before.announced.instanceName
        assert.ok(before.running.control && before.running.media, 'running while a phone is paired')
        assert.eq(host.service.getDisplayProps().pairingOpen, false)

        await host.restart({ init: true })                         // quit hook, new process state, init() only
        await sleep(500)
        const after = await host.status()
        assert.deepEq(after.running, { control: true, media: true })
        assert.deepEq(after.ports, ports, 'ports')
        assert.ok(after.announced, 'announced')
        assert.eq(host.service.getDisplayProps().pairingOpen, false, 'pairing stays closed')
        const found = await discovery.browse({ timeout: 6000, until: l => l.length > 0 })
        assert.eq(found.length, 1, 'browse')
        assert.eq(found[0].port, ports.control, 'announced port')
        const { session } = await ctx.login()
        assert.eq(session.mediaPort, ports.media, 'media port in the session')
        ctx.cleanup()
        assert.ok(after.announced.instanceName !== undefined)
        return `ports ${ports.control}/${ports.media} kept; instance name ${name === after.announced.instanceName ? 'kept' : 'changed (fresh random suffix per launch)'}`
    }, { timeout: 40_000 })

    await ctx.check('3', 'occupied stored control port: fallback to an ephemeral port, announced and reachable on the new port', async () => {
        await host.shutdown()
        const blocker = await occupy(ports.control)
        try {
            host.boot()
            await host.init()
            const status = await host.status()
            assert.deepEq(status.running, { control: true, media: true })
            assert.ok(status.ports.control !== ports.control, 'control moved')
            assert.eq(status.ports.media, ports.media, 'media port kept')
            assert.eq(host.settings.localLink.ports.control, status.ports.control, 'new port stored')
            const found = await discovery.browse({ timeout: 6000, until: l => l.length > 0 })
            assert.eq(found[0]?.port, status.ports.control, 'announcement carries the new port')
            const { session } = await ctx.login()
            assert.eq(session.mediaPort, ports.media)
            ports = status.ports
        }
        finally {
            await closeServer(blocker)
        }
    }, { timeout: 40_000 })

    await ctx.check('4', 'both stored ports occupied: both fall back', async () => {
        await host.shutdown()
        const a = await occupy(ports.control)
        const b = await occupy(ports.media)
        try {
            host.boot()
            await host.init()
            const status = await host.status()
            assert.deepEq(status.running, { control: true, media: true })
            assert.ok(status.ports.control !== ports.control && status.ports.media !== ports.media, 'both moved')
            const { session } = await ctx.login()
            assert.eq(session.mediaPort, status.ports.media)
            ports = status.ports
        }
        finally {
            await closeServer(a)
            await closeServer(b)
        }
    }, { timeout: 40_000 })

    await ctx.check('5', 'link switched off: nothing listens after launch; switching on starts it again on the same ports', async () => {
        await host.service.setEnabled(false)
        assert.deepEq((await host.status()).running, { control: false, media: false }, 'off stops the listeners')
        await host.restart({ init: true })
        const status = await host.status()
        assert.deepEq(status.running, { control: false, media: false }, 'still off after relaunch')
        assert.eq(status.announced, null)
        assert.eq((await discovery.browse({ timeout: 3000 })).length, 0)
        await host.service.setEnabled(true)
        const on = await host.status()
        assert.deepEq(on.running, { control: true, media: true })
        assert.deepEq(on.ports, ports, 'ports reused')
    }, { timeout: 40_000 })

    await ctx.check('6', 'removing the last phone with the pairing window closed stops the transport; relaunch stays silent', async () => {
        const clientId = host.clients()[0].clientId
        await host.service.removeClient(clientId)
        assert.deepEq((await host.status()).running, { control: false, media: false })
        await host.restart({ init: true })
        assert.deepEq((await host.status()).running, { control: false, media: false })
    }, { timeout: 40_000 })
}

async function remote(ctx) {
    const wait = async (pred, ms) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
            if (await pred())
                return true
            await sleep(1500)
        }
        return false
    }
    const found = () => discovery.browse({ timeout: 3000, until: l => l.length > 0 })

    await ctx.check('1', 'restart with >= 1 paired phone: listeners + announcement return on the same ports, no UI action', async () => {
        const creds = await ctx.ensureCreds()
        const { session } = await ctx.login(creds)
        const before = { control: (await ctx.target()).port, media: session.mediaPort }
        ctx.cleanup()
        await ctx.step(`quit the app completely and start it again (npm run dev). Do NOT open Settings > Routes > Route Sharing > Connect your phone or tablet. Control port was ${before.control}, media port ${before.media}`)
        assert.ok(await wait(async () => (await found()).length > 0, 90_000), 'announcement came back without UI action')
        const after = await ctx.target()
        assert.eq(after.port, before.control, 'control port')
        const again = await ctx.login(creds)
        assert.eq(again.session.mediaPort, before.media, 'media port')
    }, { timeout: 200_000 })

    await ctx.check('2', 'occupied stored port -> ephemeral fallback, announced correctly', async () => {
        const creds = await ctx.ensureCreds()
        const { session } = await ctx.login(creds)
        const stored = { control: (await ctx.target()).port, media: session.mediaPort }
        ctx.cleanup()
        await ctx.step(`quit the app, occupy the control port (e.g. "nc -l ${stored.control}"), start the app again and leave the blocker running`)
        assert.ok(await wait(async () => (await found()).some(s => s.port !== stored.control), 90_000), 'announcement with a different port')
        const after = await ctx.target()
        assert.ok(after.port !== stored.control, 'control port moved')
        const again = await ctx.login(creds)
        assert.eq(again.session.mediaPort, stored.media, 'media port kept')
    }, { timeout: 200_000 })

    await ctx.check('3', 'zero paired phones / link off: nothing listens after a restart', async () => {
        await ctx.step('remove all paired phones (or uncheck "Share routes with my phones and tablets" in Settings > Routes > Route Sharing), quit and restart the app, then continue')
        assert.eq((await discovery.browse({ timeout: 4000 })).length, 0, 'announced')
    })
}

module.exports = { run }
