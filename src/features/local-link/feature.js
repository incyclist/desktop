const { ipcMain, app } = require('electron')
const { ipcHandle, ipcCall, ipcSubscribe, ipcSendEvent } = require('../utils')
const { EventLogger } = require('gd-eventlog')
const { Bonjour } = require('bonjour-service')
const Feature = require('../base')
const { PeerFilter } = require('./peer-filter')
const { MediaServer } = require('./media-server')
const { ControlServer } = require('./control-server')
const { listLocalAddresses } = require('./network')

const TRANSPORT_VERSION = 1
const EVENT_CHANNEL = 'local-link-event'

// Service type is _incyclist._tcp (bonjour-service takes the bare name and the protocol separately)
const SERVICE_TYPE = 'incyclist'
const SERVICE_PROTOCOL = 'tcp'

const NETWORK_POLL_MS = 5000

// Upper bound for sending the mDNS goodbye records before the sockets are closed
const GOODBYE_TIMEOUT_MS = 1000

const MAX_INSTANCE_NAME_BYTES = 63
const INSTANCE_NAME = /^[^\x00-\x1f\x7f]+$/u
const HOST_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

// Capability names announced by getCapabilities(); later installers add to this list
const CAPABILITIES = ['http-media', 'range', 'peer-filter', 'tcp-control', 'reannounce', 'network-watch']

const addressKey = (a) => `${a.interface}|${a.family}|${a.address}`

class LocalLinkFeature extends Feature {

    static _instance

    constructor() {
        super()
        this.logger = new EventLogger('LocalLink')
        // per-request and per-connection lines: local file only, never forwarded (see utils/logging.js)
        this.requestLogger = new EventLogger('LocalLinkRequests')
        this.emitEvent = this.emitEvent.bind(this)
        this.listAddresses = listLocalAddresses

        // shared by every listener of the transport
        this.peerFilter = new PeerFilter({
            logger: this.logger,
            onRefused: (listener, addressClass, count) =>
                this.emitEvent({ type: 'peer-refused', listener, addressClass, count })
        })

        this.media = new MediaServer({
            emit: (event) => this.emitEvent(event),
            peerFilter: this.peerFilter,
            logger: this.logger,
            requestLogger: this.requestLogger,
        })

        this.control = new ControlServer({
            emit: (event) => this.emitEvent(event),
            peerFilter: this.peerFilter,
            logger: this.logger,
            requestLogger: this.requestLogger,
            onAccept: () => this.watchRenderer(),
        })

        this.bonjour = undefined
        this.announcement = undefined
        this.service = undefined

        this.watchedContents = new WeakSet()
        this.watcher = undefined
        this.knownAddresses = undefined
    }

    static getInstance() {
        if (!LocalLinkFeature._instance)
            LocalLinkFeature._instance = new LocalLinkFeature()
        return LocalLinkFeature._instance
    }

    /** Logs a swallowed error (function name and message only: never addresses, tokens, secrets or payloads). */
    logError(fn, err) {
        try {
            this.logger.logEvent({ message: 'local-link error', fn, error: err?.message })
        }
        catch { /* the logger itself failed: nothing left to do */ }
    }

    emitEvent(event) {
        try {
            ipcSendEvent(EVENT_CHANNEL, event)
        }
        catch (err) {
            this.logError('emitEvent', err)
        }
    }

    // --- implementation methods (tested directly in unit tests) ---

    async getCapabilities() {
        try {
            return { transportVersion: TRANSPORT_VERSION, capabilities: [...CAPABILITIES] }
        }
        catch (err) {
            this.logError('getCapabilities', err)
            return { transportVersion: 0, capabilities: [] }
        }
    }

    async getStatus() {
        try {
            const { handleCount, tokenCount } = this.media.getStats()
            return {
                running: { control: this.control.isRunning(), media: this.media.isRunning() },
                ports: { control: this.control.getPort(), media: this.media.getPort() },
                addresses: this.listAddresses(),
                announced: this.announcement ? { instanceName: this.announcement.instanceName } : null,
                connections: this.control.getConnectionCount(),
                handleCount,
                tokenCount,
            }
        }
        catch (err) {
            this.logError('getStatus', err)
            return { running: { control: false, media: false }, ports: {}, addresses: [], announced: null, connections: 0, handleCount: 0, tokenCount: 0 }
        }
    }

