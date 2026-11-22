const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { servicesLibDir, stubElectron } = require('./loader')
const { createFixtures } = require('./fixtures')
const { sleep, waitFor } = require('./harness')

const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v))

/**
 * The real desktop transport (LocalLinkFeature with its ControlServer/MediaServer/PeerFilter, mDNS
 * announcement and network watcher) driven by the real services host logic (LocalLinkService and
 * RouteSharingService) in one plain Node process. Only the edges are faked:
 *  - `electron` is a stub (the feature only needs ipcMain/app, and never reaches the renderer here),
 *  - the `localLink` binding is a thin in-process adapter that round-trips every call and event
 *    through JSON, like the IPC layer does,
 *  - user settings are an in-memory object that survives simulated restarts,
 *  - the route list is a fixed list of fixture routes, and BRIDGE_MODE is forced on.
 */
class SelfHost {
    constructor({ workDir }) {
        this.workDir = workDir
        this.settings = {}
        this.events = []
        this.listeners = new Set()
        this.fixtures = createFixtures(path.join(workDir, 'media'))
        this.restoreElectron = stubElectron()
        this.lib = servicesLibDir()
        this.booted = false
    }

    load(rel) {
        return require(path.join(this.lib, rel))
    }

    /** Creates a "fresh process": new transport feature, new services singletons. Does not call init(). */
    boot() {
        const LocalLinkFeature = require('../../../src/features/local-link/feature')
        const { Inject } = this.load('base/decorators')
        const { getBindings } = this.load('api/bindings')
        const UserSettingsMock = this.load('settings/service/mock').default
        const { LocalLinkService } = this.load('link/host/service')
        const { RouteSharingService } = this.load('routes/sharing/service')

        this.feature = new LocalLinkFeature()
        this.feature.emitEvent = (event) => {
            const e = clone(event)
            this.events.push({ at: Date.now(), ...e })
            // IPC delivers asynchronously
            setImmediate(() => this.listeners.forEach(cb => cb(clone(e))))
        }

        const feature = this.feature
        const ipc = (fn) => async (...args) => clone(await fn(...clone(args)))
        this.binding = {
            isSupported: () => true,
            getCapabilities: ipc(() => feature.getCapabilities()),
            getStatus: ipc(() => feature.getStatus()),
            start: ipc(o => feature.start(o)),
            stop: ipc(o => feature.stop(o)),
            setPeerPolicy: ipc(p => feature.setPeerPolicy(p)),
            setLimits: ipc(l => feature.setLimits(l)),
            announce: ipc(a => feature.announce(a)),
            reannounce: ipc(() => feature.reannounce()),
            publishMedia: ipc(s => feature.publishMedia(s)),
            send: ipc((id, payload) => feature.send(id, payload)),
            close: ipc((id, reason) => feature.close(id, reason)),
            onEvent: (cb) => { this.listeners.add(cb); return () => this.listeners.delete(cb) },
        }

        const bindings = getBindings()
        bindings.localLink = this.binding
        bindings.crypto = crypto
        bindings.appInfo = { getOS: () => ({ platform: process.platform }), getAppVersion: () => '0.0.0-g1' }
        bindings.fs = { stat: async (p) => require('node:fs').promises.stat(p) }

        this.userSettings = new UserSettingsMock(this.settings)
        Inject('UserSettings', this.userSettings)
        Inject('AppState', { hasFeature: (f) => f === 'BRIDGE_MODE' })

        const list = new EventEmitter()
        list.getAllRoutes = () => this.routes ?? this.fixtures.routes
        list.isStillLoading = () => false
        list.preload = () => undefined
        this.routeList = list
        Inject('RouteList', list)

        this.service = new LocalLinkService()
        this.sharing = new RouteSharingService()
        this.booted = true
    }

    /** App start: what main/renderer do at launch. */
    async init() {
        await this.service.init()
    }

    /** Quit hook and process end: everything in memory is gone, settings stay. */
    async shutdown() {
        await this.feature.shutdown()
        this.sharing.reset()
        this.service.reset()
        const { Inject } = this.load('base/decorators')
        Inject('UserSettings', null)
        Inject('AppState', null)
        Inject('RouteList', null)
        this.listeners.clear()
        this.booted = false
    }

    async restart({ init = true } = {}) {
        await this.shutdown()
        await sleep(300)
        this.boot()
        if (init)
            await this.init()
    }

    // ---- views and levers used by the checks ----

    status() {
        return this.feature.getStatus()
    }

    props() {
        return this.service.getDisplayProps()
    }

    pin() {
        return this.props().connectWindow?.pin
    }

    clients() {
        return this.service.getClients()
    }

    resetRateLimits() {
        const pairing = this.service.pairing
        pairing.peerLimiter.reset()
        pairing.globalLimiter.reset()
        this.service.authLimiter.reset()
    }

    /** Applies short limits so timeouts can be observed in seconds; returns what the transport applied. */
    async setLimits(control, media) {
        return await this.binding.setLimits({ control, media })
    }

    restoreLimits() {
        const { LINK_LIMITS } = this.load('link/host/consts')
        return this.binding.setLimits(LINK_LIMITS)
    }

    /** A desktop-initiated, signed frame on the authenticated connection of a paired phone. */
    async push(clientId, t, body) {
        const conn = [...this.service.connections.values()].find(c => c.clientId === clientId)
        if (!conn)
            throw new Error('no authenticated connection for this client')
        const payload = conn.channel.encode(t, body)
        await this.binding.send(conn.id, payload)
    }

    /** The renderer reloaded: what main does on did-start-navigation of the main frame. */
    rendererReload() {
        this.feature.onRendererGone()
    }

    async waitEvent(pred, timeout = 3000, what = 'event') {
        const seen = this.events.length
        return await waitFor(() => this.events.slice(seen).find(pred), { timeout, what })
    }

    mark() {
        return this.events.length
    }

    eventsSince(mark) {
        return this.events.slice(mark)
    }

    async dispose() {
        try { await this.shutdown() } catch { /* already down */ }
        this.restoreElectron()
    }
}

module.exports = { SelfHost }
