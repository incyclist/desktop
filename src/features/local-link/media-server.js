const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { peerKey } = require('./peer-filter')

const LISTENER = 'media'

const DOCUMENT_NAME = /^[a-z][a-z0-9-]{0,31}$/
const HANDLE = /^[A-Za-z0-9_-]{1,128}$/
const DIGEST = /^[A-Za-z0-9_-]{43}$/
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(; ?[\x20-\x7e]+)?$/
const DOCUMENT_ROUTE = /^\/([a-z][a-z0-9-]{0,31})$/
const HANDLE_ROUTE = /^\/([vt])\/([A-Za-z0-9_-]{1,128})$/
const BEARER = /^Bearer +(\S+)$/i
const RANGE_SPEC = /^(\d{0,15})-(\d{0,15})$/

const MAX_PATH_LENGTH = 300
const MAX_TOKEN_LENGTH = 1024
const MAX_RANGES = 16

// Defaults and hard ceilings for the limits values supplied by the renderer
const LIMITS = {
    maxConnections:       { default: 64, ceiling: 256 },
    maxPerPeer:           { default: 16, ceiling: 64 },
    maxConcurrentStreams: { default: 8,  ceiling: 32 },
}

const EXTENSION_TYPES = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
}

// Socket timeouts. The http.Server is never listen()ed (sockets are handed over from a net
// server), so Node's own headers/request timeout checks never run and are enforced here.
// HEADER: until the first complete request head is parsed. IDLE: afterwards; socket activity
// (including writes of an active streaming response) resets it.
const DEFAULT_HEADER_TIMEOUT_MS = 15000
const DEFAULT_IDLE_TIMEOUT_MS = 60000

const noopLogger = { logEvent: () => { /* no logging configured */ } }

// logger of the most recent MediaServer, for the module-level helpers below
let moduleLogger = noopLogger

/** Logs a swallowed error of a module-level helper (function name and message only). Never throws. */
function logModuleError(fn, err) {
    try {
        moduleLogger.logEvent({ message: 'local-link media error', fn, error: err?.message })
    }
    catch { /* the logger itself failed: nothing left to do */ }
}

function emptyState() {
    try {
        return { documents: new Map(), handles: new Map(), tokens: [] }
    }
    catch (err) {
        logModuleError('emptyState', err)
        return { documents: new Map(), handles: new Map(), tokens: [] }
    }
}

function validContentType(ct) {
    try {
        return typeof ct === 'string' && CONTENT_TYPE.test(ct) ? ct : undefined
    }
    catch (err) {
        logModuleError('validContentType', err)
        return undefined
    }
}

function clamp(value, spec) {
    try {
        if (!Number.isInteger(value) || value < 1)
            return spec.default
        return Math.min(value, spec.ceiling)
    }
    catch (err) {
        logModuleError('clamp', err)
        return spec.default
    }
}

function writeChunk(res, data) {
    try {
        if (res.destroyed)
            return Promise.resolve(false)
        if (res.write(data))
            return Promise.resolve(true)

        return new Promise(resolve => {
            try {
                const cleanup = () => {
                    try { res.off('drain', onDrain); res.off('close', onClose) }
                    catch (err) { logModuleError('writeChunk.cleanup', err) }
                }
                const onDrain = () => { cleanup(); resolve(true) }
                const onClose = () => { cleanup(); resolve(false) }
                res.once('drain', onDrain)
                res.once('close', onClose)
            }
            catch (err) {
                logModuleError('writeChunk.wait', err)
                resolve(false)
            }
        })
    }
    catch (err) {
        logModuleError('writeChunk', err)
        return Promise.resolve(false)
    }
}

function endResponse(res) {
    try {
        if (res.destroyed)
            return Promise.resolve(false)
        return new Promise(resolve => {
            try {
                res.once('close', () => resolve(res.writableFinished))
                res.end()
            }
            catch (err) {
                logModuleError('endResponse.end', err)
                resolve(false)
            }
        })
    }
    catch (err) {
        logModuleError('endResponse', err)
        return Promise.resolve(false)
    }
}

