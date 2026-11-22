const fs = require('node:fs')
const { assert, sleep, skip } = require('../lib/harness')
const http = require('../lib/http')

const MB = 1024 * 1024

/** What the harness knows about one shared video: from the local file (self-host) or from windows fetched over HTTP. */
class Reference {
    constructor(entry, buffer) {
        this.entry = entry
        this.size = entry.size
        this.buffer = buffer                  // whole file, when available
        this.windows = []                     // [{start, bytes}] fetched over HTTP
    }

    static async build(ctx, entry, session, localPath) {
        if (localPath)
            return new Reference(entry, fs.readFileSync(localPath))
        const ref = new Reference(entry)
        const t = await ctx.mediaTarget(session)
        const win = Math.min(entry.size, 256 * 1024)
        const head = await http.get(t, `/v/${entry.videoHandle}`, { token: session.mediaToken, headers: { Range: `bytes=0-${win - 1}` } })
        const tail = await http.get(t, `/v/${entry.videoHandle}`, { token: session.mediaToken, headers: { Range: `bytes=-${win}` } })
        ref.windows.push({ start: 0, bytes: head.body }, { start: entry.size - win, bytes: tail.body })
        return ref
    }

    /** bytes [start, end] when known, else undefined */
    slice(start, end) {
        if (this.buffer)
            return this.buffer.subarray(start, end + 1)
        const w = this.windows.find(x => start >= x.start && end < x.start + x.bytes.length)
        return w?.bytes.subarray(start - w.start, end - w.start + 1)
    }

    /** compares when the reference can supply the bytes, always checks the length */
    verify(body, start, end, what) {
        assert.eq(body.length, end - start + 1, `${what}: length`)
        const expected = this.slice(start, end)
        if (expected)
            assert.bytesEq(body, expected, what)
    }
}

const sizeOf = (r) => r.size