    async start(opts = {}) {
        try {
            const result = { addresses: this.listAddresses() }

            // each listener reports its own outcome, so one EADDRINUSE does not hide the other
            if (opts?.control)
                result.control = await this.control.start(opts.control)
            if (opts?.media)
                result.media = await this.media.start(opts.media)

            if (result.control?.ok || result.media?.ok) {
                this.watchRenderer()
                this.startWatcher()
            }
            return result
        }
        catch (err) {
            this.logError('start', err)
            const failed = { addresses: [] }
            if (opts?.control) failed.control = { ok: false, error: { code: 'UNKNOWN' } }
            if (opts?.media) failed.media = { ok: false, error: { code: 'UNKNOWN' } }
            return failed
        }
    }

    async stop(opts) {
        try {
            const listener = opts?.listener
            if (!listener || listener === 'control') {
                // the announcement points at the control port, so it goes with the listener
                await this.withdraw()
                await this.control.stop()
            }
            if (!listener || listener === 'media')
                await this.media.stop()

            if (!this.control.isRunning() && !this.media.isRunning())
                this.stopWatcher()
            return { ok: true }
        }
        catch (err) {
            this.logError('stop', err)
            return { ok: false }
        }
    }

    async setPeerPolicy(policy) {
        try {
            return this.peerFilter.setPolicy(policy)
        }
        catch (err) {
            this.logError('setPeerPolicy', err)
            return { ok: false, error: 'internal error' }
        }
    }

    async setLimits(limits) {
        try {
            const applied = {}
            if (limits?.control && typeof limits.control === 'object')
                applied.control = this.control.setLimits(limits.control)
            if (limits?.media && typeof limits.media === 'object')
                applied.media = this.media.setLimits(limits.media)
            return { ok: true, applied }
        }
        catch (err) {
            this.logError('setLimits', err)
            return { ok: false, applied: {} }
        }
    }

    async publishMedia(state) {
        try {
            return this.media.publish(state)
        }
        catch (err) {
            this.logError('publishMedia', err)
            return { ok: false, rejectedHandles: [], rejectedTokens: 0 }
        }
    }

    async send(connectionId, payload) {
        try {
            return { ok: this.control.send(connectionId, payload) }
        }
        catch (err) {
            this.logError('send', err)
            return { ok: false }
        }
    }

    async close(connectionId, reason) {
        try {
            this.control.close(connectionId, reason)
        }
        catch (err) {
            this.logError('close', err)
        }
    }

    // --- mDNS ---

    /** Validates only; the instance name and host label are composed by the renderer. */
    validateAnnouncement(a) {
        try {
            if (typeof a?.instanceName !== 'string' || a.instanceName === ''
                || Buffer.byteLength(a.instanceName, 'utf8') > MAX_INSTANCE_NAME_BYTES
                || !INSTANCE_NAME.test(a.instanceName))
                return 'invalid instanceName'
            if (typeof a.hostLabel !== 'string' || !HOST_LABEL.test(a.hostLabel))
                return 'invalid hostLabel'

            const port = a.port ?? this.control.getPort()
            if (port === undefined)
                return 'control listener not running'
            if (!Number.isInteger(port) || port < 1 || port > 65535)
                return 'invalid port'
            return undefined
        }
        catch (err) {
            this.logError('validateAnnouncement', err)
            return 'invalid announcement'
        }
    }

    async announce(a) {
        try {
            if (a === null || a === undefined) {
                this.withdraw()
                return { ok: true }
            }

            const error = this.validateAnnouncement(a)
            if (error)
                return { ok: false, error }

            this.withdraw()
            this.announcement = {
                instanceName: a.instanceName, hostLabel: a.hostLabel, port: a.port ?? this.control.getPort()
            }
            return this.publish()
        }
        catch (err) {
            this.logError('announce', err)
            return { ok: false, error: 'announce failed' }
        }
    }

