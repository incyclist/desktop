const { ipcMain } = require('electron')
const { ipcHandle, ipcCall, ipcSubscribe, ipcSendEvent } = require('../utils')
const { EventLogger } = require('gd-eventlog')
const Feature = require('../base')
const { PeerFilter } = require('./peer-filter')
const { MediaServer } = require('./media-server')
const { listLocalAddresses } = require('./network')

const TRANSPORT_VERSION = 1
const EVENT_CHANNEL = 'local-link-event'

// Capability names announced by getCapabilities(); later installers add to this list
const CAPABILITIES = ['http-media', 'range', 'peer-filter']

class LocalLinkFeature extends Feature {

    static _instance

    constructor() {
        super()
        this.logger = new EventLogger('LocalLink')
        this.requestLogger = new EventLogger('LocalLinkRequests')
        this.emitEvent = this.emitEvent.bind(this)

        // shared by every listener of the transport
        this.peerFilter = new PeerFilter({
            onRefused: (listener, addressClass, count) =>
                this.emitEvent({ type: 'peer-refused', listener, addressClass, count })
        })

        this.media = new MediaServer({
            emit: this.emitEvent,
            peerFilter: this.peerFilter,
            logger: this.logger,
            requestLogger: this.requestLogger,
        })
    }

    static getInstance() {
        if (!LocalLinkFeature._instance)
            LocalLinkFeature._instance = new LocalLinkFeature()
        return LocalLinkFeature._instance
    }

    emitEvent(event) {
        ipcSendEvent(EVENT_CHANNEL, event)
    }

    // --- implementation methods (tested directly in unit tests) ---

    async getCapabilities() {
        return { transportVersion: TRANSPORT_VERSION, capabilities: [...CAPABILITIES] }
    }

    async getStatus() {
        const { handleCount, tokenCount } = this.media.getStats()
        return {
            running: { control: false, media: this.media.isRunning() },
            ports: { media: this.media.getPort() },
            addresses: listLocalAddresses(),
            announced: null,
            connections: 0,
            handleCount,
            tokenCount,
        }
    }

    async start(opts = {}) {
        const result = { addresses: listLocalAddresses() }
        if (opts?.media)
            result.media = await this.media.start(opts.media)
        return result
    }

    async stop(opts) {
        const listener = opts?.listener
        if (!listener || listener === 'media')
            await this.media.stop()
        return { ok: true }
    }

    async setPeerPolicy(policy) {
        return this.peerFilter.setPolicy(policy)
    }

    async publishMedia(state) {
        return this.media.publish(state)
    }

    // --- IPC wiring ---

    register(_props) {
        ipcHandle('local-link-get-capabilities', this.getCapabilities.bind(this), ipcMain)
        ipcHandle('local-link-get-status', this.getStatus.bind(this), ipcMain)
        ipcHandle('local-link-start', this.start.bind(this), ipcMain)
        ipcHandle('local-link-stop', this.stop.bind(this), ipcMain)
        ipcHandle('local-link-set-peer-policy', this.setPeerPolicy.bind(this), ipcMain)
        ipcHandle('local-link-publish-media', this.publishMedia.bind(this), ipcMain)
    }

    registerRenderer(spec, ipcRenderer) {
        spec.localLink = { transportVersion: TRANSPORT_VERSION }

        spec.localLink.getCapabilities = ipcCall('local-link-get-capabilities', ipcRenderer)
        spec.localLink.getStatus = ipcCall('local-link-get-status', ipcRenderer)
        spec.localLink.start = ipcCall('local-link-start', ipcRenderer)
        spec.localLink.stop = ipcCall('local-link-stop', ipcRenderer)
        spec.localLink.setPeerPolicy = ipcCall('local-link-set-peer-policy', ipcRenderer)
        spec.localLink.publishMedia = ipcCall('local-link-publish-media', ipcRenderer)

        // returns a function that removes only this listener
        spec.localLink.onEvent = ipcSubscribe(EVENT_CHANNEL, ipcRenderer)

        spec.registerFeatures(['local-link'])
    }
}

module.exports = LocalLinkFeature
