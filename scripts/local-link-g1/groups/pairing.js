const { assert, skip } = require('../lib/harness')

const WRONG_PIN = '000000'

async function request(ctx, name) {
    await ctx.throttle(ctx.pairTimes, 4, () => ctx.host.resetRateLimits())
    const phone = await ctx.helloPhone()
    const pending = await phone.pairRequest(name)
    assert.eq(pending.t, 'pending', `pair-request answered ${JSON.stringify(pending.b)}`)
    return { phone, requestId: pending.b.requestId, pending }
}

const wrongPin = async (ctx) => {
    const pin = ctx.host ? ctx.host.pin() : undefined
    return pin === WRONG_PIN ? '111111' : WRONG_PIN
}

async function run(ctx) {
    ctx.reporter.group('(iii)', 'pairing and authentication')
    const wire = ctx.wire

    await ctx.check('1', 'pairing open: hello advertises pairingOpen, protocol 1.0 and no identifying data', async () => {
        await ctx.ensurePairingOpen()
        const p = await ctx.helloPhone()
        assert.eq(p.helloBody.pairingOpen, true, 'pairingOpen')
        assert.deepEq(p.helloBody.protocol, { major: 1, minor: 0 })
        assert.deepEq(Object.keys(p.helloBody).sort(), ['capabilities', 'pairingOpen', 'protocol'], 'hello carries nothing else')
    })

    await ctx.check('2', 'wrong PIN -> wrong, attemptsRemaining 2', async () => {
        const { phone, requestId, pending } = await request(ctx, 'G1 wrong')
        assert.eq(pending.b.expiresIn, 120, 'expiresIn')
        const res = await phone.pairVerify(requestId, await wrongPin(ctx))
        assert.eq(res.t, 'pair-failed')
        assert.deepEq(res.b, { outcome: 'wrong', attemptsRemaining: 2 })
    })

    await ctx.check('3', '3 wrong PINs invalidate the request, even the right PIN fails afterwards', async () => {
        const { phone, requestId } = await request(ctx, 'G1 three wrong')
        const pin = ctx.host ? ctx.host.pin() : undefined
        const wrong = await wrongPin(ctx)
        const remaining = []
        for (let i = 0; i < 3; i++)
            remaining.push((await phone.pairVerify(requestId, wrong)).b.attemptsRemaining)
        assert.deepEq(remaining, [2, 1, 0])
        if (ctx.host) {
            const res = await phone.pairVerify(requestId, pin)
            assert.eq(res.t, 'pair-failed', 'right PIN after invalidation')
            assert.ok(res.b.outcome !== 'paired')
            assert.eq(ctx.host.props().connectWindow?.notice, 'invalidated', 'desktop shows the notice')
        }
    })

    await ctx.check('4', 'denied: Deny on the desktop is pushed to the phone and stays denied', async () => {
        const { phone, requestId } = await request(ctx, 'G1 deny')
        await ctx.step('click "Deny" on the pairing request in the app', async () => ctx.host.service.denyPairing())
        const pushed = await phone.next(m => m.t === 'pair-failed', 4000, 'pushed denial')
        assert.deepEq(pushed.b, { outcome: 'denied' })
        const res = await phone.pairVerify(requestId, await wrongPin(ctx))
        assert.deepEq(res.b, { outcome: 'denied' }, 'later verify')
    })

    await ctx.check('5', 'superseded: a newer request from another connection replaces the first', async () => {
        const a = await request(ctx, 'G1 first')
        const b = await request(ctx, 'G1 second')
        const pushed = await a.phone.next(m => m.t === 'pair-failed', 4000, 'pushed supersede')
        assert.deepEq(pushed.b, { outcome: 'superseded' })
        const res = await a.phone.pairVerify(a.requestId, await wrongPin(ctx))
        assert.deepEq(res.b, { outcome: 'superseded' }, 'verify on the replaced request')
        assert.ok(b.requestId !== a.requestId)
    })

    await ctx.check('6', 'expired: after 120 s the request is pushed as expired and verify answers expired', async () => {
        const { phone, requestId } = await request(ctx, 'G1 expire')
        if (ctx.host) {
            const pairing = ctx.host.service.pairing
            pairing.expire(pairing.pending)            // what the 120 s timer does
            const pushed = await phone.next(m => m.t === 'pair-failed', 4000, 'pushed expiry')
            assert.deepEq(pushed.b, { outcome: 'expired' })
            const res = await phone.pairVerify(requestId, ctx.host.pin() ?? WRONG_PIN)
            assert.deepEq(res.b, { outcome: 'expired' })
            return 'timer path forced in-process (not a 120 s wait)'
        }
        if (!ctx.opts.slow)
            return skip('real 120 s wait only with --slow')
        const pushed = await phone.next(m => m.t === 'pair-failed', 130_000, 'pushed expiry')
        assert.deepEq(pushed.b, { outcome: 'expired' })
    }, { timeout: 140_000 })

    await ctx.check('7', 'expired by clock: verify after the TTL is answered expired', async () => {
        if (!ctx.host)
            return skip('needs control of the clock (covered by 6 with --slow)')
        const { phone, requestId } = await request(ctx, 'G1 clock')
        const hooks = ctx.host.service.pairing.hooks
        hooks.now = () => Date.now() + 121_000
        try {
            const res = await phone.pairVerify(requestId, ctx.host.pin())
            assert.deepEq(res.b, { outcome: 'expired' })
        }
        finally {
            delete hooks.now
        }
    })

    await ctx.check('8', 'PIN success: paired with linkId, 32-byte secret, name and protocol version', async () => {
        const creds = await ctx.pairNew('G1 harness')
        assert.match(creds.linkId, /^[0-9a-f-]{36}$/, 'linkId')
        assert.eq(Buffer.from(creds.secret, 'base64url').length, 32, 'secret bytes')
        assert.ok(creds.name.length > 0, 'name')
        if (ctx.host) {
            const stored = ctx.host.clients()
            assert.eq(stored.length, 1, 'one paired client persisted')
            assert.eq(stored[0].secret, creds.secret, 'persisted secret')
            assert.eq(stored[0].clientName, 'G1 harness')
            assert.ok(!JSON.stringify(ctx.host.props()).includes(creds.secret), 'display props never carry the secret')
        }
    })

    await ctx.check('9', 'rate-limited: more than 5 pair-requests per minute from one peer', async () => {
        if (!ctx.host && !ctx.opts.slow)
            return skip('would exhaust the remote computer\'s per-peer budget for a minute; run with --slow')
        ctx.host?.resetRateLimits()
        const phone = await ctx.helloPhone()
        const answers = []
        for (let i = 0; i < 7; i++)
            answers.push((await phone.pairRequest('G1 rate')).b)
        assert.deepEq(answers.slice(0, 5).map(a => a.outcome), ['pending', 'pending', 'pending', 'pending', 'pending'])
        assert.eq(answers[5].outcome, 'rate-limited', 'sixth request')
        assert.ok(answers[5].retryAfter > 0 && answers[5].retryAfter <= 60, 'retryAfter in seconds')
        ctx.host?.resetRateLimits()
        if (!ctx.host)
            ctx.pairTimes.push(...Array(6).fill(Date.now()))
    })

    await ctx.check('10', 'pairing-closed: with the pairing window closed pair-request and pair-verify are refused', async () => {
        await ctx.step('close the pairing window (Settings > Routes > Route Sharing > Connect your phone or tablet) but leave the paired phone in place',
            async () => { await ctx.host.service.closePairing() })
        const phone = await ctx.helloPhone()
        assert.eq(phone.helloBody.pairingOpen, false, 'hello.pairingOpen')
        const res = await phone.pairRequest('G1 closed')
        assert.eq(res.t, 'pair-failed')
        assert.deepEq(res.b, { outcome: 'pairing-closed' })
        const verify = await phone.pairVerify('whatever', '123456')
        assert.deepEq(verify.b, { outcome: 'pairing-closed' })
    })

    const creds = () => ctx.ensureCreds()

    await ctx.check('11', 'challenge-response: correct secret -> ok, verified proof, signed session with media token', async () => {
        const { phone, session } = await ctx.login()
        assert.ok(phone.channel.isEstablished(), 'channel signed')
        assert.eq(typeof session.mediaToken, 'string')
        assert.ok(session.mediaPort > 0, 'mediaPort')
        assert.ok(session.mediaTokenExpiresAt > Date.now(), 'token expiry in the future')
        assert.eq(typeof session.catalogVersion, 'string')
        assert.ok(Array.isArray(session.capabilities))
        assert.eq(phone.lastAuthResult.b.ok, true)
    })

    await ctx.check('12', 'wrong secret -> bare ok:false (no detail), after the fixed delay; same for an unknown client', async () => {
        const good = await creds()
        const timings = []
        for (const secret of [Buffer.alloc(32, 7).toString('base64url'), good.secret]) {
            await ctx.throttle(ctx.authTimes, 8, () => ctx.host.resetRateLimits())
            const phone = await ctx.helloPhone()
            const t0 = Date.now()
            const res = await phone.authenticate([{ linkId: good.linkId, secret }])
            timings.push(Date.now() - t0)
            if (secret === good.secret)
                assert.eq(res.ok, true, 'control: correct secret')
            else {
                assert.eq(res.ok, false)
                assert.deepEq(phone.lastAuthResult.b, { ok: false }, 'no detail')
            }
        }
        assert.ok(timings.every(t => t >= 250), `both answers wait the fixed delay (${timings.join(', ')} ms)`)
        // a probe with a malformed nonce gets the same bare answer
        await ctx.throttle(ctx.authTimes, 8, () => ctx.host.resetRateLimits())
        const phone = await ctx.helloPhone()
        const res = await phone.request('auth', { nc: 'x', kids: ['y'] }, 'm1', 6000)
        assert.deepEq(res.b, { ok: false }, 'malformed probe')
    })

    await ctx.check('13', 'replayed auth-result is rejected by the client (fresh nonce per attempt)', async () => {
        const good = await creds()
        const first = await ctx.login()
        const recorded = first.phone.lastAuthResult.b
        first.phone.close()
        await ctx.throttle(ctx.authTimes, 8, () => ctx.host.resetRateLimits())
        const phone = await ctx.helloPhone()
        const { body, state } = wire.createLinkAuthProbe([{ linkId: good.linkId, secret: good.secret }])
        phone.send('auth', body, 'a2')
        await phone.next(m => m.id === 'a2', 6000)         // the real answer is ignored
        const outcome = wire.verifyLinkAuthResult(recorded, state)
        assert.eq(outcome.ok, false, 'recorded auth-result accepted by a new probe')
    })

    await ctx.check('14', 'replayed auth-confirm on a new connection closes it; no session', async () => {
        const first = await ctx.login()
        const confirm = first.phone.sent.at(-1)            // the auth-confirm frame (the last frame the phone sent)
        first.phone.close()
        await ctx.throttle(ctx.authTimes, 8, () => ctx.host.resetRateLimits())
        const phone = await ctx.helloPhone()
        const good = await creds()
        const { body } = wire.createLinkAuthProbe([{ linkId: good.linkId, secret: good.secret }])
        await phone.request('auth', body, 'a3', 6000)
        phone.writeRaw(confirm)
        assert.ok(await phone.closedWithin(3000), 'connection closed')
        assert.ok(!phone.inbox.some(m => m.t === 'session'), 'no session issued')
    })

    await ctx.check('15', 'replayed signed frame (sequence not increasing) closes the connection', async () => {
        const { phone } = await ctx.login()
        const echo = await phone.request('echo', { data: 1 }, 'e1')
        assert.eq(echo.t, 'echo')
        phone.writeRaw(phone.sent.at(-1))                  // exact bytes of the last signed frame
        assert.ok(await phone.closedWithin(3000), 'connection closed after replay')
    })

    await ctx.check('16', 'frame with a bad MAC, and an unsigned frame after authentication, close the connection', async () => {
        for (const mode of ['bad-mac', 'unsigned']) {
            const { phone } = await ctx.login()
            const key = phone.sessionKey
            phone.channel.sessionKey = undefined          // temporarily send unsigned
            if (mode === 'bad-mac') {
                phone.channel.establish(Buffer.alloc(32, 9))
            }
            phone.send('ping', {}, 'p1')
            phone.channel.sessionKey = key
            assert.ok(await phone.closedWithin(3000), `${mode}: connection closed`)
        }
    })

    await ctx.check('17', 'three failed auth probes on one connection close it', async () => {
        const good = await creds()
        await ctx.throttle(ctx.authTimes, 5, () => ctx.host.resetRateLimits())
        const phone = await ctx.helloPhone()
        for (let i = 0; i < 3; i++) {
            const probe = wire.createLinkAuthProbe([{ linkId: good.linkId, secret: Buffer.alloc(32, i + 1).toString('base64url') }])
            const res = await phone.request('auth', probe.body, `f${i}`, 6000).catch(() => undefined)
            if (res)
                assert.deepEq(res.b, { ok: false })
        }
        assert.ok(await phone.closedWithin(3000), 'connection closed')
    })

    await ctx.check('18', 'auth rate limit: more than 10 probes per minute from one peer are refused', async () => {
        if (!ctx.host && !ctx.opts.slow)
            return skip('would lock the remote computer\'s auth budget for a minute; run with --slow')
        ctx.host?.resetRateLimits()
        const good = await creds()
        let closedAt = -1
        for (let i = 0; i < 14 && closedAt < 0; i++) {
            const phone = await ctx.helloPhone()
            const probe = wire.createLinkAuthProbe([{ linkId: good.linkId, secret: Buffer.alloc(32, 5).toString('base64url') }])
            phone.send('auth', probe.body, 'z')
            const answered = await phone.next(m => m.id === 'z', 2500, 'auth-result').then(() => true, () => false)
            if (!answered)
                closedAt = i
            phone.close()
        }
        assert.ok(closedAt >= 0, 'a probe was refused')
        assert.eq(closedAt, 10, `refused exactly after the budget of 10 (first refusal at probe ${closedAt + 1})`)
        ctx.host?.resetRateLimits()
        if (!ctx.host)
            ctx.authTimes.push(...Array(10).fill(Date.now()))
    }, { timeout: 60_000 })
}

module.exports = { run }
