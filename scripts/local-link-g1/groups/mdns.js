const os = require('node:os')
const { assert, sleep, skip, waitFor } = require('../lib/harness')
const discovery = require('../lib/discovery')

/** Before the first pairing: nothing may be announced. Runs first. */
async function pre(ctx) {
    ctx.reporter.group('(vi)a', 'mDNS: nothing announced before the first pairing')
    await ctx.check('1', 'no _incyclist._tcp announcement and no listener before the first pairing', async () => {
        if (ctx.host) {
            const status = await ctx.host.status()
            assert.deepEq(status.running, { control: false, media: false }, 'listeners')
            assert.eq(status.announced, null, 'announcement')
        }
        else if (ctx.creds)
            return { status: 'SKIP', reason: 'this computer already has a paired phone (credentials file given), so it announces legitimately' }
        const found = await discovery.browse({ timeout: 3500 })
        if (!ctx.host && found.length)
            return { status: 'SKIP', reason: `already announcing: ${found.map(s => s.name).join(', ')} (reset the paired phones to verify)` }
        assert.eq(found.length, 0, `browse found ${JSON.stringify(found.map(s => s.name))}`)
    })
}

async function run(ctx) {
    ctx.reporter.group('(vi)', 'mDNS announcement and re-announcement')
    const host = ctx.host

    await ctx.ensureCreds()
    let control

    await ctx.check('1', 'announcement is visible to a browse: _incyclist._tcp, "<name> (XXXX)", random host label, control port', async () => {
        control = await ctx.target()
        const found = await discovery.browse({ timeout: 6000, until: l => l.length > 0 })
        assert.eq(found.length, 1, `services found: ${JSON.stringify(found.map(s => s.name))}`)
        const s = found[0]
        assert.match(s.name, /^.+ \([A-HJ-NP-Z2-9]{4}\)$/, 'instance name with random suffix')
        assert.match(s.host, /^incyclist-[a-z0-9]{8}\.local$/, 'random host label')
        assert.eq(s.port, control.port, 'announced port is the control port')
        assert.ok(s.addresses.length > 0, 'resolves to an IPv4 address')
        const me = os.hostname().toLowerCase()
        assert.ok(!s.host.toLowerCase().includes(me) && !s.name.toLowerCase().includes(me), 'OS host name is not announced')
        assert.ok(!s.name.includes(os.userInfo().username), 'OS user name is not announced')
        if (host)
            assert.eq(s.name, (await host.status()).announced.instanceName)
        ctx.announced = s
    }, { timeout: 20000 })

    await ctx.check('2', 'third-party browser (avahi-browse) sees the same service', async () => {
        const rows = await discovery.avahiBrowse(8000)
        if (rows === undefined)
            return skip('avahi-browse is not installed (use dns-sd -B _incyclist._tcp on macOS/Windows)')
        const mine = rows.filter(r => r.name === ctx.announced?.name)
        assert.ok(mine.length > 0, `"${ctx.announced?.name}" not in avahi-browse rows: ${JSON.stringify(rows.map(r => [r.name, r.port]))}`)
        assert.ok(mine.every(r => r.port === control.port), 'port')
    }, { timeout: 20000 })

    // A long-lived browser already knows the service; a real re-announcement shows up as goodbye
    // (down) followed by a fresh announcement (up). A new browse alone would be answered by the old
    // responder and prove nothing.
    const reannounceCheck = (id, desc, event) => ctx.check(id, desc, async () => {
        const watcher = discovery.watch()
        try {
            await waitFor(() => watcher.events.some(e => e.kind === 'up' && e.name === ctx.announced.name), { timeout: 6000, what: 'the watcher to learn the service' })
            const before = watcher.events.length
            await ctx.step(event.instructions, async () => { host.feature.emitEvent(event.payload) })
            await sleep(host ? 4500 : 15000)
            const after = watcher.events.slice(before)
            const kinds = after.map(e => e.kind).join(',')
            const down = after.findIndex(e => e.kind === 'down')
            assert.ok(down !== -1, `goodbye not observed after the event (events: ${kinds || 'none'})`)
            const up = after.findIndex((e, i) => i > down && e.kind === 'up')
            assert.ok(up !== -1, `no announcement after the goodbye (events: ${kinds})`)
            assert.eq(after[up].name, ctx.announced.name, 'same instance name (suffix kept)')
            assert.eq(after[up].port, control.port, 'same port')
            assert.ok(after[up].addresses.length > 0, 'announced with an address')
            if (host)
                return 'simulated with the transport event (the 5 s poll / powerMonitor emit it in the app)'
        }
        finally {
            watcher.stop()
        }
    }, { timeout: 90_000 })

    await reannounceCheck('3', 'network change: reannounce republishes on the current interfaces', {
        instructions: 'change the network (switch Wi-Fi / replug the cable / renew DHCP) and wait; the app must re-announce within ~10 s',
        payload: { type: 'network-changed', addresses: [] },
    })
    await reannounceCheck('4', 'resume / unlock: reannounce republishes', {
        instructions: 'suspend and resume the computer (or lock and unlock the screen), then wait',
        payload: { type: 'resumed' },
    })

    await ctx.check('5', 'switching the link off withdraws the announcement (goodbye); switching on announces again', async () => {
        const watcher = discovery.watch()
        await waitFor(() => watcher.events.some(e => e.kind === 'up'), { timeout: 6000, what: 'the watcher to learn the service' })
        await ctx.step('switch the phone link OFF in the app settings, then continue', async () => { await host.service.setEnabled(false) })
        await sleep(1500)
        const goodbye = watcher.events.some(e => e.kind === 'down' && e.name === ctx.announced.name)
        watcher.stop()
        assert.ok(goodbye, 'goodbye (TTL 0) seen by a browser that already knew the service')
        const gone = await discovery.browse({ timeout: 3500 })
        assert.eq(gone.length, 0, `still announced: ${JSON.stringify(gone.map(s => s.name))}`)
        await ctx.step('switch the phone link ON again, then continue', async () => { await host.service.setEnabled(true) })
        const back = await discovery.browse({ timeout: 8000, until: l => l.length > 0 })
        assert.eq(back.length, 1, 're-announced')
        control = await ctx.target()
        assert.eq(back[0].port, control.port, 'announces the current control port')
    }, { timeout: 120_000 })
}

module.exports = { run, pre }