    publish() {
        try {
            const { instanceName, hostLabel, port } = this.announcement
            try {
                // a dedicated instance: direct-connect's browse instance has its own lifecycle
                this.bonjour = new Bonjour()
                const service = this.bonjour.publish({
                    name: instanceName, type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL, port,
                    // never derived from the OS hostname
                    host: `${hostLabel}.local`,
                })
                this.service = service
                service?.on?.('up', () => {
                    if (this.service === service)
                        this.emitEvent({ type: 'announced', instanceName })
                })
                service?.on?.('error', (err) => this.onAnnounceError(err, service))
                this.logger.logEvent({ message: 'local-link announce published', port })
                return { ok: true }
            }
            catch (err) {
                this.onAnnounceError(err)
                this.destroyBonjour()
                this.announcement = undefined
                return { ok: false, error: err?.code ?? 'announce failed' }
            }
        }
        catch (err) {
            this.logError('publish', err)
            return { ok: false, error: 'announce failed' }
        }
    }

    onAnnounceError(err, service) {
        try {
            if (service && this.service !== service)
                return
            const code = err?.code ?? 'UNKNOWN'
            this.logger.logEvent({ message: 'local-link announce failed', code })
            this.emitEvent({ type: 'announce-error', code })
        }
        catch (err) {
            this.logError('onAnnounceError', err)
        }
    }

    /**
     * Tears the Bonjour instance down. destroy() alone only closes the sockets: the records stay cached
     * on other browsers until their TTL ran out. unpublishAll() first sends the goodbye (TTL 0) records,
     * so the entry disappears (and, for a reannounce, reappears) right away. Resolves once the goodbye
     * is out, or after a short timeout.
     */
    destroyBonjour() {
        try {
            const bonjour = this.bonjour
            this.bonjour = undefined
            this.service = undefined
            if (!bonjour)
                return Promise.resolve()

            return new Promise(resolve => {
                let done = false
                let timer
                const finish = () => {
                    if (done)
                        return
                    done = true
                    clearTimeout(timer)
                    try { bonjour.destroy() } catch (err) {
                        this.logger.logEvent({ message: 'local-link bonjour destroy failed', error: err?.message })
                    }
                    resolve()
                }
                timer = setTimeout(finish, GOODBYE_TIMEOUT_MS)
                timer.unref?.()
                try {
                    if (typeof bonjour.unpublishAll === 'function')
                        bonjour.unpublishAll(finish)
                    else
                        finish()
                }
                catch { finish() }
            })
        }
        catch (err) {
            this.logError('destroyBonjour', err)
            return Promise.resolve()
        }
    }

    /** Withdraws the announcement and sends the mDNS goodbye. The returned promise resolves once it is out. */
    withdraw() {
        try {
            const had = this.announcement !== undefined
            this.announcement = undefined
            const gone = this.destroyBonjour()
            if (had)
                this.logger.logEvent({ message: 'local-link announce withdrawn' })
            return gone
        }
        catch (err) {
            this.logError('withdraw', err)
            return Promise.resolve()
        }
    }

    /** Destroys and recreates the Bonjour instance, then publishes on the current interfaces. */
    async reannounce() {
        try {
            if (!this.announcement)
                return { ok: false }
            this.destroyBonjour()
            return this.publish()
        }
        catch (err) {
            this.logError('reannounce', err)
            return { ok: false }
        }
    }

    // --- network watcher ---

    startWatcher() {
        try {
            if (this.watcher)
                return

            this.knownAddresses = this.listAddresses()
            this.watcher = { timer: setInterval(() => this.checkNetwork(), NETWORK_POLL_MS) }
            this.watcher.timer.unref?.()

            try {
                const powerMonitor = require('electron').powerMonitor
                if (powerMonitor?.on) {
                    const onResume = () => this.emitEvent({ type: 'resumed' })
                    powerMonitor.on('resume', onResume)
                    powerMonitor.on('unlock-screen', onResume)
                    this.watcher.power = { powerMonitor, onResume }
                }
            }
            catch (err) {
                this.logger.logEvent({ message: 'local-link power monitor unavailable', error: err?.message })
            }
        }
        catch (err) {
            this.logError('startWatcher', err)
        }
    }

    stopWatcher() {
        try {
            const watcher = this.watcher
            if (!watcher)
                return
            this.watcher = undefined
            this.knownAddresses = undefined

            clearInterval(watcher.timer)
            const { powerMonitor, onResume } = watcher.power ?? {}
            powerMonitor?.removeListener?.('resume', onResume)
            powerMonitor?.removeListener?.('unlock-screen', onResume)
        }
        catch (err) {
            this.logError('stopWatcher', err)
        }
    }

