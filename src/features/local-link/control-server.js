const net = require('node:net')
const crypto = require('node:crypto')
const { peerKey } = require('./peer-filter')

const LISTENER = 'control'

const MAGIC = Buffer.from('INCYLINK', 'ascii')
const PREAMBLE_LENGTH = MAGIC.length + 1
const MAX_FRAMING_VERSION = 1
const HEADER_LENGTH = 4

// Pending outbound bytes per connection beyond which the peer is considered stuck
const MAX_PENDING_WRITE = 4 * 1024 * 1024
// Time granted to flush an orderly close before the socket is destroyed
const CLOSE_GRACE_MS = 1000

// Defaults and hard ceilings for the limits values supplied by the renderer
const LIMITS = {
    maxConnections:    { default: 16,    ceiling: 64 },
    maxPerPeer:        { default: 4,     ceiling: 16 },
    preambleTimeoutMs: { default: 5000,  ceiling: 30000 },
    idleTimeoutMs:     { default: 60000, ceiling: 600000 },
    maxFrameBytes:     { default: 16384, ceiling: 1048576 },
    maxFramesPerSec:   { default: 20,    ceiling: 200 },
}

const noopLogger = { logEvent: () => { /* no logging configured */ } }

function clamp(value, spec) {
    if (!Number.isInteger(value) || value < 1)
        return spec.default
    return Math.min(value, spec.ceiling)
}

/**
 * TCP listener for the control channel. It parses only the framing (preamble and length
 * prefixes) and relays frame payloads unparsed; it never looks into the JSON.
 */
class ControlServer {

    /**
     * @param {object} props
     * @param {(event:object)=>void} props.emit            receives transport events
     * @param {import('./peer-filter').PeerFilter} props.peerFilter
     * @param {{logEvent:Function}} [props.logger]         lifecycle and errors (no peer addresses)
     * @param {{logEvent:Function}} [props.requestLogger]  per-connection logs (local file only)
     * @param {()=>void} [props.onAccept]                  called for every accepted connection
     */
    constructor(props) {
        this.emit = props.emit
        this.peerFilter = props.peerFilter
        this.logger = props.logger ?? noopLogger
        this.requestLogger = props.requestLogger ?? noopLogger
        this.onAccept = props.onAccept

        this.limits = this.resolveLimits({})
        this.server = undefined
        this.port = undefined
        this.startPromise = undefined
        this.connections = new Map()    // all sockets, by internal key
        this.established = new Map()    // connectionId -> connection (preamble accepted)
        this.peerCounts = new Map()
    }

    /** Logs a swallowed error (function name and message only: never addresses, tokens or payloads). */
    logError(fn, err) {
        try {
            this.logger.logEvent({ message: 'local-link control error', fn, error: err?.message })
        }
        catch { /* the logger itself failed: nothing left to do */ }
    }

    /** Emits a transport event; a failing consumer (e.g. destroyed webContents) must not throw into a network handler. */
    safeEmit(event) {
        try {
            this.emit(event)
        } catch {
            try {
                this.logger.logEvent({ message: 'local-link control emit failed', type: event?.type })
            }
            catch { /* the logger itself failed: nothing left to do */ }
        }
    }

