const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { MediaServer, parseRange } = require('./media-server')
const { PeerFilter } = require('./peer-filter')

const digestOf = (token) => crypto.createHash('sha256').update(token).digest('base64url')
const TOKEN = 'token-one'
const OTHER_TOKEN = 'token-two'
const FILE_SIZE = 1000

const request = (port, urlPath, { method = 'GET', headers = {}, token = TOKEN } = {}) => new Promise((resolve, reject) => {
    const h = { ...headers }
    if (token && !h.Authorization)
        h.Authorization = `Bearer ${token}`
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h, agent: false }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
})

describe('MediaServer', () => {
    let dir, server, events, port, content, filePath, bigPath

    const publish = (extra = {}) => server.publish({
        documents: { catalog: { body: { routes: [1, 2] } } },
        handles: [{ handle: 'abc123', path: filePath }],
        tokens: [{ digest: digestOf(TOKEN), id: 'tok-1' }],
        ...extra,
    })

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-link-media-'))
        content = Buffer.alloc(FILE_SIZE)
        for (let i = 0; i < FILE_SIZE; i++)
            content[i] = i % 251
        filePath = path.join(dir, 'video.mp4')
        fs.writeFileSync(filePath, content)
        bigPath = path.join(dir, 'big.mp4')
        fs.writeFileSync(bigPath, Buffer.alloc(64 * 1024 * 1024, 7))
    })

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    beforeEach(async () => {
        events = []
        server = new MediaServer({ emit: e => events.push(e), peerFilter: new PeerFilter({ flushIntervalMs: 100000 }) })
        const res = await server.start({ port: 0, host: '127.0.0.1' })
        port = res.port
        publish()
    })

    afterEach(async () => {
        await server.stop()
    })

    describe('lifecycle', () => {
        test('start reports port, is idempotent and emits started', async () => {
            expect(port).toBeGreaterThan(0)
            expect(events).toContainEqual({ type: 'started', listener: 'media', port })
            expect(await server.start({ port: 0, host: '127.0.0.1' })).toEqual({ ok: true, port, alreadyRunning: true })
        })

        test('EADDRINUSE is reported per listener', async () => {
            const other = new MediaServer({ emit: e => events.push(e), peerFilter: new PeerFilter() })
            const res = await other.start({ port, host: '127.0.0.1' })
            expect(res).toEqual({ ok: false, error: { code: 'EADDRINUSE' } })
            expect(other.isRunning()).toBe(false)
            expect(events).toContainEqual({ type: 'error', listener: 'media', phase: 'listen', code: 'EADDRINUSE' })
        })

        test('invalid port is rejected', async () => {
            const other = new MediaServer({ emit: () => {}, peerFilter: new PeerFilter() })
            expect(await other.start({ port: 70000 })).toEqual({ ok: false, error: { code: 'EINVAL' } })
        })

        test('stop clears state and emits stopped', async () => {
            await server.stop()
            expect(events).toContainEqual({ type: 'stopped', listener: 'media' })
            expect(server.isRunning()).toBe(false)
            expect(server.getStats()).toEqual({ handleCount: 0, tokenCount: 0 })
            await expect(request(port, '/catalog')).rejects.toBeDefined()
        })
    })

    describe('authentication', () => {
        test('every path needs a token, including unknown ones', async () => {
            for (const p of ['/catalog', '/v/abc123', '/t/abc123', '/nothing', '/']) {
                const res = await request(port, p, { token: null })
                expect(res.status).toBe(401)
                expect(res.body.length).toBe(0)
            }
        })

        test('invalid token is refused', async () => {
            const res = await request(port, '/catalog', { token: 'wrong' })
            expect(res.status).toBe(401)
        })

        test('Bearer header and ?t= both work', async () => {
            expect((await request(port, '/catalog')).status).toBe(200)
            expect((await request(port, `/catalog?t=${TOKEN}`, { token: null })).status).toBe(200)
        })

        test('a malformed Authorization header does not fall back to ?t=', async () => {
            const res = await request(port, `/catalog?t=${TOKEN}`, { token: null, headers: { Authorization: 'Basic abc' } })
            expect(res.status).toBe(401)
        })

        test('oversized token is refused', async () => {
            const res = await request(port, '/catalog', { token: 'x'.repeat(5000) })
            expect(res.status).toBe(401)
        })

        test('non GET/HEAD methods are refused after authentication', async () => {
            expect((await request(port, '/catalog', { method: 'POST' })).status).toBe(405)
            expect((await request(port, '/catalog', { method: 'POST', token: null })).status).toBe(401)
        })
    })

    describe('routing', () => {
        test('unknown path is 404 with no body', async () => {
            for (const p of ['/nothing', '/', '/v', '/v/', '/x/abc123', '/catalog/', '/catalog/extra', '/Catalog', '/v/abc123/more']) {
                const res = await request(port, p)
                expect(res.status).toBe(404)
                expect(res.body.length).toBe(0)
            }
        })

        test('unknown handle is 404', async () => {
            expect((await request(port, '/v/unknown')).status).toBe(404)
            expect((await request(port, '/t/unknown')).status).toBe(404)
        })

        test('path traversal cannot reach the filesystem', async () => {
            const attempts = [
                '/v/..', '/v/../etc/passwd', '/v/%2e%2e', '/v/%2e%2e%2fetc%2fpasswd', '/v/..%2f..%2f',
                `/v/${encodeURIComponent(filePath)}`, '/v/abc123%00', '/v/abc123%2f..%2f..', '//v/abc123', '/v/abc123/../abc123',
                `/${encodeURIComponent('../video.mp4')}`,
            ]
            for (const p of attempts) {
                const res = await request(port, p)
                expect([404, 400]).toContain(res.status)
                expect(res.body.length).toBe(0)
            }
        })

        test('handle lookup is exact', async () => {
            expect((await request(port, '/v/abc12')).status).toBe(404)
            expect((await request(port, '/v/ABC123')).status).toBe(404)
            expect((await request(port, '/v/abc123')).status).toBe(200)
        })

        test('HEAD on /t is not allowed', async () => {
            const res = await request(port, '/t/abc123', { method: 'HEAD' })
            expect(res.status).toBe(405)
            expect((await request(port, '/t/abc123')).status).toBe(200)
        })
    })

    describe('404 versus 410', () => {
        test('410 when the file is gone at request time', async () => {
            const gone = path.join(dir, 'gone.mp4')
            fs.writeFileSync(gone, 'abc')
            publish({ handles: [{ handle: 'gone1', path: gone }] })
            expect((await request(port, '/v/gone1')).status).toBe(200)
            fs.unlinkSync(gone)
            const res = await request(port, '/v/gone1')
            expect(res.status).toBe(410)
            expect(res.body.length).toBe(0)
        })

        test('410 when the path is a directory', async () => {
            publish({ handles: [{ handle: 'dir1', path: dir }] })
            expect((await request(port, '/v/dir1')).status).toBe(410)
        })
    })

    describe('documents', () => {
        test('served by name with no-store, JSON for objects', async () => {
            const res = await request(port, '/catalog')
            expect(res.status).toBe(200)
            expect(res.headers['cache-control']).toBe('no-store')
            expect(res.headers['content-type']).toMatch(/application\/json/)
            expect(JSON.parse(res.body.toString())).toEqual({ routes: [1, 2] })
            expect(res.headers.etag).toBeDefined()
            expect(res.headers['last-modified']).toBeDefined()
        })

        test('string bodies and explicit content types', async () => {
            publish({ documents: { 'catalog-2': { body: 'hello', contentType: 'text/csv' }, plain: { body: 'x' } } })
            const a = await request(port, '/catalog-2')
            expect(a.body.toString()).toBe('hello')
            expect(a.headers['content-type']).toBe('text/csv')
            expect((await request(port, '/plain')).headers['content-type']).toMatch(/text\/plain/)
        })

        test('HEAD returns headers without body', async () => {
            const res = await request(port, '/catalog', { method: 'HEAD' })
            expect(res.status).toBe(200)
            expect(Number(res.headers['content-length'])).toBeGreaterThan(0)
            expect(res.body.length).toBe(0)
        })

        test('invalid document names are dropped', async () => {
            publish({ documents: { 'Bad': { body: 'x' }, '1abc': { body: 'x' }, ['a'.repeat(33)]: { body: 'x' }, ok: { body: 'x' } } })
            expect((await request(port, '/ok')).status).toBe(200)
            expect((await request(port, '/Bad')).status).toBe(404)
            expect((await request(port, '/1abc')).status).toBe(404)
        })

        test('Range works on documents', async () => {
            const res = await request(port, '/catalog', { headers: { Range: 'bytes=0-3' } })
            expect(res.status).toBe(206)
            expect(res.body.toString()).toBe('{"ro')
        })

        test('If-None-Match yields 304', async () => {
            const first = await request(port, '/catalog')
            const res = await request(port, '/catalog', { headers: { 'If-None-Match': first.headers.etag } })
            expect(res.status).toBe(304)
            expect(res.body.length).toBe(0)
        })

        test('documents named v and t do not collide with handle routes', async () => {
            publish({ documents: { v: { body: 'doc-v' }, t: { body: 'doc-t' } } })
            expect((await request(port, '/v')).body.toString()).toBe('doc-v')
            expect((await request(port, '/v/abc123')).status).toBe(200)
        })
    })

    describe('files and Range', () => {
        const get = (range, extra = {}) => request(port, '/v/abc123', { headers: { Range: range, ...extra } })

        test('full response', async () => {
            const res = await request(port, '/v/abc123')
            expect(res.status).toBe(200)
            expect(res.headers['accept-ranges']).toBe('bytes')
            expect(res.headers['content-type']).toBe('video/mp4')
            expect(res.headers['content-length']).toBe(String(FILE_SIZE))
            expect(res.headers.etag).toBeDefined()
            expect(res.headers['last-modified']).toBeDefined()
            expect(res.body.equals(content)).toBe(true)
        })

        test.each([
            ['bytes=0-99', 0, 99],
            ['bytes=0-0', 0, 0],
            ['bytes=10-19', 10, 19],
            ['bytes=900-', 900, 999],
            ['bytes=999-', 999, 999],
            ['bytes=-100', 900, 999],
            ['bytes=-1', 999, 999],
            ['bytes=-5000', 0, 999],
            ['bytes=990-5000', 990, 999],
            ['bytes=0-', 0, 999],
        ])('%s -> 206', async (range, start, end) => {
            const res = await get(range)
            expect(res.status).toBe(206)
            expect(res.headers['content-range']).toBe(`bytes ${start}-${end}/${FILE_SIZE}`)
            expect(res.headers['content-length']).toBe(String(end - start + 1))
            expect(res.body.equals(content.subarray(start, end + 1))).toBe(true)
        })

        test.each(['bytes=1000-', 'bytes=2000-3000', 'bytes=-0'])('%s -> 416', async (range) => {
            const res = await get(range)
            expect(res.status).toBe(416)
            expect(res.headers['content-range']).toBe(`bytes */${FILE_SIZE}`)
            expect(res.body.length).toBe(0)
        })

        test.each(['bytes=5-2', 'items=0-1', 'bytes=abc', 'bytes=-', 'bytes=1-2-3', 'garbage'])('%s is ignored (200 full)', async (range) => {
            const res = await get(range)
            expect(res.status).toBe(200)
            expect(res.body.length).toBe(FILE_SIZE)
        })

        test('sequential seeks on a keep-alive connection', async () => {
            const agent = new http.Agent({ keepAlive: true })
            const one = (range) => new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port, path: '/v/abc123', agent, headers: { Authorization: `Bearer ${TOKEN}`, Range: range } }, res => {
                    const chunks = []
                    res.on('data', c => chunks.push(c))
                    res.on('end', () => resolve(Buffer.concat(chunks)))
                }).on('error', reject)
            })
            try {
                expect((await one('bytes=500-509')).equals(content.subarray(500, 510))).toBe(true)
                expect((await one('bytes=0-9')).equals(content.subarray(0, 10))).toBe(true)
                expect((await one('bytes=-10')).equals(content.subarray(990))).toBe(true)
            }
            finally {
                agent.destroy()
            }
        })

        test('multiple ranges give multipart/byteranges', async () => {
            const res = await get('bytes=0-1, 10-11, -2')
            expect(res.status).toBe(206)
            const m = /multipart\/byteranges; boundary=(\w+)/.exec(res.headers['content-type'])
            expect(m).not.toBeNull()
            expect(Number(res.headers['content-length'])).toBe(res.body.length)
            const text = res.body.toString('latin1')
            expect(text).toContain('Content-Range: bytes 0-1/1000')
            expect(text).toContain('Content-Range: bytes 10-11/1000')
            expect(text).toContain('Content-Range: bytes 998-999/1000')
            expect(text.endsWith(`--${m[1]}--\r\n`)).toBe(true)
            expect(res.body.includes(content.subarray(10, 12))).toBe(true)
        })

        test('If-Range with matching etag honours the range, mismatch returns everything', async () => {
            const full = await request(port, '/v/abc123')
            const hit = await get('bytes=0-9', { 'If-Range': full.headers.etag })
            expect(hit.status).toBe(206)
            const miss = await get('bytes=0-9', { 'If-Range': '"other"' })
            expect(miss.status).toBe(200)
            expect(miss.body.length).toBe(FILE_SIZE)
        })

        test('If-Range with a date', async () => {
            const full = await request(port, '/v/abc123')
            expect((await get('bytes=0-9', { 'If-Range': full.headers['last-modified'] })).status).toBe(206)
            expect((await get('bytes=0-9', { 'If-Range': 'Thu, 01 Jan 1970 00:00:00 GMT' })).status).toBe(200)
        })

        test('If-None-Match and If-Modified-Since give 304', async () => {
            const full = await request(port, '/v/abc123')
            expect((await request(port, '/v/abc123', { headers: { 'If-None-Match': full.headers.etag } })).status).toBe(304)
            expect((await request(port, '/v/abc123', { headers: { 'If-None-Match': '"nope"' } })).status).toBe(200)
            expect((await request(port, '/v/abc123', { headers: { 'If-Modified-Since': full.headers['last-modified'] } })).status).toBe(304)
        })

        test('HEAD returns metadata and no body, also for a range', async () => {
            const res = await request(port, '/v/abc123', { method: 'HEAD' })
            expect(res.status).toBe(200)
            expect(res.headers['content-length']).toBe(String(FILE_SIZE))
            expect(res.body.length).toBe(0)

            const ranged = await request(port, '/v/abc123', { method: 'HEAD', headers: { Range: 'bytes=0-9' } })
            expect(ranged.status).toBe(206)
            expect(ranged.headers['content-length']).toBe('10')
            expect(ranged.body.length).toBe(0)
        })

        test('thumbnails are served through /t', async () => {
            const thumb = path.join(dir, 'thumb.jpg')
            fs.writeFileSync(thumb, 'jpegdata')
            publish({ handles: [{ handle: 'th1', path: thumb }] })
            const res = await request(port, '/t/th1')
            expect(res.status).toBe(200)
            expect(res.headers['content-type']).toBe('image/jpeg')
            expect(res.body.toString()).toBe('jpegdata')
        })

        test('empty file', async () => {
            const empty = path.join(dir, 'empty.mp4')
            fs.writeFileSync(empty, '')
            publish({ handles: [{ handle: 'empty1', path: empty }] })
            expect((await request(port, '/v/empty1')).status).toBe(200)
            expect((await request(port, '/v/empty1', { headers: { Range: 'bytes=0-1' } })).status).toBe(416)
        })
    })

    describe('parseRange', () => {
        test('table', () => {
            expect(parseRange(undefined, 10)).toEqual({ kind: 'none' })
            expect(parseRange('bytes=2-4', 10)).toEqual({ kind: 'ranges', ranges: [[2, 4]] })
            expect(parseRange('bytes=-3', 10)).toEqual({ kind: 'ranges', ranges: [[7, 9]] })
            expect(parseRange('bytes=8-', 10)).toEqual({ kind: 'ranges', ranges: [[8, 9]] })
            expect(parseRange('bytes=0-1,20-30', 10)).toEqual({ kind: 'ranges', ranges: [[0, 1]] })
            expect(parseRange('bytes=20-30', 10)).toEqual({ kind: 'unsatisfiable' })
            expect(parseRange('bytes=4-2', 10)).toEqual({ kind: 'none' })
            expect(parseRange('bytes=' + Array.from({ length: 17 }, (_, i) => `${i}-${i}`).join(','), 100)).toEqual({ kind: 'none' })
        })
    })

    describe('publishMedia', () => {
        test('replaces the whole state atomically', async () => {
            const other = path.join(dir, 'other.mp4')
            fs.writeFileSync(other, 'other')
            publish({
                documents: { fresh: { body: 'f' } }, handles: [{ handle: 'new1', path: other }],
                tokens: [{ digest: digestOf(OTHER_TOKEN), id: 'tok-2' }]
            })

            expect((await request(port, '/catalog', { token: OTHER_TOKEN })).status).toBe(404)
            expect((await request(port, '/v/abc123', { token: OTHER_TOKEN })).status).toBe(404)
            expect((await request(port, '/fresh', { token: OTHER_TOKEN })).status).toBe(200)
            expect((await request(port, '/v/new1', { token: OTHER_TOKEN })).body.toString()).toBe('other')
            expect((await request(port, '/fresh', { token: TOKEN })).status).toBe(401)
        })

        test('reports rejected handles and tokens, keeps valid ones', () => {
            const res = server.publish({
                documents: {},
                handles: [
                    { handle: 'ok1', path: filePath }, { handle: 'bad/handle', path: filePath }, { handle: '', path: filePath },
                    { handle: 'ok1', path: filePath }, { handle: 'rel', path: 'relative/path.mp4' }, { handle: 'x'.repeat(129), path: filePath },
                ],
                tokens: [{ digest: digestOf('a'), id: 'a' }, { digest: 'short', id: 'b' }, { digest: digestOf('c'), id: '' }, { digest: digestOf('a'), id: 'dup' }],
            })
            expect(res.ok).toBe(true)
            expect(res.rejectedHandles).toEqual(['bad/handle', '', 'ok1', 'rel', 'x'.repeat(129)])
            expect(res.rejectedTokens).toBe(3)
            expect(server.getStats()).toEqual({ handleCount: 1, tokenCount: 1 })
        })

        test('rejects a non-object state without touching the current one', () => {
            expect(server.publish(undefined).ok).toBe(false)
            expect(server.getStats().handleCount).toBe(1)
        })

        test('state is not persisted: a new server starts empty', () => {
            const fresh = new MediaServer({ emit: () => {}, peerFilter: new PeerFilter() })
            expect(fresh.getStats()).toEqual({ handleCount: 0, tokenCount: 0 })
        })
    })

    describe('token revocation', () => {
        const startSlowDownload = () => new Promise((resolve, reject) => {
            const req = http.get({ host: '127.0.0.1', port, path: '/v/big1', agent: false, headers: { Authorization: `Bearer ${TOKEN}` } }, res => {
                res.pause()
                const result = { res, closed: new Promise(r => { res.socket.on('close', () => r(res.complete)) }) }
                res.on('error', () => { /* aborted */ })
                resolve(result)
            })
            req.on('error', reject)
        })

        test('revoking the digest aborts the in-flight response; other tokens are unaffected', async () => {
            publish({
                handles: [{ handle: 'big1', path: bigPath }],
                tokens: [{ digest: digestOf(TOKEN), id: 'tok-1' }, { digest: digestOf(OTHER_TOKEN), id: 'tok-2' }]
            })
            const keep = await new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port, path: '/v/big1', agent: false, headers: { Authorization: `Bearer ${OTHER_TOKEN}` } }, res => {
                    res.pause()
                    res.on('error', () => {})
                    resolve(res)
                }).on('error', reject)
            })
            const slow = await startSlowDownload()

            publish({
                handles: [{ handle: 'big1', path: bigPath }],
                tokens: [{ digest: digestOf(OTHER_TOKEN), id: 'tok-2' }]
            })

            expect(await slow.closed).toBe(false)
            await new Promise(r => setTimeout(r, 100))
            const aborted = events.find(e => e.type === 'media-request' && e.tokenId === 'tok-1' && e.handle === 'big1')
            expect(aborted).toMatchObject({ status: 200, completed: false, endpoint: '/v' })
            expect(keep.destroyed).toBe(false)
            keep.destroy()
        })

        test('a revoked token gets 401 afterwards', async () => {
            publish({ tokens: [{ digest: digestOf(OTHER_TOKEN), id: 'tok-2' }] })
            expect((await request(port, '/catalog', { token: TOKEN })).status).toBe(401)
        })
    })

    describe('limits', () => {
        test('limits are clamped to the ceilings and defaulted', () => {
            expect(server.setLimits({ maxConnections: 100000, maxPerPeer: 0, maxConcurrentStreams: 3 }))
                .toEqual({ maxConnections: 256, maxPerPeer: 16, maxConcurrentStreams: 3 })
        })

        test('concurrent streams are capped with 503', async () => {
            publish({ handles: [{ handle: 'big1', path: bigPath }] })
            server.setLimits({ maxConcurrentStreams: 1 })
            const first = await new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port, path: '/v/big1', agent: false, headers: { Authorization: `Bearer ${TOKEN}` } }, res => {
                    res.pause()
                    res.on('error', () => {})
                    resolve(res)
                }).on('error', reject)
            })
            try {
                const second = await request(port, '/v/big1')
                expect(second.status).toBe(503)
                expect((await request(port, '/catalog')).status).toBe(200)
            }
            finally {
                first.destroy()
            }
        })

        test('connections per peer are capped', async () => {
            server.setLimits({ maxPerPeer: 1 })
            const net = require('node:net')
            const a = net.connect(port, '127.0.0.1')
            await new Promise(r => a.once('connect', r))
            const b = net.connect(port, '127.0.0.1')
            const closed = await new Promise(r => { b.on('close', () => r(true)); b.on('error', () => {}); setTimeout(() => r(false), 1000) })
            expect(closed).toBe(true)
            a.destroy()
        })
    })

    describe('peer filter', () => {
        test('a refused peer gets no bytes and is counted without its address', async () => {
            const filter = server.peerFilter
            filter.onRefused = (listener, addressClass, count) => events.push({ type: 'peer-refused', listener, addressClass, count })
            filter.setPolicy({ defaultPrivate: false })

            await expect(request(port, '/catalog')).rejects.toBeDefined()
            filter.flush()

            const refused = events.find(e => e.type === 'peer-refused')
            expect(refused).toEqual({ type: 'peer-refused', listener: 'media', addressClass: 'other', count: 1 })
            expect(JSON.stringify(refused)).not.toContain('127.0.0.1')

            filter.setPolicy({ defaultPrivate: true })
            expect((await request(port, '/catalog')).status).toBe(200)
        })

        test('allow list admits a peer the default would refuse', async () => {
            server.peerFilter.setPolicy({ defaultPrivate: false, allow: ['127.0.0.0/8'] })
            expect((await request(port, '/catalog')).status).toBe(200)
        })
    })

    describe('events and logging', () => {
        test('media-request carries endpoint, handle, status, token id and bytes', async () => {
            await request(port, '/v/abc123', { headers: { Range: 'bytes=0-9' } })
            const ev = events.filter(e => e.type === 'media-request').pop()
            expect(ev).toEqual({ type: 'media-request', endpoint: '/v', handle: 'abc123', status: 206, tokenId: 'tok-1', bytes: 10, completed: true })
        })

        test('unauthenticated requests carry no token id or handle', async () => {
            await request(port, '/v/abc123', { token: null })
            const ev = events.filter(e => e.type === 'media-request').pop()
            expect(ev).toMatchObject({ status: 401, tokenId: undefined, handle: undefined, completed: true })
        })

        test('logs never contain tokens or file paths', async () => {
            const logged = []
            const logger = { logEvent: e => logged.push(JSON.stringify(e)) }
            const s = new MediaServer({ emit: () => {}, peerFilter: new PeerFilter(), logger, requestLogger: logger })
            const res = await s.start({ port: 0, host: '127.0.0.1' })
            s.publish({ handles: [{ handle: 'abc123', path: filePath }], tokens: [{ digest: digestOf(TOKEN), id: 'tok-1' }] })
            await request(res.port, `/v/abc123?t=${TOKEN}`, { token: null })
            await request(res.port, '/v/abc123', { token: 'bad-token-value' })
            await s.stop()
            const all = logged.join('\n')
            expect(all).not.toContain(TOKEN)
            expect(all).not.toContain('bad-token-value')
            expect(all).not.toContain(filePath)
            expect(all).not.toContain(digestOf(TOKEN))
            expect(all).toContain('abc123')
        })
    })
})