    /** Emits network-changed if the set of non-internal interface addresses differs from the last poll. */
    checkNetwork() {
        try {
            const addresses = this.listAddresses()
            const keys = (list) => list.filter(a => !a.internal).map(addressKey).sort().join(',')
            const changed = this.knownAddresses === undefined || keys(addresses) !== keys(this.knownAddresses)
            this.knownAddresses = addresses
            if (changed)
                this.emitEvent({ type: 'network-changed', addresses })
        }
        catch (err) {
            this.logError('checkNetwork', err)
        }
    }

    // --- renderer lifetime ---

    /**
     * Control sessions are keyed in the renderer, so they must not outlive it. Listeners, media
     * state and the announcement stay. The webContents is watched only once.
     */
    watchRenderer() {
        try {
            let contents
            let win
            try {
                win = app.incyclistApp?.getMainWindow?.()?.win
                contents = win?.webContents
            }
            catch { return }
            if (!contents?.on || this.watchedContents.has(contents))
                return
            this.watchedContents.add(contents)

            contents.on('render-process-gone', () => this.onRendererGone())
            contents.on('destroyed', () => this.onRendererGone())
            win?.once?.('closed', () => this.onRendererGone())
        }
        catch (err) {
            this.logError('watchRenderer', err)
        }
    }

    onRendererGone() {
        try {
            this.control.closeAll('renderer-gone')
        }
        catch (err) {
            this.logError('onRendererGone', err)
        }
    }

    /** Quit hook: plain close/destroy only, so it cannot trigger the native-transport shutdown crash. */
    async shutdown() {
        try {
            this.stopWatcher()
            const goodbye = this.withdraw()
            this.control.closeAll('quit')
            await this.control.stop()
            await this.media.stop()
            this.peerFilter.dispose()
            await goodbye
        }
        catch (err) {
            this.logError('shutdown', err)
        }
    }

    // --- IPC wiring ---

    register(_props) {
        try {
            ipcHandle('local-link-get-capabilities', this.getCapabilities.bind(this), ipcMain)
            ipcHandle('local-link-get-status', this.getStatus.bind(this), ipcMain)
            ipcHandle('local-link-start', this.start.bind(this), ipcMain)
            ipcHandle('local-link-stop', this.stop.bind(this), ipcMain)
            ipcHandle('local-link-set-peer-policy', this.setPeerPolicy.bind(this), ipcMain)
            ipcHandle('local-link-publish-media', this.publishMedia.bind(this), ipcMain)
            ipcHandle('local-link-set-limits', this.setLimits.bind(this), ipcMain)
            ipcHandle('local-link-announce', this.announce.bind(this), ipcMain)
            ipcHandle('local-link-reannounce', this.reannounce.bind(this), ipcMain)
            ipcHandle('local-link-send', this.send.bind(this), ipcMain)
            ipcHandle('local-link-close', this.close.bind(this), ipcMain)

            app.incyclistApp?.registerQuitHook(() => this.shutdown())
        }
        catch (err) {
            this.logError('register', err)
        }
    }

    registerRenderer(spec, ipcRenderer) {
        try {
            spec.localLink = { transportVersion: TRANSPORT_VERSION }

            spec.localLink.getCapabilities = ipcCall('local-link-get-capabilities', ipcRenderer)
            spec.localLink.getStatus = ipcCall('local-link-get-status', ipcRenderer)
            spec.localLink.start = ipcCall('local-link-start', ipcRenderer)
            spec.localLink.stop = ipcCall('local-link-stop', ipcRenderer)
            spec.localLink.setPeerPolicy = ipcCall('local-link-set-peer-policy', ipcRenderer)
            spec.localLink.publishMedia = ipcCall('local-link-publish-media', ipcRenderer)
            spec.localLink.setLimits = ipcCall('local-link-set-limits', ipcRenderer)
            spec.localLink.announce = ipcCall('local-link-announce', ipcRenderer)
            spec.localLink.reannounce = ipcCall('local-link-reannounce', ipcRenderer)
            spec.localLink.send = ipcCall('local-link-send', ipcRenderer)
            spec.localLink.close = ipcCall('local-link-close', ipcRenderer)

            // returns a function that removes only this listener
            spec.localLink.onEvent = ipcSubscribe(EVENT_CHANNEL, ipcRenderer)

            spec.registerFeatures(['local-link'])
        }
        catch (err) {
            this.logError('registerRenderer', err)
        }
    }
}

module.exports = LocalLinkFeature
