const fs = require('node:fs')
const { PhoneClient } = require('./phone')
const http = require('./http')
const discovery = require('./discovery')
const { assert, AssertionError, sleep } = require('./harness')

/** Thrown by a helper when a step needs a human (or a capability only the full app has). */
class ManualRequired extends Error {}

class Context {
    constructor({ wire, reporter, prompt, opts, host }) {
        this.wire = wire
        this.reporter = reporter
        this.prompt = prompt
        this.opts = opts
        this.host = host              // SelfHost, or undefined in remote mode
        this.mode = host ? 'self-host' : 'remote'
        this.phones = []
        this.creds = undefined
        this.authTimes = []
        this.pairTimes = []
        this.resolved = undefined
        this.loadCreds()
    }

    // ---- check runner ----

    /**
     * Runs one check. The body may return {status:'MANUAL'|'SKIP', reason}; throwing an assertion
     * error fails it, throwing ManualRequired marks it MANUAL.
     */
    async check(id, desc, fn, { timeout } = {}) {
        // a remote computer enforces real per-peer rate-limit windows, which the harness waits out
        timeout ??= this.host ? 30_000 : 150_000
        try {
            const result = await Promise.race([
                fn(),
                sleep(timeout).then(() => { throw new AssertionError(`check timed out after ${timeout} ms`) }),
            ])
            if (result?.status)
                this.reporter.record(id, desc, result.status, result.reason)
            else
                this.reporter.record(id, desc, 'PASS', typeof result === 'string' ? result : undefined)
        }
        catch (err) {
            if (err instanceof ManualRequired)
                this.reporter.record(id, desc, 'MANUAL', err.message)
            else
                this.reporter.record(id, desc, 'FAIL', err instanceof AssertionError ? err.message : (err?.stack ?? String(err)))
        }
        finally {
            if (this.cleanup())
                await sleep(this.host ? 150 : 600)           // let the desktop notice the closed sockets (per-peer counters)
        }
    }

    /** Drops every open phone connection; returns true if there were any. */
    cleanup() {
        const open = this.phones.splice(0)
        open.forEach(p => p.close())
        const sockets = http.closeAll()           // HTTP requests and streams a check left open
        return open.length > 0 || sockets > 0
    }

    /**
     * A step only a human can do in the full app. In self-host mode `auto` performs it; otherwise the
     * instructions are printed and the harness waits. Throws ManualRequired when it cannot be done.
     */
    async step(instructions, auto) {
        if (this.host) {
            if (auto)
                return await auto()
            throw new ManualRequired(instructions)
        }
        if (!this.prompt.interactive || this.opts.noWait)
            throw new ManualRequired(instructions)
        const done = await this.prompt.confirm(instructions)
        if (!done)
            throw new ManualRequired(`skipped: ${instructions}`)
    }

    // ---- target ----

    async target() {
        if (this.host) {
            const status = await this.host.status()
            if (!status.running.control)
                throw new AssertionError('control listener is not running')
            return { host: '127.0.0.1', port: status.ports.control }
        }
        return await this.resolveRemote()
    }

    async resolveRemote() {
        if (this.opts.host && this.opts.controlPort)
            return { host: this.opts.host, port: this.opts.controlPort }
        const found = await discovery.browse({ timeout: 4000, until: list => list.length > 0 })
        if (found.length === 0)
            throw new ManualRequired('no _incyclist._tcp service found; pass --host and --control-port, or open Settings > Routes > Route Sharing > Connect your phone or tablet in the app')
        const wanted = this.opts.name ? found.find(s => s.name.includes(this.opts.name)) : found[0]
        if (!wanted)
            throw new ManualRequired(`no announced service matches --name ${this.opts.name}`)
        const address = wanted.addresses[0]
        if (!address)
            throw new AssertionError('announcement has no IPv4 address')
        if (found.length > 1 && !this.opts.name)
            console.log(`  (several computers announced, using "${wanted.name}"; pass --name to choose)`)
        return { host: this.opts.host ?? address, port: wanted.port }
    }

    async mediaTarget(session) {
        const t = await this.target()
        return { host: t.host, port: session.mediaPort }
    }

    // ---- connections ----

    async phone(opts) {
        const p = new PhoneClient(this.wire, await this.target(), opts)
        this.phones.push(p)
        await p.connect()
        return p
    }