async function run(ctx) {
    ctx.reporter.group('(i)', 'route serving over HTTP')
    const host = ctx.host

    let session, catalog, token, media, small, big, ref, bigRef
    try {
        ({ session } = await ctx.login())
        ctx.cleanup()
        token = session.mediaToken
        media = await ctx.mediaTarget(session)
        catalog = await ctx.catalog(session)
        const bySize = [...catalog.routes].sort((a, b) => sizeOf(a) - sizeOf(b))
        const byTitle = (t) => catalog.routes.find(r => r.title === t)
        small = host ? byTitle(host.fixtures.titles.small) : bySize.find(r => r.size >= 4096)
        big = host ? byTitle(host.fixtures.titles.big) : bySize.at(-1)
        if (!small)
            throw new Error('the catalog has no usable video')
        ref = await Reference.build(ctx, small, session, host?.fixtures.files.small)
        bigRef = big ? await Reference.build(ctx, big, session, host?.fixtures.files.big) : undefined
    }
    catch (err) {
        ctx.reporter.record('0', 'set up: session, catalog and reference data', 'FAIL', err.stack ?? String(err))
        return
    }

    const get = (path, opts = {}) => http.get(media, path, { token, ...opts })
    const v = (e = small) => `/v/${e.videoHandle}`
    const range = (e, spec, extra = {}) => get(v(e), { headers: { Range: `bytes=${spec}`, ...extra } })
    const size = small.size
    const lastWindow = Math.min(size, 1000)

    await ctx.check('1', 'catalog: session.catalogVersion matches the GET /catalog document; entries carry handles and sizes', async () => {
        assert.eq(catalog.catalogVersion, session.catalogVersion)
        assert.ok(catalog.routes.length > 0, 'routes')
        for (const r of catalog.routes) {
            assert.match(r.videoHandle, /^[A-Za-z0-9_-]{1,128}$/, 'videoHandle')
            assert.ok(Number.isInteger(r.size) && r.size >= 0, 'size')
            assert.ok(!JSON.stringify(r).includes('/'), `entry for ${r.title} exposes no file path`)
        }
        const res = await get('/catalog')
        assert.match(res.headers['content-type'], /^application\/json/)
        assert.eq(res.headers['cache-control'], 'no-store')
        assert.ok(res.headers.etag, 'etag')
        if (host) {
            assert.eq(small.size, host.fixtures.files && fs.statSync(host.fixtures.files.small).size, 'size of the small fixture')
            assert.ok(small.thumbHandle, 'thumbnail handle')
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
            const res = await get(path)
            assert.eq(res.status, 404, path)
            assert.eq(res.body.length, 0, `${path} body`)
        }
        assert.eq((await get('/catalog', { method: 'POST' })).status, 405, 'POST')
        assert.eq((await get(v(), { method: 'DELETE' })).status, 405, 'DELETE')
        const rawReply = (await http.raw(media, `GET /v/${small.videoHandle}?t=${token} HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n`)).toString()
        assert.ok(rawReply === '' || /^HTTP\/1\.1 400/.test(rawReply), 'malformed request answered 400 or dropped')
    })

    await ctx.check('4', 'HEAD and full GET: 200, Accept-Ranges, Content-Length, ETag, Last-Modified, Content-Type', async () => {
        const head = await get(v(), { method: 'HEAD' })
        assert.eq(head.status, 200)
        assert.eq(head.body.length, 0)
        assert.eq(head.headers['content-length'], String(size))
        assert.eq(head.headers['accept-ranges'], 'bytes')
        assert.ok(head.headers.etag && head.headers['last-modified'])
        assert.match(head.headers['content-type'], /^video\//)
        if (size <= 5 * MB) {
            const full = await get(v())
            assert.eq(full.status, 200)
            ref.verify(full.body, 0, size - 1, 'full body')
        }
    })

    await ctx.check('5', 'Range: closed range -> 206 with exact Content-Range and bytes', async () => {
        const res = await range(small, '0-99')
        assert.eq(res.status, 206)
        assert.eq(res.headers['content-range'], `bytes 0-99/${size}`)
        ref.verify(res.body, 0, 99, 'first 100 bytes')
        const mid = await range(small, '1000-1999')
        assert.eq(mid.headers['content-range'], `bytes 1000-1999/${size}`)
        ref.verify(mid.body, 1000, 1999, 'bytes 1000-1999')
    })

    await ctx.check('6', 'Range: open-ended (N-) streams to the end of the file', async () => {
        const from = Math.max(0, size - lastWindow)
        const res = await http.peek(media, v(), { token, headers: { Range: `bytes=${from}-` }, maxBytes: 2 * lastWindow })
        assert.eq(res.status, 206)
        assert.eq(res.headers['content-range'], `bytes ${from}-${size - 1}/${size}`)
        assert.eq(res.headers['content-length'], String(size - from))
        ref.verify(res.body, from, size - 1, 'tail via open-ended range')
        const head = await http.peek(media, v(), { token, headers: { Range: 'bytes=100-' }, maxBytes: 4096 })
        assert.eq(head.headers['content-range'], `bytes 100-${size - 1}/${size}`)
    })

    await ctx.check('7', 'Range: suffix (-N) returns the last N bytes; larger than the file -> whole file; -0 -> 416', async () => {
        const res = await range(small, '-50')
        assert.eq(res.status, 206)
        assert.eq(res.headers['content-range'], `bytes ${size - 50}-${size - 1}/${size}`)
        ref.verify(res.body, size - 50, size - 1, 'last 50 bytes')
        const huge = await http.peek(media, v(), { token, headers: { Range: 'bytes=-999999999999' }, maxBytes: 4096 })
        assert.eq(huge.status, 206)
        assert.eq(huge.headers['content-range'], `bytes 0-${size - 1}/${size}`)
        assert.eq((await range(small, '-0')).status, 416, '-0')
    })

    await ctx.check('8', 'Range: end beyond the file is clamped', async () => {
        const res = await range(small, `${size - 10}-${size + 5000}`)
        assert.eq(res.status, 206)
        assert.eq(res.headers['content-range'], `bytes ${size - 10}-${size - 1}/${size}`)
        ref.verify(res.body, size - 10, size - 1, 'clamped tail')
    })

    await ctx.check('9', 'multi-seek: successive Range requests across the file are exact and repeatable', async () => {
        const offsets = [0, Math.floor(size * 0.25), Math.floor(size * 0.5), Math.floor(size * 0.75), size - 4096]
        for (const off of [...offsets, ...offsets.slice().reverse()]) {
            const end = Math.min(off + 4095, size - 1)
            const res = await range(small, `${off}-${end}`)
            assert.eq(res.status, 206, `seek to ${off}`)
            assert.eq(res.headers['content-range'], `bytes ${off}-${end}/${size}`)
            ref.verify(res.body, off, end, `seek to ${off}`)
        }
        const a = await range(small, `${offsets[2]}-${offsets[2] + 999}`)
        const b = await range(small, `${offsets[2]}-${offsets[2] + 999}`)
        assert.bytesEq(a.body, b.body, 'same range twice')
    })

    await ctx.check('10', 'Range: several ranges in one request -> 206 multipart/byteranges', async () => {
        const res = await range(small, '0-9,100-109,1000-1009')
        assert.eq(res.status, 206)
        assert.match(res.headers['content-type'], /^multipart\/byteranges; boundary=/)
        const parts = http.parseMultipart(res.body, res.headers['content-type'])
        assert.deepEq(parts.map(p => [p.start, p.end, p.size]), [[0, 9, size], [100, 109, size], [1000, 1009, size]])
        parts.forEach(p => ref.verify(p.body, p.start, p.end, `part ${p.start}`))
        assert.eq(res.headers['content-length'], String(res.body.length), 'multipart Content-Length')
    })

    await ctx.check('11', 'Range: unsatisfiable -> 416 with Content-Range bytes */size; malformed range -> whole file', async () => {
        for (const spec of [`${size}-`, `${size + 100}-`, `${size + 10}-${size + 20}`]) {
            const res = await range(small, spec)
            assert.eq(res.status, 416, spec)
            assert.eq(res.headers['content-range'], `bytes */${size}`, spec)
        }
        for (const spec of ['abc', '5-1', '-']) {
            const res = await http.peek(media, v(), { token, headers: { Range: `bytes=${spec}` }, maxBytes: 1024 })
            assert.eq(res.status, 200, `malformed ${spec}`)
        }
        const other = await http.peek(media, v(), { token, headers: { Range: 'items=0-5' }, maxBytes: 1024 })
        assert.eq(other.status, 200, 'non-byte unit ignored')
    })

    await ctx.check('12', 'If-Range: matching ETag / Last-Modified -> 206; stale or weak validator -> 200 whole file', async () => {
        const head = await get(v(), { method: 'HEAD' })
        const { etag } = head.headers
        const lastModified = head.headers['last-modified']
        const peek = (validator) => http.peek(media, v(), { token, headers: { Range: 'bytes=0-9', 'If-Range': validator }, maxBytes: 1024 })
        assert.eq((await peek(etag)).status, 206, 'matching ETag')
        assert.eq((await peek(lastModified)).status, 206, 'matching Last-Modified')
        const stale = await peek('"stale-etag"')
        assert.eq(stale.status, 200, 'stale ETag')
        assert.eq(stale.headers['content-length'], String(size))
        assert.eq((await peek(`W/${etag}`)).status, 200, 'weak ETag never matches If-Range')
        assert.eq((await peek(new Date(Date.parse(lastModified) - 86_400_000).toUTCString())).status, 200, 'different date')
    })

    await ctx.check('13', 'conditional requests: If-None-Match -> 304 without body', async () => {
        const { etag } = (await get(v(), { method: 'HEAD' })).headers
        const res = await get(v(), { headers: { 'If-None-Match': etag } })
        assert.eq(res.status, 304)
        assert.eq(res.body.length, 0)
        const other = await get(v(), { headers: { 'If-None-Match': '"other"' } })
        assert.eq(other.status, 200, 'different ETag')
    })

    await ctx.check('14', 'thumbnails: GET /t/<handle> serves the image; HEAD is not allowed', async () => {
        const entry = catalog.routes.find(r => r.thumbHandle)
        if (!entry)
            return skip('no route with a thumbnail in the catalog')
        const res = await get(`/t/${entry.thumbHandle}`)
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
        const res = await get(v(goneEntry))
        assert.eq(res.status, 410)
        assert.eq(res.body.length, 0)
        assert.eq((await get('/v/AAAAAAAAAAAAAAAAAAAAAA')).status, 404, 'unknown handle is still 404')
    })

    await ctx.check('16', 'stream limits: per-peer connections cap at 8 (default); with a higher cap the 9th stream gets 503 + Retry-After', async () => {
        if (!bigRef || big.size < 24 * MB)
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
            open.forEach(s => s.req.destroy())
            await host?.restoreLimits()
            await sleep(300)
        }
    })

    await ctx.check('17', 'renderer reload mid-stream: the stream completes, control connection closes, token stays valid', async () => {
        if (!bigRef || big.size < 24 * MB)
            return skip('needs a video of at least 24 MB so that the stream stays in flight')
        const { phone, session: s2 } = await ctx.login()
        const length = Math.min(big.size, 40 * MB)
        const stream = await http.openStream(media, v(big), { token: s2.mediaToken, headers: { Range: `bytes=0-${length - 1}` } })
        await sleep(300)
        await ctx.step('reload the app window (Ctrl+R) in the running dev app; the harness holds a media stream open meanwhile', async () => host.rendererReload())
        assert.ok(await phone.closedWithin(host ? 3000 : 60_000), 'control connection closed by the reload')
        stream.res.resume()
        const outcome = await stream.done
        assert.ok(outcome.ok, `stream finished: ${outcome.error?.message}`)
        assert.eq(outcome.bytes, length, 'every byte delivered after the reload')
        const again = await http.get(media, '/catalog', { token: s2.mediaToken })
        assert.eq(again.status, 200, 'media token still valid after the reload')
    }, { timeout: 120_000 })

    await ctx.check('18', 'revoke: in-flight stream aborts, media token -> 401, control connection closed, next auth -> ok:false', async () => {
        if (!bigRef || big.size < 24 * MB)
            return skip('needs a video of at least 24 MB so that the stream stays in flight')
        await ctx.ensurePairingOpen()                       // keeps the transport up when the last phone is removed
        const creds = await ctx.ensureCreds()
        const { phone, session: s2 } = await ctx.login(creds)
        const stream = await http.openStream(media, v(big), { token: s2.mediaToken, headers: { Range: 'bytes=0-' } })
        assert.eq(stream.res.statusCode, 206)
        await sleep(300)
        const mark = host?.mark()
        await ctx.step('remove the paired phone "G1 harness" from the paired-device list in the app',
            async () => { await host.service.removeClient(host.clients().find(c => c.secret === creds.secret).clientId) })
        stream.res.resume()
        const outcome = await stream.done
        assert.ok(!outcome.ok, 'in-flight stream was aborted')
        assert.ok(outcome.bytes < 40 * MB, `stream cut short after ${outcome.bytes} bytes`)
        assert.ok(await phone.closedWithin(3000), 'control connection closed')
        const next = await http.get(media, '/catalog', { token: s2.mediaToken })
        assert.eq(next.status, 401, 'next media request')
        if (host) {
            const closed = host.eventsSince(mark).find(e => e.type === 'connection-closed' && e.reason === 'revoked')
            assert.ok(closed, 'transport reports reason revoked')
        }
        await sleep(300)
        const probe = await ctx.helloPhone()
        const res = await probe.authenticate([{ linkId: creds.linkId, secret: creds.secret }])
        assert.eq(res.ok, false, 'auth with the revoked secret')
        assert.deepEq(probe.lastAuthResult.b, { ok: false })
        ctx.setCreds(undefined)
    }, { timeout: 120_000 })
}

module.exports = { run }
