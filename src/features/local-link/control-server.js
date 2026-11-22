const net = require('node:net')
const crypto = require('node:crypto')
const { normalizeAddress } = require('./peer-filter')

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
    maxFrameBytes:     { default: 65536, ceiling: 1048576 },
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

    isRunning() {
        return this.server?.listening === true
    }

    getPort() {
        return this.isRunning() ? this.port : undefined
    }

    getConnectionCount() {
        return this.established.size
    }

    resolveLimits(limits) {
        return {
            maxConnections:    clamp(limits?.maxConnections, LIMITS.maxConnections),
            maxPerPeer:        clamp(limits?.maxPerPeer, LIMITS.maxPerPeer),
            preambleTimeoutMs: clamp(limits?.preambleTimeoutMs, LIMITS.preambleTimeoutMs),
            idleTimeoutMs:     clamp(limits?.idleTimeoutMs, LIMITS.idleTimeoutMs),
            maxFrameBytes:     clamp(limits?.maxFrameBytes, LIMITS.maxFrameBytes),
            maxFramesPerSec:   clamp(limits?.maxFramesPerSec, LIMITS.maxFramesPerSec),
        }
    }

    /** Applies control limits (unset values fall back to defaults; all values clamped to the ceilings). */
    setLimits(limits) {
        this.limits = this.resolveLimits(limits)
        if (this.server)
            this.server.maxConnections = this.limits.maxConnections
        return { ...this.limits }
    }

    /** Starts the listener. Resolves with a ListenerResult; never rejects. */
    start(opts = {}) {
        if (this.isRunning())
            return Promise.resolve({ ok: true, port: this.port, alreadyRunning: true })
        if (this.startPromise)
            return this.startPromise

        const port = opts.port ?? 0
        const host = opts.host ?? '0.0.0.0'
        if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof host !== 'string' || host === '')
            return Promise.resolve({ ok: false, error: { code: 'EINVAL' } })

        this.startPromise = new Promise(resolve => {
            const server = net.createServer(socket => this.onConnection(socket))
            server.maxConnections = this.limits.maxConnections

            const onError = (err) => {
                const code = err?.code ?? 'UNKNOWN'
                this.logger.logEvent({ message: 'local-link control listen failed', code })
                this.emit({ type: 'error', listener: LISTENER, phase: 'listen', code })
                resolve({ ok: false, error: { code } })
            }

            server.once('error', onError)
            server.listen({ port, host }, () => {
                server.off('error', onError)
                server.on('error', err => {
                    const code = err?.code ?? 'UNKNOWN'
                    this.logger.logEvent({ message: 'local-link control listener error', code })
                    this.emit({ type: 'error', listener: LISTENER, phase: 'runtime', code })
                })

                this.server = server
                this.port = server.address().port
                this.logger.logEvent({ message: 'local-link control listener started', port: this.port })
                this.emit({ type: 'started', listener: LISTENER, port: this.port })
                resolve({ ok: true, port: this.port })
            })
        }).finally(() => { this.startPromise = undefined })

        return this.startPromise
    }

    /** Closes all connections and the listener. Uses plain close/destroy only. */
    async stop() {
        const server = this.server
        if (!server)
            return

        this.server = undefined
        this.port = undefined
        this.closeAll('stopped')

        await new Promise(resolve => server.close(() => resolve()))
        this.logger.logEvent({ message: 'local-link control listener stopped' })
        this.emit({ type: 'stopped', listener: LISTENER })
    }

    /** Destroys every connection (used on renderer reload/destroy, stop and quit). */
    closeAll(reason) {
        for (const conn of [...this.connections.values()])
            this.destroyConnection(conn, reason)
    }

    /** Orderly close of one connection by id. Unknown ids are ignored. */
    close(connectionId, reason) {
        const conn = this.established.get(connectionId)
        if (!conn)
            return
        this.endConnection(conn, typeof reason === 'string' && reason !== '' ? reason.slice(0, 64) : 'closed')
    }

    /** Sends one frame. Resolves false for unknown connections or payloads over the frame limit. */
    send(connectionId, payload) {
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

    onConnection(socket) {
        if (!this.peerFilter.guard(LISTENER, socket))
            return

        const key = normalizeAddress(socket.remoteAddress)?.value.toString() ?? 'unknown'
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
        socket.on('error', () => { conn.reason ??= 'error' })
        socket.once('close', () => this.onClosed(conn))

        conn.preambleTimer = setTimeout(() => this.destroyConnection(conn, 'preamble-timeout'), this.limits.preambleTimeoutMs)
        conn.preambleTimer.unref?.()
        this.resetIdle(conn)

        try { this.onAccept?.() } catch { /* never let a hook break the accept path */ }
    }

    resetIdle(conn) {
        clearTimeout(conn.idleTimer)
        conn.idleTimer = setTimeout(() => this.destroyConnection(conn, 'idle-timeout'), this.limits.idleTimeoutMs)
        conn.idleTimer.unref?.()
    }

    onData(conn, chunk) {
        if (conn.closing)
            return

        conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, chunk]) : chunk
        this.resetIdle(conn)

        if (!conn.established && !this.processPreamble(conn))
            return
        this.processFrames(conn)
    }

    /** Returns true once the preamble is complete and accepted (remaining bytes stay buffered). */
    processPreamble(conn) {
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
        this.emit({ type: 'connection', connectionId: conn.id, peer: { ...conn.peer } })
        return true
    }

    processFrames(conn) {
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
            this.emit({ type: 'frame', connectionId: conn.id, payload })
        }
    }

    /** Fixed one-second window per connection. */
    allowFrame(conn) {
        const now = Date.now()
        if (now - conn.windowStart >= 1000) {
            conn.windowStart = now
            conn.windowCount = 0
        }
        conn.windowCount++
        return conn.windowCount <= this.limits.maxFramesPerSec
    }

    refuse(conn, reason) {
        this.requestLogger.logEvent({ message: 'local-link control connection refused', reason })
        this.destroyConnection(conn, reason)
    }

    destroyConnection(conn, reason) {
        conn.reason ??= reason
        conn.closing = true
        conn.socket.destroy()
    }

    /** Lets pending writes flush, then destroys. */
    endConnection(conn, reason) {
        if (conn.closing)
            return
        conn.reason ??= reason
        conn.closing = true
        conn.socket.end()
        conn.graceTimer = setTimeout(() => conn.socket.destroy(), CLOSE_GRACE_MS)
        conn.graceTimer.unref?.()
    }

    onClosed(conn) {
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
        this.emit({ type: 'connection-closed', connectionId: conn.id, reason })
    }
}

module.exports = { ControlServer, LIMITS }
