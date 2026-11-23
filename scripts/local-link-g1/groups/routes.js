const fs = require('node:fs')
const { assert, sleep, skip } = require('../lib/harness')
const http = require('../lib/http')

const MB = 1024 * 1024
const WINDOW = MB

/**
 * What the harness knows about the video the checks run on. Shared videos are multi-GB, so the file is
 * never downloaded: three windows of about 1 MB (start, middle, end) are read via Range requests, and
 * every other range is compared against those windows or against ranges seen earlier (overlapping
 * ranges must agree byte for byte).
 */
class Reference {
    constructor(size) {
        this.size = size
        this.windows = []                     // [{start, bytes}]
        this.observed = []                    // [{start, bytes}] ranges verified so far, outside the windows
    }

    static async build(target, handle, token, size) {
        const ref = new Reference(size)
        const win = Math.min(size, WINDOW)
        const starts = [...new Set([0, Math.floor((size - win) / 2), size - win])]
        for (const start of starts) {
            const res = await http.get(target, `/v/${handle}`, { token, timeout: 30_000, headers: { Range: `bytes=${start}-${start + win - 1}` } })
            if (res.error || res.status !== 206 || res.body.length !== win)
                throw new Error(`could not read the ${win} byte window at ${start}: ${res.error?.message ?? `status ${res.status}, ${res.body?.length} bytes`}`)
            ref.windows.push({ start, bytes: res.body })
        }
        return ref
    }

    /** bytes [start, end] when a window covers them, else undefined */
    slice(start, end) {
        const w = this.windows.find(x => start >= x.start && end < x.start + x.bytes.length)
        return w?.bytes.subarray(start - w.start, end - w.start + 1)
    }

    /** Checks the length, then the content against a window or, failing that, against overlapping earlier ranges. */
    verify(body, start, end, what) {
        assert.eq(body.length, end - start + 1, `${what}: length`)
        const expected = this.slice(start, end)
        if (expected) {
            assert.bytesEq(body, expected, what)
            return
        }
        for (const o of this.observed) {
            const from = Math.max(start, o.start)
            const to = Math.min(end, o.start + o.bytes.length - 1)
            if (from <= to)
                assert.bytesEq(body.subarray(from - start, to - start + 1), o.bytes.subarray(from - o.start, to - o.start + 1), `${what}: overlap with an earlier range`)
        }
        this.observed.push({ start, bytes: body })
        if (this.observed.length > 64)
            this.observed.shift()
    }

    /** a body that may stop early (peek): must be an exact prefix of the file starting at `start` */
    verifyPrefix(body, start, what) {
        const len = Math.min(body.length, WINDOW)
        assert.ok(len > 0, `${what}: got data`)
        this.verify(body.subarray(0, len), start, start + len - 1, what)
    }
}