    isRunning() {
        try {
            return this.server?.listening === true
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

    getConnectionCount() {
        try {
            return this.established.size
        }
        catch (err) {
            this.logError('getConnectionCount', err)
            return 0
        }
    }

    resolveLimits(limits) {
        try {
            return {
                maxConnections:    clamp(limits?.maxConnections, LIMITS.maxConnections),
                maxPerPeer:        clamp(limits?.maxPerPeer, LIMITS.maxPerPeer),
                preambleTimeoutMs: clamp(limits?.preambleTimeoutMs, LIMITS.preambleTimeoutMs),
                idleTimeoutMs:     clamp(limits?.idleTimeoutMs, LIMITS.idleTimeoutMs),
                maxFrameBytes:     clamp(limits?.maxFrameBytes, LIMITS.maxFrameBytes),
                maxFramesPerSec:   clamp(limits?.maxFramesPerSec, LIMITS.maxFramesPerSec),
            }
        }
        catch (err) {
            this.logError('resolveLimits', err)
            return {
                maxConnections: LIMITS.maxConnections.default, maxPerPeer: LIMITS.maxPerPeer.default,
                preambleTimeoutMs: LIMITS.preambleTimeoutMs.default, idleTimeoutMs: LIMITS.idleTimeoutMs.default,
                maxFrameBytes: LIMITS.maxFrameBytes.default, maxFramesPerSec: LIMITS.maxFramesPerSec.default,
            }
        }
    }

    /** Applies control limits (unset values fall back to defaults; all values clamped to the ceilings). */
    setLimits(limits) {
        try {
            this.limits = this.resolveLimits(limits)
            if (this.server)
                this.server.maxConnections = this.limits.maxConnections
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
                    const server = net.createServer(socket => this.onConnection(socket))
                    server.maxConnections = this.limits.maxConnections

                    const onError = (err) => {
                        try {
                            const code = err?.code ?? 'UNKNOWN'
                            this.logger.logEvent({ message: 'local-link control listen failed', code })
                            this.safeEmit({ type: 'error', listener: LISTENER, phase: 'listen', code })
                            resolve({ ok: false, error: { code } })
                        }
                        catch (e) {
                            this.logError('start.onError', e)
                            resolve({ ok: false, error: { code: 'UNKNOWN' } })
                        }
                    }

                    server.once('error', onError)
                    server.listen({ port, host }, () => {
                        try {
                            server.off('error', onError)
                            server.on('error', err => {
                                try {
                                    const code = err?.code ?? 'UNKNOWN'
                                    this.logger.logEvent({ message: 'local-link control listener error', code })
                                    this.safeEmit({ type: 'error', listener: LISTENER, phase: 'runtime', code })
                                }
                                catch (e) {
                                    this.logError('server.onError', e)
                                }
                            })

                            this.server = server
                            this.port = server.address().port
                            this.logger.logEvent({ message: 'local-link control listener started', port: this.port })
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

    /** Closes all connections and the listener. Uses plain close/destroy only. Never rejects. */
    async stop() {
        try {
            const server = this.server
            if (!server)
                return

            this.server = undefined
            this.port = undefined
            this.closeAll('stopped')

            await new Promise(resolve => {
                try {
                    server.close(() => resolve())
                }
                catch (err) {
                    this.logError('stop.close', err)
                    resolve()
                }
            })
            this.logger.logEvent({ message: 'local-link control listener stopped' })
            this.safeEmit({ type: 'stopped', listener: LISTENER })
        }
        catch (err) {
            this.logError('stop', err)
        }
    }

    /** Destroys every connection (used on renderer reload/destroy, stop and quit). */
    closeAll(reason) {
        try {
            for (const conn of [...this.connections.values()])
                this.destroyConnection(conn, reason)
        }
        catch (err) {
            this.logError('closeAll', err)
        }
    }

    /** Orderly close of one connection by id. Unknown ids are ignored. */
    close(connectionId, reason) {
        try {
            const conn = this.established.get(connectionId)
            if (!conn)
                return
            this.endConnection(conn, typeof reason === 'string' && reason !== '' ? reason.slice(0, 64) : 'closed')
        }
        catch (err) {
            this.logError('close', err)
        }
    }

    /** Sends one frame. Resolves false for unknown connections or payloads over the frame limit. */
    send(connectionId, payload) {
        try {
            const conn = this.established.get(connectionId)
            if (!conn || conn.closing || typeof payload !== 'string')
                return false

            const body = Buffer.from(payload, 'utf8')
            if (body.length === 0 || body.length > this.limits.maxFrameBytes)
                return false
            if (conn.socket.writableLength > MAX_PENDING_WRITE) {
                this.destroyConnection(conn, 'backpressure')
                return false
            }

            const header = Buffer.alloc(HEADER_LENGTH)
            header.writeUInt32BE(body.length, 0)
            conn.socket.write(Buffer.concat([header, body]))
            return true
        }
        catch (err) {
            this.logError('send', err)
            return false
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

            const conn = {
                socket,
                key,
                id: crypto.randomBytes(8).toString('hex'),
                peer: { address: socket.remoteAddress, port: socket.remotePort },
                buffer: Buffer.alloc(0),
                established: false,
                closing: false,
                reason: undefined,
                frames: 0,
                windowStart: 0,
                windowCount: 0,
                preambleTimer: undefined,
                idleTimer: undefined,
                graceTimer: undefined,
            }
            this.connections.set(conn, conn)

            socket.setNoDelay?.(true)
            socket.on('data', chunk => this.onData(conn, chunk))
            socket.on('error', () => {
                try { conn.reason ??= 'error' } catch { /* nothing to do */ }
            })
            socket.once('close', () => this.onClosed(conn))

            conn.preambleTimer = setTimeout(() => this.destroyConnection(conn, 'preamble-timeout'), this.limits.preambleTimeoutMs)
            conn.preambleTimer.unref?.()
            this.resetIdle(conn)

            try { this.onAccept?.() } catch { /* never let a hook break the accept path */ }
        }
        catch (err) {
            this.logError('onConnection', err)
            try { socket?.destroy() } catch { /* already gone */ }
        }
    }

    resetIdle(conn) {
        try {
            clearTimeout(conn.idleTimer)
            conn.idleTimer = setTimeout(() => this.destroyConnection(conn, 'idle-timeout'), this.limits.idleTimeoutMs)
            conn.idleTimer.unref?.()
        }
        catch (err) {
            this.logError('resetIdle', err)
        }
    }

    onData(conn, chunk) {
        try {
            if (conn.closing)
                return

            conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, chunk]) : chunk
            this.resetIdle(conn)

            if (!conn.established && !this.processPreamble(conn))
                return
            this.processFrames(conn)
        }
        catch (err) {
            this.logError('onData', err)
            this.destroyConnection(conn, 'error')
        }
    }

    /** Returns true once the preamble is complete and accepted (remaining bytes stay buffered). */
    processPreamble(conn) {
        try {
            const buf = conn.buffer
            const n = Math.min(buf.length, MAGIC.length)
            if (!buf.subarray(0, n).equals(MAGIC.subarray(0, n))) {
                this.refuse(conn, 'bad-preamble')
                return false
            }
            if (buf.length < PREAMBLE_LENGTH)
                return false

            const requested = buf[MAGIC.length]
            if (requested < 1) {
                this.refuse(conn, 'bad-version')
                return false
            }

            const accepted = Math.min(requested, MAX_FRAMING_VERSION)
            conn.buffer = buf.subarray(PREAMBLE_LENGTH)
            conn.established = true
            clearTimeout(conn.preambleTimer)
            conn.preambleTimer = undefined
            this.established.set(conn.id, conn)

            conn.socket.write(Buffer.concat([MAGIC, Buffer.from([accepted])]))
            this.requestLogger.logEvent({ message: 'local-link control connection accepted', framingVersion: accepted })
            this.safeEmit({ type: 'connection', connectionId: conn.id, peer: { ...conn.peer } })
            return true
        }
        catch (err) {
            this.logError('processPreamble', err)
            this.destroyConnection(conn, 'error')
            return false
        }
    }

    processFrames(conn) {
        try {
            while (!conn.closing && conn.buffer.length >= HEADER_LENGTH) {
                const length = conn.buffer.readUInt32BE(0)
                if (length === 0 || length > this.limits.maxFrameBytes) {
                    this.destroyConnection(conn, length === 0 ? 'invalid-frame' : 'frame-too-large')
                    return
                }
                if (conn.buffer.length < HEADER_LENGTH + length)
                    return

                if (!this.allowFrame(conn)) {
                    this.destroyConnection(conn, 'rate-limited')
                    return
                }

                const payload = conn.buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + length).toString('utf8')
                conn.buffer = conn.buffer.subarray(HEADER_LENGTH + length)
                conn.frames++
                this.safeEmit({ type: 'frame', connectionId: conn.id, payload })
            }
        }
        catch (err) {
            this.logError('processFrames', err)
            this.destroyConnection(conn, 'error')
        }
    }

    /** Fixed one-second window per connection. */
    allowFrame(conn) {
        try {
            const now = Date.now()
            if (now - conn.windowStart >= 1000) {
                conn.windowStart = now
                conn.windowCount = 0
            }
            conn.windowCount++
            return conn.windowCount <= this.limits.maxFramesPerSec
        }
        catch (err) {
            this.logError('allowFrame', err)
            return false
        }
    }

    refuse(conn, reason) {
        try {
            this.requestLogger.logEvent({ message: 'local-link control connection refused', reason })
            this.destroyConnection(conn, reason)
        }
        catch (err) {
            this.logError('refuse', err)
        }
    }

    destroyConnection(conn, reason) {
        try {
            conn.reason ??= reason
            conn.closing = true
            conn.socket.destroy()
        }
        catch (err) {
            this.logError('destroyConnection', err)
        }
    }

    /** Lets pending writes flush, then destroys. */
    endConnection(conn, reason) {
        try {
            if (conn.closing)
                return
            conn.reason ??= reason
            conn.closing = true
            conn.socket.end()
            conn.graceTimer = setTimeout(() => {
                try { conn.socket.destroy() }
                catch (err) { this.logError('endConnection.grace', err) }
            }, CLOSE_GRACE_MS)
            conn.graceTimer.unref?.()
        }
        catch (err) {
            this.logError('endConnection', err)
            this.destroyConnection(conn, reason)
        }
    }

    onClosed(conn) {
        try {
            clearTimeout(conn.preambleTimer)
            clearTimeout(conn.idleTimer)
            clearTimeout(conn.graceTimer)
            this.connections.delete(conn)

            const left = (this.peerCounts.get(conn.key) ?? 1) - 1
            if (left <= 0)
                this.peerCounts.delete(conn.key)
            else
                this.peerCounts.set(conn.key, left)

            if (!conn.established)
                return

            this.established.delete(conn.id)
            const reason = conn.reason ?? 'peer-closed'
            this.requestLogger.logEvent({ message: 'local-link control connection closed', reason, frames: conn.frames })
            this.safeEmit({ type: 'connection-closed', connectionId: conn.id, reason })
        }
        catch (err) {
            this.logError('onClosed', err)
        }
    }
}

module.exports = { ControlServer, LIMITS }