function pipeRange(stream, res, rec) {
    try {
        return new Promise(resolve => {
            let done = false
            const finish = (ok) => {
                if (done)
                    return
                done = true
                try {
                    res.off('close', onClose)
                    if (!ok)
                        stream.destroy()
                }
                catch (err) { logModuleError('pipeRange.finish', err) }
                resolve(ok)
            }
            const onClose = () => finish(false)

            try {
                res.once('close', onClose)
                stream.on('data', chunk => {
                    try { rec.bytes += chunk.length }
                    catch (err) { logModuleError('pipeRange.data', err) }
                })
                stream.once('end', () => finish(true))
                stream.once('error', () => {
                    finish(false)
                    try { res.destroy() }
                    catch (err) { logModuleError('pipeRange.error', err) }
                })
                stream.pipe(res, { end: false })
            }
            catch (err) {
                logModuleError('pipeRange.setup', err)
                finish(false)
            }
        })
    }
    catch (err) {
        logModuleError('pipeRange', err)
        try { stream.destroy() } catch { /* ignore */ }
        return Promise.resolve(false)
    }
}

/**
 * Parses a Range header against a representation of `size` bytes.
 * Returns {kind:'none'} (header absent, malformed or not a byte range: serve everything),
 * {kind:'unsatisfiable'} or {kind:'ranges', ranges:[[start,end],...]} (inclusive bounds).
 */
function parseRange(header, size) {
    try {
        if (typeof header !== 'string')
            return { kind: 'none' }
        const m = /^bytes=(.+)$/i.exec(header.trim())
        if (!m)
            return { kind: 'none' }

        const specs = m[1].split(',').map(s => s.trim())
        if (specs.length > MAX_RANGES)
            return { kind: 'none' }

        const ranges = []
        for (const spec of specs) {
            const r = RANGE_SPEC.exec(spec)
            if (!r || (r[1] === '' && r[2] === ''))
                return { kind: 'none' }

            if (r[1] === '') {
                const n = Number(r[2])
                if (n > 0 && size > 0)
                    ranges.push([Math.max(0, size - n), size - 1])
                continue
            }

            const start = Number(r[1])
            const end = r[2] === '' ? size - 1 : Number(r[2])
            if (r[2] !== '' && end < start)
                return { kind: 'none' }
            if (start >= size)
                continue
            ranges.push([start, Math.min(end, size - 1)])
        }

        return ranges.length ? { kind: 'ranges', ranges } : { kind: 'unsatisfiable' }
    }
    catch (err) {
        logModuleError('parseRange', err)
        return { kind: 'none' }
    }
}