async function run(ctx) {
    ctx.reporter.group('(i)', 'route serving over HTTP')
    const host = ctx.host

    let session, catalog, token, media, subject, big, ref, size
    try {
        ({ session } = await ctx.login())
        ctx.cleanup()
        token = session.mediaToken
        media = await ctx.mediaTarget(session)
        catalog = await ctx.catalog(session)
        const bySize = [...catalog.routes].sort((a, b) => a.size - b.size)
        const byTitle = (t) => catalog.routes.find(r => r.title === t)
        // the checks need one file: the smallest shared video (self-host: the huge sparse fixture, to exercise a multi-GB file)
        subject = host ? byTitle(host.fixtures.titles.huge) : bySize.find(r => r.size >= 4096)
        big = host ? byTitle(host.fixtures.titles.huge) : bySize.at(-1)
        if (!subject)
            throw new Error('the catalog has no usable video')
        const head = await http.get(media, `/v/${subject.videoHandle}`, { token, method: 'HEAD' })
        if (head.error || head.status !== 200)
            throw new Error(`HEAD on the selected video: ${head.error?.message ?? head.status}`)
        size = Number(head.headers['content-length'])
        if (!Number.isInteger(size) || size < 4096 || size !== subject.size)
            throw new Error(`Content-Length ${head.headers['content-length']} does not match the catalog size ${subject.size}`)
        ref = await Reference.build(media, subject.videoHandle, token, size)
        console.log(`  range checks use the smallest shared video: ${size} bytes (${(size / MB).toFixed(1)} MB), read through ${ref.windows.length} windows of ${Math.min(size, WINDOW)} bytes`)
    }
    catch (err) {
        ctx.reporter.record('0', 'set up: session, catalog and reference data', 'FAIL', err.stack ?? String(err))
        return
    }

    const get = (path, opts = {}) => http.get(media, path, { token, ...opts })
    const peek = (path, opts = {}) => http.peek(media, path, { token, ...opts })
    const v = (e = subject) => `/v/${e.videoHandle}`
    const range = (e, spec, extra = {}) => get(v(e), { headers: { Range: `bytes=${spec}`, ...extra } })
    const mid = ref.windows[1].start
    const lastWindow = Math.min(size, 1000)
    const ok = (res, what) => { assert.ok(!res.error, `${what}: ${res.error?.message}`); return res }
    const validators = async () => {
        const head = ok(await get(v(), { method: 'HEAD' }), 'HEAD')
        assert.eq(head.status, 200, 'HEAD status')
        assert.ok(head.headers.etag, 'HEAD returned an ETag')
        assert.ok(head.headers['last-modified'], 'HEAD returned a Last-Modified')
        return { etag: head.headers.etag, lastModified: head.headers['last-modified'] }
    }

    await ctx.check('1', 'catalog: session.catalogVersion matches the GET /catalog document; entries carry handles and sizes', async () => {
        assert.eq(catalog.catalogVersion, session.catalogVersion)
        assert.ok(catalog.routes.length > 0, 'routes')
        for (const r of catalog.routes) {
            assert.match(r.videoHandle, /^[A-Za-z0-9_-]{1,128}$/, 'videoHandle')
            assert.ok(Number.isInteger(r.size) && r.size >= 0, 'size')
            assert.ok(!JSON.stringify(r).includes('/'), `entry for ${r.title} exposes no file path`)
        }
        const res = ok(await get('/catalog'), 'GET /catalog')
        assert.match(res.headers['content-type'], /^application\/json/)
        assert.eq(res.headers['cache-control'], 'no-store')
        assert.ok(res.headers.etag, 'etag')
        if (host) {
            assert.eq(subject.size, fs.statSync(host.fixtures.files.huge).size, 'size of the huge fixture')
            assert.ok(subject.size > 2 ** 32, 'the fixture is above 4 GiB')
            assert.ok(catalog.routes.find(r => r.title === host.fixtures.titles.small).thumbHandle, 'thumbnail handle')
            assert.eq(catalog.routes.length, 3)
        }
    })

    await ctx.check('2', 'every request needs a valid token: none/garbage -> 401; Bearer header and ?t= both accepted', async () => {
        for (const path of ['/catalog', v(), '/', '/nonsense'])
            assert.eq((await http.get(media, path)).status, 401, `${path} without token`)
        const bad = await http.get(media, '/catalog', { token: 'not-a-token' })
        assert.eq(bad.status, 401)
        assert.match(bad.headers['www-authenticate'] ?? '', /Bearer/i)
        assert.eq((await http.get(media, '/catalog', { token, auth: 'bearer' })).status, 200, 'Bearer')
        assert.eq((await http.get(media, '/catalog', { token })).status, 200, '?t=')
        assert.eq((await http.get(media, '/catalog', { token: token + 'x' })).status, 401, 'altered token')
    })

    await ctx.check('3', 'unknown paths and handles -> 404 without a body; path traversal and bad methods rejected', async () => {
        for (const path of ['/nope', '/v/AAAAAAAAAAAAAAAAAAAAAA', '/t/AAAAAAAAAAAAAAAAAAAAAA', '/v/..%2f..%2fetc%2fpasswd', '/v/../../etc/passwd', '/v/', '/catalog/x']) {
            const res = ok(await get(path), path)
            assert.eq(res.status, 404, path)
            assert.eq(res.body.length, 0, `${path} body`)
        }
        assert.eq((await get('/catalog', { method: 'POST' })).status, 405, 'POST')
        assert.eq((await get(v(), { method: 'DELETE' })).status, 405, 'DELETE')
        const rawReply = (await http.raw(media, `GET /v/${subject.videoHandle}?t=${token} HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n`)).toString()
        assert.ok(rawReply === '' || /^HTTP\/1\.1 400/.test(rawReply), 'malformed request answered 400 or dropped')
    })

    await ctx.check('4', 'HEAD and GET: 200, Accept-Ranges, Content-Length, ETag, Last-Modified, Content-Type; GET prefix is the start of the file', async () => {
        const head = ok(await get(v(), { method: 'HEAD' }), 'HEAD')
        assert.eq(head.status, 200)
        assert.eq(head.body.length, 0)
        assert.eq(head.headers['content-length'], String(size))
        assert.eq(head.headers['accept-ranges'], 'bytes')
        assert.ok(head.headers.etag, 'ETag')
        assert.ok(head.headers['last-modified'], 'Last-Modified')
        assert.match(head.headers['content-type'], /^video\//)
        // a plain GET streams the whole file: read the first MB and drop the connection
        const full = ok(await peek(v(), { maxBytes: WINDOW }), 'GET prefix')
        assert.eq(full.status, 200)
        assert.eq(full.headers['content-length'], String(size), 'GET Content-Length')
        assert.eq(full.headers['accept-ranges'], 'bytes')
        ref.verifyPrefix(full.body, 0, 'start of the full body')
    })

    await ctx.check('5', 'Range: closed range -> 206 with exact Content-Range and bytes', async () => {
        const res = ok(await range(subject, '0-99'), 'range')
        assert.eq(res.status, 206)
        assert.eq(res.headers['content-range'], `bytes 0-99/${size}`)
        ref.verify(res.body, 0, 99, 'first 100 bytes')
        const inner = ok(await range(subject, '1000-1999'), 'range')
        assert.eq(inner.headers['content-range'], `bytes 1000-1999/${size}`)
        ref.verify(inner.body, 1000, 1999, 'bytes 1000-1999')
        const m = ok(await range(subject, `${mid}-${mid + 4095}`), 'range')
        assert.eq(m.headers['content-range'], `bytes ${mid}-${mid + 4095}/${size}`)
        ref.verify(m.body, mid, mid + 4095, 'bytes from the middle')
    })

    await ctx.check('6', 'Range: open-ended (N-) streams to the end of the file', async () => {
        const from = size - lastWindow
        const res = ok(await peek(v(), { headers: { Range: `bytes=${from}-` }, maxBytes: 2 * lastWindow }), 'open-ended tail')
        assert.eq(res.status, 206)
        assert.eq(res.headers['content-range'], `bytes ${from}-${size - 1}/${size}`)
        assert.eq(res.headers['content-length'], String(size - from))
        ref.verify(res.body, from, size - 1, 'tail via open-ended range')
        const head = ok(await peek(v(), { headers: { Range: 'bytes=100-' }, maxBytes: 4096 }), 'open-ended 100-')
        assert.eq(head.headers['content-range'], `bytes 100-${size - 1}/${size}`)
        assert.eq(head.headers['content-length'], String(size - 100))
        ref.verifyPrefix(head.body, 100, 'bytes from 100 via open-ended range')
        const fromMid = ok(await peek(v(), { headers: { Range: `bytes=${mid}-` }, maxBytes: WINDOW }), 'open-ended from the middle')
        assert.eq(fromMid.headers['content-range'], `bytes ${mid}-${size - 1}/${size}`)
        ref.verifyPrefix(fromMid.body, mid, 'first MB from the middle via open-ended range')
    })

    await ctx.check('7', 'Range: suffix (-N) returns the last N bytes; larger than the file -> whole file; -0 -> 416', async () => {
        const res = ok(await range(subject, '-50'), 'suffix')
        assert.eq(res.status, 206)
        assert.eq(res.headers['content-range'], `bytes ${size - 50}-${size - 1}/${size}`)
        ref.verify(res.body, size - 50, size - 1, 'last 50 bytes')
        const huge = ok(await peek(v(), { headers: { Range: 'bytes=-999999999999' }, maxBytes: 4096 }), 'oversized suffix')
        assert.eq(huge.status, 206)
        assert.eq(huge.headers['content-range'], `bytes 0-${size - 1}/${size}`)
        ref.verifyPrefix(huge.body, 0, 'start of the whole-file suffix')
        assert.eq((await range(subject, '-0')).status, 416, '-0')
    })

    await ctx.check('8', 'Range: end beyond the file is clamped', async () => {
        const res = ok(await range(subject, `${size - 10}-${size + 5000}`), 'range')
        assert.eq(res.status, 206)
        assert.eq(res.headers['content-range'], `bytes ${size - 10}-${size - 1}/${size}`)
        ref.verify(res.body, size - 10, size - 1, 'clamped tail')
    })

    await ctx.check('9', 'multi-seek: successive Range requests across the file are exact and repeatable; overlapping ranges agree', async () => {
        const offsets = [0, Math.floor(size * 0.25), mid, Math.floor(size * 0.75), size - 4096]
        for (const off of [...offsets, ...offsets.slice().reverse()]) {
            const end = Math.min(off + 4095, size - 1)
            const res = ok(await range(subject, `${off}-${end}`), `seek to ${off}`)
            assert.eq(res.status, 206, `seek to ${off}`)
            assert.eq(res.headers['content-range'], `bytes ${off}-${end}/${size}`)
            ref.verify(res.body, off, end, `seek to ${off}`)
        }
        const a = ok(await range(subject, `${mid}-${mid + 999}`), 'range')
        const b = ok(await range(subject, `${mid}-${mid + 999}`), 'range')
        assert.bytesEq(a.body, b.body, 'same range twice')
        const q = offsets[1]
        const left = ok(await range(subject, `${q - 500}-${q + 499}`), 'overlap left')
        const right = ok(await range(subject, `${q}-${q + 999}`), 'overlap right')
        assert.bytesEq(left.body.subarray(500), right.body.subarray(0, 500), 'overlapping ranges agree byte for byte')
    })

    await ctx.check('10', 'Range: several ranges in one request -> 206 multipart/byteranges', async () => {
        const spec = `0-9,100-109,${mid}-${mid + 9},${size - 10}-${size - 1}`
        const res = ok(await range(subject, spec), 'multi-range')
        assert.eq(res.status, 206)
        assert.match(res.headers['content-type'], /^multipart\/byteranges; boundary=/)
        const parts = http.parseMultipart(res.body, res.headers['content-type'])
        assert.deepEq(parts.map(p => [p.start, p.end, p.size]), [[0, 9, size], [100, 109, size], [mid, mid + 9, size], [size - 10, size - 1, size]])
        parts.forEach(p => ref.verify(p.body, p.start, p.end, `part ${p.start}`))
        assert.eq(res.headers['content-length'], String(res.body.length), 'multipart Content-Length')
    })

    await ctx.check('11', 'Range: unsatisfiable -> 416 with Content-Range bytes */size; malformed range -> whole file', async () => {
        for (const spec of [`${size}-`, `${size + 100}-`, `${size + 10}-${size + 20}`]) {
            const res = ok(await range(subject, spec), spec)
            assert.eq(res.status, 416, spec)
            assert.eq(res.headers['content-range'], `bytes */${size}`, spec)
        }
        for (const spec of ['abc', '5-1', '-']) {
            const res = ok(await peek(v(), { headers: { Range: `bytes=${spec}` }, maxBytes: 1024 }), spec)
            assert.eq(res.status, 200, `malformed ${spec}`)
            ref.verifyPrefix(res.body, 0, `whole file for malformed ${spec}`)
        }
        const other = ok(await peek(v(), { headers: { Range: 'items=0-5' }, maxBytes: 1024 }), 'items')
        assert.eq(other.status, 200, 'non-byte unit ignored')
    })

    await ctx.check('12', 'If-Range: matching ETag / Last-Modified -> 206; stale or weak validator -> 200 whole file', async () => {
        const { etag, lastModified } = await validators()
        const withValidator = async (validator) => ok(await peek(v(), { headers: { Range: 'bytes=0-9', 'If-Range': validator }, maxBytes: 1024 }), `If-Range ${validator}`)
        const matching = await withValidator(etag)
        assert.eq(matching.status, 206, 'matching ETag')
        ref.verify(matching.body, 0, 9, 'If-Range match body')
        assert.eq((await withValidator(lastModified)).status, 206, 'matching Last-Modified')
        const stale = await withValidator('"stale-etag"')
        assert.eq(stale.status, 200, 'stale ETag')
        assert.eq(stale.headers['content-length'], String(size))
        assert.eq((await withValidator(`W/${etag}`)).status, 200, 'weak ETag never matches If-Range')
        assert.eq((await withValidator(new Date(Date.parse(lastModified) - 86_400_000).toUTCString())).status, 200, 'different date')
    })

    await ctx.check('13', 'conditional requests: If-None-Match -> 304 without body', async () => {
        const { etag } = await validators()
        const res = ok(await get(v(), { headers: { 'If-None-Match': etag } }), 'If-None-Match')
        assert.eq(res.status, 304)
        assert.eq(res.body.length, 0)
        const other = ok(await peek(v(), { headers: { 'If-None-Match': '"other"' }, maxBytes: 1024 }), 'other ETag')
        assert.eq(other.status, 200, 'different ETag')
    })

    await ctx.check('14', 'thumbnails: GET /t/<handle> serves the image; HEAD is not allowed', async () => {
        const entry = catalog.routes.find(r => r.thumbHandle)
        if (!entry)
            return skip('no route with a thumbnail in the catalog')
        const res = ok(await get(`/t/${entry.thumbHandle}`), 'GET thumbnail')
        assert.eq(res.status, 200)
        assert.match(res.headers['content-type'], /^image\//)
        assert.ok(res.body.length > 0)
        assert.eq((await get(`/t/${entry.thumbHandle}`, { method: 'HEAD' })).status, 405, 'HEAD /t')
    })

    await ctx.check('15', '404 = unknown handle, 410 = file gone (removed / unmounted)', async () => {
        assert.eq((await get('/v/AAAAAAAAAAAAAAAAAAAAAA')).status, 404)
        let goneEntry
        if (host) {
            goneEntry = catalog.routes.find(r => r.title === host.fixtures.titles.gone)
            assert.eq((await get(v(goneEntry), { method: 'HEAD' })).status, 200, 'present before removal')
            fs.unlinkSync(host.fixtures.files.gone)
        }
        else {
            await ctx.step('rename (or unmount the drive of) the video file of ONE shared route so it disappears, then continue')
            for (const r of catalog.routes) {
                if ((await get(v(r), { method: 'HEAD' })).status === 410) {
                    goneEntry = r
                    break
                }
            }
            assert.ok(goneEntry, 'one of the handles answers 410 now')
        }
        const res = ok(await get(v(goneEntry)), 'GET of the gone file')
        assert.eq(res.status, 410)
        assert.eq(res.body.length, 0)
        assert.eq((await get('/v/AAAAAAAAAAAAAAAAAAAAAA')).status, 404, 'unknown handle is still 404')
    })

    await ctx.check('16', 'stream limits: per-peer connections cap at 8 (default); with a higher cap the 9th stream gets 503 + Retry-After', async () => {
        if (!big || big.size < 24 * MB)
            return skip('needs a video of at least 24 MB so that streams stay in flight')
        const open = []
        try {
            for (let i = 0; i < 8; i++)
                open.push(await http.openStream(media, v(big), { token, headers: { Range: 'bytes=0-' } }))
            assert.ok(open.every(s => s.res.statusCode === 206), '8 streams open')
            const ninth = await http.get(media, '/catalog', { token, timeout: 2500 })
            assert.ok(ninth.error || ninth.status === 503, `9th connection from the same peer: ${ninth.status ?? ninth.error?.message}`)
            if (host) {
                await host.setLimits(undefined, { maxConnections: 64, maxPerPeer: 16, maxConcurrentStreams: 8 })
                const res = await http.get(media, v(big), { token, headers: { Range: 'bytes=0-9' } })
                assert.eq(res.status, 503, '9th stream')
                assert.eq(res.headers['retry-after'], '1')
                assert.eq((await http.get(media, '/catalog', { token })).status, 200, 'documents are not streams')
            }
        }
        finally {
            open.forEach(s => s.destroy())
            await host?.restoreLimits()
            await sleep(500)                              // the app notices the dropped sockets before the next check
        }
    })

    await ctx.check('18', 'revoke: in-flight stream aborts, media token -> 401, control connection closed, next auth -> ok:false; harness credentials still valid', async () => {
        if (!big || big.size < 24 * MB)
            return skip('needs a video of at least 24 MB so that the stream stays in flight')
        await ctx.ensurePairingOpen()                       // keeps the transport up when the last phone is removed
        await ctx.ensureCreds()                             // the harness' own credentials, which this check must leave intact
        const victim = await ctx.pairNew('G1 revoke', { keep: false })
        let stream
        try {
            const { phone, session: s2 } = await ctx.login(victim)
            stream = await http.openStream(media, v(big), { token: s2.mediaToken, headers: { Range: 'bytes=0-' } })
            assert.eq(stream.res.statusCode, 206)
            await sleep(300)
            const mark = host?.mark()
            await ctx.step('remove the paired phone "G1 revoke" from the paired-device list in the app',
                async () => { await host.service.removeClient(host.clients().find(c => c.secret === victim.secret).clientId) })
            stream.res.resume()
            const outcome = await stream.done
            assert.ok(!outcome.ok, 'in-flight stream was aborted')
            assert.ok(outcome.bytes < big.size, `stream cut short after ${outcome.bytes} bytes`)
            assert.ok(await phone.closedWithin(3000), 'control connection closed')
            const next = await http.get(media, '/catalog', { token: s2.mediaToken })
            assert.eq(next.status, 401, 'next media request')
            if (host) {
                const closed = host.eventsSince(mark).find(e => e.type === 'connection-closed' && e.reason === 'revoked')
                assert.ok(closed, 'transport reports reason revoked')
            }
            await sleep(300)
            const probe = await ctx.helloPhone()
            const res = await probe.authenticate([{ linkId: victim.linkId, secret: victim.secret }])
            assert.eq(res.ok, false, 'auth with the revoked secret')
            assert.deepEq(probe.lastAuthResult.b, { ok: false })
            // the harness' own phone is untouched: later groups still have their session
            const own = await ctx.login()
            assert.ok(own.session.mediaToken, 'harness credentials still authenticate')
        }
        finally {
            stream?.destroy()
        }
    }, { timeout: 120_000 })
}

module.exports = { run }
