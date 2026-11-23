const net = require('node:net')
const { AssertionError, sleep } = require('./harness')

/**
 * The phone's end of a control connection, scripted. Built on the wire-protocol core of the
 * services library (framing, channel, challenge-response), so it exercises the same code the
 * mobile client uses.
 */
class PhoneClient {
    /**
     * @param wire     services wire-protocol core
     * @param target   {host, port}
     * @param opts     {preamble: false | {magic?, version?}, maxFrameBytes?}
     */
    constructor(wire, target, opts = {}) {
        this.wire = wire
        this.target = target
        this.opts = opts
        this.channel = new wire.LinkClientChannel()
        this.reader = new wire.LinkFrameReader({ preamble: { maxVersion: 1 }, maxFrameBytes: 1024 * 1024 })
        this.inbox = []
        this.rejected = []
        this.rawBytes = 0
        this.sent = []
        this.waiters = []
        this.closed = false
        this.closeError = undefined
        this.preambleVersion = undefined
        this.sessionKey = undefined
        this.closePromise = new Promise(resolve => { this.onClosed = resolve })
    }

    async connect() {
        await new Promise((resolve, reject) => {
            this.socket = net.connect({ host: this.target.host, port: this.target.port }, resolve)
            this.socket.setNoDelay(true)
            this.socket.once('error', reject)
        })
        this.socket.on('error', err => { this.closeError = err })
        this.socket.on('data', chunk => this.onData(chunk))
        this.socket.once('close', () => {
            this.closed = true
            this.waiters.splice(0).forEach(w => w.reject(new AssertionError('connection closed by peer')))
            this.onClosed()
        })
        if (this.opts.preamble !== false) {
            const { version = 1 } = this.opts.preamble ?? {}
            this.writeRaw(this.wire.encodeLinkPreamble(version))
            await this.waitFor(() => this.preambleVersion !== undefined || this.closed, 3000, 'preamble answer')
            if (this.preambleVersion === undefined)
                throw new AssertionError('connection closed before the preamble was answered')
        }
        return this
    }

    onData(chunk) {
        this.rawBytes += chunk.length
        for (const ev of this.reader.push(chunk)) {
            if (ev.type === 'preamble')
                this.preambleVersion = ev.version
            else if (ev.type === 'error')
                this.framingError = ev.code
            else {
                const res = this.channel.decode(ev.payload)
                if (res.ok)
                    this.inbox.push(res.message)
                else
                    this.rejected.push({ reason: res.reason, payload: ev.payload })
            }
        }
        this.waiters.slice().forEach(w => w.check())
    }

    waitFor(pred, timeout, what) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new AssertionError(`timeout waiting for ${what}`)), timeout)
            const finish = (err) => {
                clearTimeout(timer)
                this.waiters = this.waiters.filter(w => w !== waiter)
                err ? reject(err) : resolve()
            }
            const waiter = { check: () => pred() && finish(), reject: finish }
            this.waiters.push(waiter)
            waiter.check()
        })
    }

    writeRaw(buf) {
        this.socket.write(buf)
    }

    /** Sends one envelope; returns the exact bytes written (for replay tests). */
    send(t, b, id) {
        const payload = this.channel.encode(t, b, id)
        const frame = this.wire.encodeLinkFrame(payload, 1024 * 1024)
        this.sent.push(frame)
        this.writeRaw(frame)
        return frame
    }

    /** Next message matching `pred` (default: any); consumed from the inbox. */
    async next(pred = () => true, timeout = 3000, what = 'message') {
        let found
        await this.waitFor(() => {
            const i = this.inbox.findIndex(pred)
            if (i === -1)
                return false
            found = this.inbox.splice(i, 1)[0]
            return true
        }, timeout, what)
        return found
    }

    async expect(t, timeout = 3000) {
        const msg = await this.next(m => m.t === t || m.t === 'error', timeout, `'${t}'`)
        if (msg.t !== t)
            throw new AssertionError(`expected '${t}', got '${msg.t}' ${JSON.stringify(msg.b)}`)
        return msg
    }

    async request(t, b, id = `r${Math.random().toString(36).slice(2, 8)}`, timeout = 3000) {
        this.send(t, b, id)
        return await this.next(m => m.id === id, timeout, `response to '${t}'`)
    }

    /** true if the peer closes within `ms` */
    async closedWithin(ms) {
        await Promise.race([this.closePromise, sleep(ms)])
        return this.closed
    }

    close() {
        if (!this.socket.destroyed)
            this.socket.destroy()
    }

    // ---- protocol steps ----

    async hello(protocol) {
        const range = protocol ?? this.wire.LINK_PROTOCOL_RANGE
        // the desktop's hello is not correlated by id: it is the next hello (or error) frame
        this.send('hello', { role: 'client', protocol: range })
        return await this.next(m => m.t === 'hello' || m.t === 'error', 3000, 'hello answer')
    }

    /** pair-request -> pending (or an immediate refusal). Returns the response message. */
    async pairRequest(clientName = 'G1 harness') {
        return await this.request('pair-request', { clientName })
    }

    async pairVerify(requestId, pin) {
        return await this.request('pair-verify', { requestId, pin })
    }

    /**
     * Challenge-response with the credentials of one or more computers.
     * Returns {ok:false, result} or {ok:true, session, candidate, result}.
     */
    async authenticate(candidates, { probe } = {}) {
        const wire = this.wire
        const { body, state } = probe ?? wire.createLinkAuthProbe(candidates)
        this.lastProbe = { body, state }
        const res = await this.request('auth', body, 'a1', 6000)
        this.lastAuthResult = res
        const outcome = wire.verifyLinkAuthResult(res.b, state)
        if (!outcome.ok)
            return { ok: false, result: res.b }
        this.send('auth-confirm', outcome.confirm)
        this.channel.establish(outcome.sessionKey)
        this.sessionKey = outcome.sessionKey
        const session = await this.expect('session', 4000)
        return { ok: true, session: session.b, candidate: outcome.candidate, result: res.b }
    }
}

module.exports = { PhoneClient }