function stripWeak(etag) {
    try {
        return etag.trim().replace(/^W\//, '')
    }
    catch (err) {
        logModuleError('stripWeak', err)
        return ''
    }
}

function etagMatches(header, etag) {
    try {
        if (header.trim() === '*')
            return true
        return header.split(',').some(e => stripWeak(e) === etag)
    }
    catch (err) {
        logModuleError('etagMatches', err)
        return false
    }
}

function seconds(date) {
    try {
        return Math.floor(date.getTime() / 1000)
    }
    catch (err) {
        logModuleError('seconds', err)
        return 0
    }
}

/**
 * HTTP listener that serves published documents and handle-addressed files.
 * It holds only what `publish` gave it, in memory, and never decides what is exposed.
 */
class MediaServer {

    /**
     * @param {object} props
     * @param {(event:object)=>void} props.emit            receives transport events
     * @param {import('./peer-filter').PeerFilter} props.peerFilter
     * @param {{logEvent:Function}} [props.logger]         lifecycle and errors
     * @param {{logEvent:Function}} [props.requestLogger]  per-request logs (local file only)
     * @param {number} [props.headerTimeoutMs]  max time for a peer to deliver a request head
     * @param {number} [props.idleTimeoutMs]    inactivity timeout once a request head was received
     */
    constructor(props) {
        this.emit = props.emit
        this.headerTimeoutMs = props.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS
        this.idleTimeoutMs = props.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
        this.peerFilter = props.peerFilter
        this.logger = props.logger ?? noopLogger
        this.requestLogger = props.requestLogger ?? noopLogger
        moduleLogger = this.logger

        this.state = emptyState()
        this.limits = this.resolveLimits({})
        this.netServer = undefined
        this.httpServer = undefined
        this.port = undefined
        this.startPromise = undefined
        this.sockets = new Set()
        this.peerCounts = new Map()
        this.active = new Set()
    }

    /** Logs a swallowed error (function name and message only: never addresses, tokens, paths or payloads). */
    logError(fn, err) {
        try {
            this.logger.logEvent({ message: 'local-link media error', fn, error: err?.message })
        }
        catch { /* the logger itself failed: nothing left to do */ }
    }

    /** Emits a transport event; a failing consumer (e.g. destroyed webContents) must not throw into a network handler. */
    safeEmit(event) {
        try {
            this.emit(event)
        } catch {
            try {
                this.logger.logEvent({ message: 'local-link media emit failed', type: event?.type })
            }
            catch { /* the logger itself failed: nothing left to do */ }
        }
    }

    /** Last resort for a request that failed unexpectedly: 500 if nothing was sent yet, else drop the response. Resolves false. */
    async failRequest(res, rec) {
        try {
            if (!res.headersSent && !res.destroyed)
                await this.reply(res, rec, 500)
            else
                res.destroy()
        }
        catch (err) {
            this.logError('failRequest', err)
            try { res.destroy() } catch { /* already gone */ }
        }
        return false
    }

    isRunning() {
        try {
            return this.netServer?.listening === true
        }
        catch (err) {
            this.logError('isRunning', err)
            return false
        }
    }

    getPort() {
        try {
            return this.isRunning() ? this.port : undefined
        }
        catch (err) {
            this.logError('getPort', err)
            return undefined
        }
    }

    getStats() {
        try {
            return { handleCount: this.state.handles.size, tokenCount: this.state.tokens.length }
        }
        catch (err) {
            this.logError('getStats', err)
            return { handleCount: 0, tokenCount: 0 }
        }
    }

    resolveLimits(limits) {
        try {
            return {
                maxConnections:       clamp(limits?.maxConnections, LIMITS.maxConnections),
                maxPerPeer:           clamp(limits?.maxPerPeer, LIMITS.maxPerPeer),
                maxConcurrentStreams: clamp(limits?.maxConcurrentStreams, LIMITS.maxConcurrentStreams),
            }
        }
        catch (err) {
            this.logError('resolveLimits', err)
            return { maxConnections: LIMITS.maxConnections.default, maxPerPeer: LIMITS.maxPerPeer.default, maxConcurrentStreams: LIMITS.maxConcurrentStreams.default }
        }
    }

    /** Applies media limits (unset values fall back to defaults; all values clamped to the ceilings). */
    setLimits(limits) {
        try {
            this.limits = this.resolveLimits(limits)
            if (this.netServer)
                this.netServer.maxConnections = this.limits.maxConnections
            return { ...this.limits }
        }
        catch (err) {
            this.logError('setLimits', err)
            return { ...this.limits }
        }
    }

    /** Starts the listener. Resolves with a ListenerResult; never rejects. */
    start(opts = {}) {
        try {
            if (this.isRunning())
                return Promise.resolve({ ok: true, port: this.port, alreadyRunning: true })
            if (this.startPromise)
                return this.startPromise

            const port = opts?.port ?? 0
            const host = opts?.host ?? '0.0.0.0'
            if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof host !== 'string' || host === '')
                return Promise.resolve({ ok: false, error: { code: 'EINVAL' } })

            this.startPromise = new Promise(resolve => {
                try {
                    const httpServer = http.createServer((req, res) => this.onRequest(req, res))
                    httpServer.headersTimeout = this.headerTimeoutMs
                    httpServer.requestTimeout = this.idleTimeoutMs
                    httpServer.keepAliveTimeout = this.headerTimeoutMs
                    httpServer.on('clientError', (_err, socket) => {
                        try {
                            if (socket.writable)
                                socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
                            else
                                socket.destroy()
                        }
                        catch (err) {
                            this.logError('clientError', err)
                        }
                    })

                    // The peer filter has to see the socket before the HTTP parser does, so the listening
                    // socket is a plain net server that hands accepted peers over to the HTTP server.
                    const netServer = net.createServer(socket => this.onConnection(socket))
                    netServer.maxConnections = this.limits.maxConnections

                    const onError = (err) => {
                        try {
                            const code = err?.code ?? 'UNKNOWN'
                            this.logger.logEvent({ message: 'local-link media listen failed', code })
                            this.safeEmit({ type: 'error', listener: LISTENER, phase: 'listen', code })
                            resolve({ ok: false, error: { code } })
                        }
                        catch (e) {
                            this.logError('start.onError', e)
                            resolve({ ok: false, error: { code: 'UNKNOWN' } })
                        }
                    }

                    netServer.once('error', onError)
                    netServer.listen({ port, host }, () => {
                        try {
                            netServer.off('error', onError)
                            netServer.on('error', err => {
                                try {
                                    const code = err?.code ?? 'UNKNOWN'
                                    this.logger.logEvent({ message: 'local-link media listener error', code })
                                    this.safeEmit({ type: 'error', listener: LISTENER, phase: 'runtime', code })
                                }
                                catch (e) {
                                    this.logError('server.onError', e)
                                }
                            })

                            this.netServer = netServer
                            this.httpServer = httpServer
                            this.port = netServer.address().port
                            this.logger.logEvent({ message: 'local-link media listener started', port: this.port })
                            this.safeEmit({ type: 'started', listener: LISTENER, port: this.port })
                            resolve({ ok: true, port: this.port })
                        }
                        catch (e) {
                            this.logError('start.onListening', e)
                            resolve({ ok: false, error: { code: 'UNKNOWN' } })
                        }
                    })
                }
                catch (err) {
                    this.logError('start.listen', err)
                    resolve({ ok: false, error: { code: err?.code ?? 'UNKNOWN' } })
                }
            }).finally(() => { this.startPromise = undefined })

            return this.startPromise
        }
        catch (err) {
            this.logError('start', err)
            return Promise.resolve({ ok: false, error: { code: 'UNKNOWN' } })
        }
    }

    /** Stops the listener, aborts in-flight responses and drops the published state. Never rejects. */
    async stop() {
        try {
            const netServer = this.netServer
            if (!netServer)
                return

            this.netServer = undefined
            this.httpServer = undefined
            this.port = undefined

            for (const r of [...this.active]) {
                try { r.abort() } catch (err) { this.logError('stop.abort', err) }
            }
            for (const s of [...this.sockets]) {
                try { s.destroy() } catch (err) { this.logError('stop.destroy', err) }
            }
            this.state = emptyState()

            await new Promise(resolve => {
                try {
                    netServer.close(() => resolve())
                }
                catch (err) {
                    this.logError('stop.close', err)
                    resolve()
                }
            })
            this.logger.logEvent({ message: 'local-link media listener stopped' })
            this.safeEmit({ type: 'stopped', listener: LISTENER })
        }
        catch (err) {
            this.logError('stop', err)
        }
    }

    onConnection(socket) {
        try {
            if (!this.peerFilter.guard(LISTENER, socket))
                return

            const key = peerKey(socket.remoteAddress)
            const count = this.peerCounts.get(key) ?? 0
            if (count >= this.limits.maxPerPeer) {
                socket.destroy()
                return
            }

            this.peerCounts.set(key, count + 1)
            this.sockets.add(socket)
            socket.once('close', () => {
                try {
                    clearTimeout(socket.headDeadline)
                    this.sockets.delete(socket)
                    const left = (this.peerCounts.get(key) ?? 1) - 1
                    if (left <= 0)
                        this.peerCounts.delete(key)
                    else
                        this.peerCounts.set(key, left)
                }
                catch (err) {
                    this.logError('onConnection.close', err)
                }
            })
            socket.on('error', () => { /* reported through close */ })

            socket.setTimeout(this.headerTimeoutMs)
            socket.on('timeout', () => {
                try { socket.destroy() }
                catch (err) { this.logError('onConnection.timeout', err) }
            })
            this.armHeadDeadline(socket)

            this.httpServer?.emit('connection', socket)
        }
        catch (err) {
            this.logError('onConnection', err)
            try { socket?.destroy() } catch { /* already gone */ }
        }
    }

    /**
     * Absolute deadline for a complete request head. socket.setTimeout alone is reset by every
     * received byte, so a peer dripping header bytes would never be reaped.
     */
    armHeadDeadline(socket) {
        try {
            clearTimeout(socket.headDeadline)
            socket.headDeadline = setTimeout(() => {
                try { socket.destroy() }
                catch (err) { this.logError('armHeadDeadline.timeout', err) }
            }, this.headerTimeoutMs)
            socket.headDeadline.unref?.()
        }
        catch (err) {
            this.logError('armHeadDeadline', err)
        }
    }

    /**
     * Atomically replaces documents, handles and token digests. Invalid entries are dropped;
     * invalid handles and tokens are counted in the result. In-flight responses whose token
     * is no longer published are aborted.
     */
    publish(input) {
        try {
            if (!input || typeof input !== 'object')
                return { ok: false, rejectedHandles: [], rejectedTokens: 0 }

            const previous = this.state
            const next = emptyState()
            const rejectedHandles = []
            let rejectedTokens = 0
            let rejectedDocuments = 0
            const now = new Date()

            for (const [name, doc] of Object.entries(input.documents ?? {})) {
                const body = doc?.body
                if (!DOCUMENT_NAME.test(name) || (typeof body !== 'string' && (typeof body !== 'object' || body === null))) {
                    rejectedDocuments++
                    continue
                }
                const isText = typeof body === 'string'
                const buffer = Buffer.from(isText ? body : JSON.stringify(body), 'utf8')
                const etag = `"${crypto.createHash('sha256').update(buffer).digest('base64url').slice(0, 22)}"`
                const old = previous.documents.get(name)
                next.documents.set(name, {
                    buffer, etag,
                    contentType: validContentType(doc.contentType) ?? (isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
                    lastModified: old?.etag === etag ? old.lastModified : now,
                })
            }

            for (const h of Array.isArray(input.handles) ? input.handles : []) {
                const handle = h?.handle
                if (typeof handle !== 'string' || !HANDLE.test(handle) || next.handles.has(handle)
                    || typeof h.path !== 'string' || !path.isAbsolute(h.path)) {
                    rejectedHandles.push(String(handle))
                    continue
                }
                next.handles.set(handle, {
                    path: h.path,
                    contentType: validContentType(h.contentType) ?? EXTENSION_TYPES[path.extname(h.path).toLowerCase()] ?? 'application/octet-stream',
                })
            }

            const seen = new Set()
            for (const t of Array.isArray(input.tokens) ? input.tokens : []) {
                if (typeof t?.digest !== 'string' || !DIGEST.test(t.digest) || typeof t.id !== 'string' || t.id === '' || seen.has(t.digest)) {
                    rejectedTokens++
                    continue
                }
                seen.add(t.digest)
                next.tokens.push({ digest: t.digest, buffer: Buffer.from(t.digest, 'base64url'), id: t.id })
            }

            this.state = next

            for (const r of [...this.active]) {
                if (r.digest && !seen.has(r.digest))
                    r.abort()
            }

            this.logger.logEvent({
                message: 'local-link media published',
                documents: next.documents.size, handles: next.handles.size, tokens: next.tokens.length,
                rejectedHandles: rejectedHandles.length, rejectedTokens, rejectedDocuments
            })
            return { ok: true, rejectedHandles, rejectedTokens }
        }
        catch (err) {
            this.logError('publish', err)
            return { ok: false, rejectedHandles: [], rejectedTokens: 0 }
        }
    }

    // ------------------------------------------------------------------ requests

    extractToken(req, query) {
        try {
            const auth = req.headers.authorization
            if (typeof auth === 'string') {
                const m = BEARER.exec(auth.trim())
                return m ? m[1] : undefined
            }
            return query.get('t') ?? undefined
        }
        catch (err) {
            this.logError('extractToken', err)
            return undefined
        }
    }

    /** Timing-safe lookup of a presented token against all published digests. */
    verifyToken(token, state) {
        try {
            if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH)
                return undefined

            const hash = crypto.createHash('sha256').update(token).digest()
            let match
            for (const t of state.tokens) {
                if (crypto.timingSafeEqual(hash, t.buffer))
                    match = t
            }
            return match
        }
        catch (err) {
            this.logError('verifyToken', err)
            return undefined
        }
    }

    reply(res, rec, status, headers = {}) {
        try {
            rec.status = status
            res.writeHead(status, {
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store',
                'Content-Length': '0',
                ...headers,
            })
            return endResponse(res)
        }
        catch (err) {
            this.logError('reply', err)
            try { res.destroy() } catch { /* already gone */ }
            return Promise.resolve(false)
        }
    }

    async onRequest(req, res) {
        try {
            const rec = { endpoint: 'unknown', handle: undefined, tokenId: undefined, digest: undefined, status: 0, bytes: 0, completed: false }
            const entry = {
                digest: undefined, streaming: false,
                abort: () => {
                    try { res.destroy() }
                    catch (err) { this.logError('onRequest.abort', err) }
                }
            }
            this.active.add(entry)

            // request head received: switch to the longer inactivity timeout while it is served,
            // and expect the next request head within the header timeout again afterwards
            const socket = req.socket
            if (socket) {
                clearTimeout(socket.headDeadline)
                socket.setTimeout?.(this.idleTimeoutMs)
                res.once('close', () => {
                    try {
                        if (socket.destroyed)
                            return
                        socket.setTimeout?.(this.headerTimeoutMs)
                        this.armHeadDeadline(socket)
                    }
                    catch (err) {
                        this.logError('onRequest.close', err)
                    }
                })
            }

            try {
                rec.completed = await this.route(req, res, rec, entry)
            }
            catch (err) {
                this.logError('onRequest.route', err)
                rec.completed = await this.failRequest(res, rec)
            }
            finally {
                this.active.delete(entry)
            }

            this.safeEmit({
                type: 'media-request', endpoint: rec.endpoint, handle: rec.handle, status: rec.status,
                tokenId: rec.tokenId, bytes: rec.bytes, completed: rec.completed
            })
            this.requestLogger.logEvent({
                message: 'local-link media request', endpoint: rec.endpoint, handle: rec.handle,
                status: rec.status, bytes: rec.bytes, completed: rec.completed
            })
        }
        catch (err) {
            this.logError('onRequest', err)
            try { res.destroy() } catch { /* already gone */ }
        }
    }

    async route(req, res, rec, entry) {
        try {
            const state = this.state
            const url = typeof req.url === 'string' ? req.url : ''
            const q = url.indexOf('?')
            const pathname = q === -1 ? url : url.slice(0, q)
            const query = new URLSearchParams(q === -1 ? '' : url.slice(q + 1))

            const token = this.verifyToken(this.extractToken(req, query), state)
            if (!token)
                return this.reply(res, rec, 401, { 'WWW-Authenticate': 'Bearer' })
            rec.tokenId = token.id
            entry.digest = token.digest

            if (req.method !== 'GET' && req.method !== 'HEAD')
                return this.reply(res, rec, 405, { Allow: 'GET, HEAD' })
            const isHead = req.method === 'HEAD'

            if (pathname.length > MAX_PATH_LENGTH)
                return this.reply(res, rec, 404)

            const handleMatch = HANDLE_ROUTE.exec(pathname)
            if (handleMatch) {
                const [, kind, handle] = handleMatch
                rec.endpoint = `/${kind}`
                rec.handle = handle

                if (kind === 't' && isHead)
                    return this.reply(res, rec, 405, { Allow: 'GET' })

                const file = state.handles.get(handle)
                if (!file)
                    return this.reply(res, rec, 404)

                if (this.streamCount() >= this.limits.maxConcurrentStreams)
                    return this.reply(res, rec, 503, { 'Retry-After': '1' })
                entry.streaming = true

                const source = await this.openFile(file)
                if (!source)
                    return this.reply(res, rec, 410)
                try {
                    return await this.serve(req, res, rec, source, isHead, 'private')
                }
                finally {
                    await source.close()
                }
            }

            const docMatch = DOCUMENT_ROUTE.exec(pathname)
            if (docMatch) {
                rec.endpoint = `/${docMatch[1]}`
                const doc = state.documents.get(docMatch[1])
                if (!doc)
                    return this.reply(res, rec, 404)

                const source = {
                    size: doc.buffer.length, etag: doc.etag, lastModified: doc.lastModified, contentType: doc.contentType,
                    createStream: (start, end) => Readable.from([doc.buffer.subarray(start, end + 1)]),
                    close: async () => { /* in memory */ },
                }
                return this.serve(req, res, rec, source, isHead, 'no-store')
            }

            return this.reply(res, rec, 404)
        }
        catch (err) {
            this.logError('route', err)
            return this.failRequest(res, rec)
        }
    }

    // in-flight responses that stream a handle (documents are not counted)
    streamCount() {
        try {
            let n = 0
            for (const r of this.active) {
                if (r.streaming)
                    n++
            }
            return n
        }
        catch (err) {
            this.logError('streamCount', err)
            return this.limits.maxConcurrentStreams
        }
    }

    async openFile(file) {
        try {
            let fh
            try {
                fh = await fs.promises.open(file.path, 'r')
                const st = await fh.stat()
                if (!st.isFile()) {
                    await fh.close()
                    return undefined
                }
                return {
                    size: st.size,
                    etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
                    lastModified: st.mtime,
                    contentType: file.contentType,
                    createStream: (start, end) => fh.createReadStream({ start, end, autoClose: false }),
                    close: async () => { await fh.close().catch(() => { /* already closed */ }) },
                }
            }
            catch {
                if (fh)
                    await fh.close().catch(() => { /* ignore */ })
                return undefined
            }
        }
        catch (err) {
            this.logError('openFile', err)
            return undefined
        }
    }

    selectRanges(req, source, isHead) {
        try {
            const header = req.headers.range
            if (typeof header !== 'string')
                return { kind: 'none' }

            const ifRange = req.headers['if-range']
            if (typeof ifRange === 'string') {
                const v = ifRange.trim()
                const matches = v.startsWith('"')
                    ? v === source.etag
                    : !v.startsWith('W/') && Date.parse(v) === seconds(source.lastModified) * 1000
                if (!matches)
                    return { kind: 'none' }
            }

            const parsed = parseRange(header, source.size)
            if (isHead && parsed.kind === 'ranges' && parsed.ranges.length > 1)
                return { kind: 'none' }
            return parsed
        }
        catch (err) {
            this.logError('selectRanges', err)
            return { kind: 'none' }
        }
    }

    isNotModified(req, source) {
        try {
            const inm = req.headers['if-none-match']
            if (typeof inm === 'string')
                return etagMatches(inm, source.etag)

            const ims = req.headers['if-modified-since']
            if (typeof ims === 'string') {
                const t = Date.parse(ims)
                return !Number.isNaN(t) && seconds(source.lastModified) * 1000 <= t
            }
            return false
        }
        catch (err) {
            this.logError('isNotModified', err)
            return false
        }
    }

    async serve(req, res, rec, source, isHead, cacheControl) {
        try {
            const base = {
                'Accept-Ranges': 'bytes',
                'ETag': source.etag,
                'Last-Modified': source.lastModified.toUTCString(),
                'Cache-Control': cacheControl,
            }

            if (this.isNotModified(req, source))
                return this.reply(res, rec, 304, base)

            const sel = this.selectRanges(req, source, isHead)

            if (sel.kind === 'unsatisfiable')
                return this.reply(res, rec, 416, { ...base, 'Content-Range': `bytes */${source.size}` })

            if (sel.kind === 'none') {
                rec.status = 200
                res.writeHead(200, {
                    ...base, 'X-Content-Type-Options': 'nosniff',
                    'Content-Type': source.contentType, 'Content-Length': String(source.size)
                })
                if (isHead || source.size === 0)
                    return endResponse(res)
                return this.writeParts(res, rec, source, [[0, source.size - 1]], undefined)
            }

            const { ranges } = sel
            if (ranges.length === 1) {
                const [start, end] = ranges[0]
                rec.status = 206
                res.writeHead(206, {
                    ...base, 'X-Content-Type-Options': 'nosniff',
                    'Content-Type': source.contentType, 'Content-Range': `bytes ${start}-${end}/${source.size}`,
                    'Content-Length': String(end - start + 1)
                })
                if (isHead)
                    return endResponse(res)
                return this.writeParts(res, rec, source, ranges, undefined)
            }

            const boundary = crypto.randomBytes(12).toString('hex')
            const heads = ranges.map(([s, e]) =>
                `--${boundary}\r\nContent-Type: ${source.contentType}\r\nContent-Range: bytes ${s}-${e}/${source.size}\r\n\r\n`)
            const closing = `--${boundary}--\r\n`
            const length = ranges.reduce((sum, [s, e], i) => sum + Buffer.byteLength(heads[i]) + (e - s + 1) + 2, 0) + closing.length

            rec.status = 206
            res.writeHead(206, {
                ...base, 'X-Content-Type-Options': 'nosniff',
                'Content-Type': `multipart/byteranges; boundary=${boundary}`, 'Content-Length': String(length)
            })
            return this.writeParts(res, rec, source, ranges, { heads, closing })
        }
        catch (err) {
            this.logError('serve', err)
            return this.failRequest(res, rec)
        }
    }

    async writeParts(res, rec, source, ranges, multipart) {
        try {
            for (let i = 0; i < ranges.length; i++) {
                const [start, end] = ranges[i]
                if (multipart && !await writeChunk(res, multipart.heads[i]))
                    return false
                if (!await pipeRange(source.createStream(start, end), res, rec))
                    return false
                if (multipart && !await writeChunk(res, '\r\n'))
                    return false
            }
            if (multipart && !await writeChunk(res, multipart.closing))
                return false

            return endResponse(res)
        }
        catch (err) {
            this.logError('writeParts', err)
            return this.failRequest(res, rec)
        }
    }
}

module.exports = { MediaServer, parseRange, LIMITS }