    /** A connection that has said hello. */
    async helloPhone() {
        const p = await this.phone()
        const hello = await p.hello()
        assert.eq(hello.t, 'hello', 'server answers hello')
        p.helloBody = hello.b
        return p
    }

    // ---- pairing and sessions ----

    async ensurePairingOpen() {
        if (this.host) {
            if (!this.host.props().pairingOpen)
                await this.host.service.openPairing()
            return
        }
        const p = await this.phone().catch(() => undefined)
        const hello = p ? await p.hello().catch(() => undefined) : undefined
        p?.close()
        if (hello?.b?.pairingOpen)
            return
        await this.step('open Settings > Routes > Route Sharing > Connect your phone or tablet (the pairing window) on the computer under test')
    }

    async readPin() {
        if (this.host)
            return this.host.pin()
        if (this.opts.pinFile) {
            await sleep(300)
            const pin = fs.readFileSync(this.opts.pinFile, 'utf8').trim()
            if (/^\d{6}$/.test(pin))
                return pin
        }
        if (this.opts.pin)
            return this.opts.pin
        if (process.env.G1_PIN)
            return process.env.G1_PIN
        if (!this.prompt.interactive)
            throw new ManualRequired('read the 6-digit code from the computer and pass it as --pin (or G1_PIN)')
        const pin = await this.prompt.ask('enter the 6-digit code shown on the computer')
        if (!/^\d{6}$/.test(pin ?? ''))
            throw new ManualRequired('no valid code entered')
        return pin
    }

    async throttle(times, limit, auto) {
        const now = Date.now()
        while (times.length && now - times[0] > 60_000)
            times.shift()
        if (times.length >= limit) {
            if (this.host)
                auto?.()
            else {
                const wait = times[0] + 60_500 - now
                console.log(`  (waiting ${Math.ceil(wait / 1000)} s for the per-peer rate limit window)`)
                await sleep(wait)
            }
        }
        times.push(Date.now())
    }

    /** Pairs this harness as a new phone. Returns credentials {linkId, secret, name}. */
    async pairNew(clientName = 'G1 harness', { keep = true } = {}) {
        await this.ensurePairingOpen()
        await this.throttle(this.pairTimes, 4, () => this.host.resetRateLimits())
        const p = await this.helloPhone()
        const pending = await p.pairRequest(clientName)
        assert.eq(pending.t, 'pending', `pair-request answered '${pending.t}' ${JSON.stringify(pending.b)}`)
        const pin = await this.readPin()
        const res = await p.pairVerify(pending.b.requestId, pin)
        assert.eq(res.t, 'paired', `pair-verify answered ${JSON.stringify(res.b)}`)
        p.close()
        const creds = { linkId: res.b.linkId, secret: res.b.secret, name: res.b.name }
        if (keep)
            this.setCreds(creds)
        return creds
    }

    async ensureCreds() {
        if (this.creds)
            return this.creds
        return await this.pairNew()
    }

    setCreds(creds) {
        this.creds = creds
        if (this.opts.creds && !this.host && creds) {
            try { fs.writeFileSync(this.opts.creds, JSON.stringify(creds), { mode: 0o600 }) } catch { /* best effort */ }
        }
    }

    loadCreds() {
        if (this.host || !this.opts.creds || !fs.existsSync(this.opts.creds))
            return
        try { this.creds = JSON.parse(fs.readFileSync(this.opts.creds, 'utf8')) } catch { /* ignore */ }
    }

    /** Connects, says hello and authenticates. Returns {phone, session, creds}. */
    async login(creds) {
        const c = creds ?? await this.ensureCreds()
        await this.throttle(this.authTimes, 8, () => this.host.resetRateLimits())
        const phone = await this.helloPhone()
        const res = await phone.authenticate([{ linkId: c.linkId, secret: c.secret }])
        if (!res.ok) {
            if (!creds)
                this.setCreds(undefined)
            throw new AssertionError(`authentication failed: ${JSON.stringify(res.result)}`)
        }
        return { phone, session: res.session, creds: c }
    }

    // ---- media ----

    async catalog(session) {
        const t = await this.mediaTarget(session)
        const res = await http.get(t, '/catalog', { token: session.mediaToken })
        assert.eq(res.status, 200, 'GET /catalog')
        return JSON.parse(res.body.toString('utf8'))
    }
}

module.exports = { Context, ManualRequired }
