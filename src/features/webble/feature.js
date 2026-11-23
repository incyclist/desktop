const { app, ipcMain } = require('electron')
const { ipcHandleNoResponse, ipcHandleSync, ipcCallSync, ipcCallNoResponse } = require('../utils')
const Feature = require('../base')
const WebBleIpcBinding = require('./ipc-binding')
const WebBleDeviceCache = require('./device-cache')
const { EventLogger } = require('gd-eventlog')

const CONNECT_TARGET_TIMEOUT = 30 * 1000

// how long a device that just failed its GATT probe is skipped for, so it doesn't
// keep re-winning the chooser's next slot at the expense of other devices (e.g. a
// nearby non-fitness BLE device that will never connect). Devices we've explicitly
// asked to connect to (connectTargetMacs) are exempt — see _inCooldown().
const PROBE_FAILURE_COOLDOWN = 60 * 1000

// Some devices (e.g. speakers, earbuds) advertise under a rotating random address, so every few seconds
// they show up as a "new" device with the same name and the per-address cooldown never applies. A name is
// therefore also skipped once probes under it failed on at least NAME_BLOCK_MIN_MACS different addresses
// within NAME_FAILURE_WINDOW. Never for a name that has a working device (several real devices can share a
// name, e.g. two "Volt": one unresponsive trainer must not hide the other), and it expires on its own.
const NAME_BLOCK_MIN_MACS = 2
const NAME_FAILURE_WINDOW = 5 * 60 * 1000

// linux has no native BLE binding, so WebBLE is its only option. win32 has WinrtBindings
// as the default and stable path — WebBLE is announced there too so web-ui can opt
// specific users into it behind a feature toggle, without desktop needing to know
// about that toggle itself.
const SUPPORTED_PLATFORMS = new Set(['linux', 'win32'])

class WebBleFeature extends Feature {
    static _instance

    constructor() {
        super()
        this.logger = new EventLogger('WebBLE')
        this.deviceCache = WebBleDeviceCache.getInstance()

        // Scanning and connecting are independent: a connect request must never
        // stop the request loop, otherwise no further devices get discovered.
        this.scanning = false
        this.connectTargetId = null          // MAC of the device a connect is waiting for
        this.connectTargetExpires = 0

        this.pendingCallback = null          // parked select-bluetooth-device callback
        this.lastDeviceList = []             // device list of the most recent event
        this.discoveredDeviceIds = new Set() // MACs approved in the current scan
        this.skipLoggedIds = new Set()       // MACs whose skip reason was logged in the current scan

        // deviceName → Set<MAC>. Device names are NOT unique (e.g. two "Zwift Click"
        // controllers), so a name can map to several MACs.
        this.deviceMacsByName = new Map()

        // The approval the renderer has not consumed yet. Exactly one device is
        // approved per requestDevice call, so this maps 1:1 to the device object
        // that requestDevice resolves with — consumed via takeApproved().
        this.lastApproved = null             // { deviceId, deviceName }

        // MACs ever explicitly requested via connect() (i.e. a device the app already
        // knows about and specifically wants) — these never get cooled down, however
        // often their probe fails. Deliberately never reset by startScan(): unlike
        // discoveredDeviceIds, "this is a device we care about" doesn't expire per scan.
        this.connectTargetMacs = new Set()
        // deviceId → cooldown-expiry timestamp. Skips a device that just failed its
        // GATT probe so it doesn't keep re-winning the chooser's next slot at the
        // expense of other devices. Also not reset by startScan() — that reset is
        // exactly what let a persistently-failing device win every fresh scan cycle.
        this.probeCooldowns = new Map()
        // deviceName → Map<MAC, timestamp of its last failed probe>, see NAME_BLOCK_MIN_MACS
        this.nameFailures = new Map()

        this._scanLoopTimeout = null
        this._iterationInFlight = false
        this._lastLoggedDeviceIds = null
    }

    static getInstance() {
        if (!WebBleFeature._instance)
            WebBleFeature._instance = new WebBleFeature()
        return WebBleFeature._instance
    }

    getBinding() {
        return WebBleIpcBinding.getInstance()
    }

    _hasConnectTarget() {
        if (this.connectTargetId && Date.now() > this.connectTargetExpires) {
            this.logger.logEvent({ message: 'connect target expired', deviceId: this.connectTargetId })
            this.connectTargetId = null
        }
        return !!this.connectTargetId
    }

    _shouldLoop() {
        return this.scanning || this._hasConnectTarget()
    }

    /**
     * A device we explicitly asked to connect to — this session (connectTargetMacs)
     * or a previous one (persisted device cache) — is never in cooldown. For anything
     * else, an unexpired cooldown entry (set via reportProbeFailed) excludes it from
     * the next chooser slot.
     */
    _inCooldown(deviceId) {
        if (this.connectTargetMacs.has(deviceId) || this.deviceCache.isGood(deviceId)) return false
        const expires = this.probeCooldowns.get(deviceId)
        if (!expires) return false
        if (Date.now() > expires) {
            this.probeCooldowns.delete(deviceId)
            return false
        }
        return true
    }

    /** Addresses under which probes of this name failed recently (older failures expire). */
    _recentNameFailures(name) {
        const failures = this.nameFailures.get(name)
        if (!failures) return []
        const limit = Date.now() - NAME_FAILURE_WINDOW
        for (const [mac, ts] of failures) {
            if (ts < limit) failures.delete(mac)
        }
        if (failures.size === 0) this.nameFailures.delete(name)
        return Array.from(failures.keys())
    }

    _isWorkingDevice(deviceId) {
        return this.connectTargetMacs.has(deviceId) || this.deviceCache.isGood(deviceId)
    }

    /** True if any address seen under this name is a device we use or have connected to successfully. */
    _nameHasWorkingDevice(name) {
        const macs = this.deviceMacsByName.get(name)
        return !!macs && Array.from(macs).some(mac => this._isWorkingDevice(mac))
    }

    /**
     * A device is skipped by name if its name keeps failing under different addresses (rotating address).
     * Devices we use (explicit connect target / known good) and names with a working device are never blocked.
     */
    _isNameBlocked(name, deviceId) {
        if (!name || this._isWorkingDevice(deviceId) || this._nameHasWorkingDevice(name)) return false
        return this._recentNameFailures(name).length >= NAME_BLOCK_MIN_MACS
    }

    _recordNameFailure(deviceId, name) {
        if (!name) return
        const wasBlocked = this._recentNameFailures(name).length >= NAME_BLOCK_MIN_MACS
        const failures = this.nameFailures.get(name) ?? new Map()
        failures.set(deviceId, Date.now())
        this.nameFailures.set(name, failures)

        const macs = this._recentNameFailures(name).length
        if (!wasBlocked && macs >= NAME_BLOCK_MIN_MACS && !this._nameHasWorkingDevice(name)) {
            this.logger.logEvent({ message: 'name cooldown', deviceName: name, macs, cooldownMs: NAME_FAILURE_WINDOW })
        }
    }

    /**
     * Relays a log event from the renderer (ipc-binding.js). The renderer can't use
     * gd-eventlog directly for this: it's loaded via the preload's own require() graph,
     * a different module instance than the one web-ui's bundle registers adapters on —
     * so a renderer-local EventLogger would silently have no adapters. Routing through
     * here reuses this (main-process) logger, which already has them.
     */
    log(event) {
        this.logger.logEvent(event)
    }

    /**
     * Called (via IPC) by the renderer when a device's GATT probe fails after
     * retries. Devices we explicitly requested via connect() are exempt — we want
     * those retried as eagerly as possible, not deprioritized. Anything else is
     * also recorded in the persisted device cache — repeated failures across
     * sessions eventually blacklist a device outright (see device-cache.js).
     */
    reportProbeFailed(deviceId, deviceName) {
        if (this.connectTargetMacs.has(deviceId)) {
            this.logger.logEvent({ message: 'probe failed, retrying eagerly (explicitly requested device)', deviceId })
            return
        }
        this.probeCooldowns.set(deviceId, Date.now() + PROBE_FAILURE_COOLDOWN)
        this.logger.logEvent({ message: 'probe failed, entering cooldown', deviceId, cooldownMs: PROBE_FAILURE_COOLDOWN })
        this.deviceCache.recordFailure(deviceId, deviceName)
        this._recordNameFailure(deviceId, deviceName)
    }

    /**
     * Called (via IPC) when a device's full GATT service list — successfully read,
     * unlike a probe failure — shares nothing with our known fitness services. A
     * stronger, immediate signal than reportProbeFailed: the connection worked, so
     * this isn't a fluke, it's confirmed to be the wrong kind of device. Blacklists
     * outright instead of waiting for repeated misses.
     */
    reportUnsupportedDevice(deviceId, deviceName) {
        if (this.connectTargetMacs.has(deviceId)) return
        this.deviceCache.markBad(deviceId, deviceName)
        this.logger.logEvent({ message: 'device confirmed unsupported', deviceId, deviceName })
        // counts as a failure of this name, same as a failed probe (rotating-address devices often connect once)
        this._recordNameFailure(deviceId, deviceName)
    }

    /**
     * Called (via IPC) by the renderer when a GATT connect actually succeeds — the
     * reliable "this MAC is a device we use" signal. This is deliberately separate
     * from connect(): that fires only on its 'approval' fallback source, which in a
     * normal session (device already found by the scan loop) is rarely reached.
     */
    reportConnectSucceeded(deviceId, deviceName) {
        this.connectTargetMacs.add(deviceId)
        this.deviceCache.markGood(deviceId, deviceName)
        if (deviceName) this.nameFailures.delete(deviceName)
        this.logger.logEvent({ message: 'connect succeeded', deviceId, deviceName })
    }

    _approve(device, callback) {
        this.discoveredDeviceIds.add(device.deviceId)
        if (device.deviceName) {
            const macs = this.deviceMacsByName.get(device.deviceName) ?? new Set()
            macs.add(device.deviceId)
            this.deviceMacsByName.set(device.deviceName, macs)
        }
        this.lastApproved = { deviceId: device.deviceId, deviceName: device.deviceName ?? null }
        this.pendingCallback = null
        this.logger.logEvent({ message: 'approving device', deviceId: device.deviceId, deviceName: device.deviceName })
        callback(device.deviceId)
    }

    /**
     * Chromium substitutes "Unknown or Unsupported Device (<MAC>)" for devices
     * that do not advertise a name. The text is localized (e.g. "Unbekanntes oder
     * nicht unterstütztes Gerät (<MAC>)"), but the "(<deviceId>)" suffix is not, so
     * that is what identifies the placeholder. Fitness devices always advertise a
     * name, so nameless devices are never approved.
     */
    _isUsableName(name, deviceId) {
        if (!name) return false
        if (name.startsWith('Unknown or Unsupported Device')) return false
        if (deviceId && name.endsWith(`(${deviceId})`)) return false
        return true
    }

    _onSelectBluetoothDevice(event, deviceList, callback) {
        event.preventDefault()
        this.lastDeviceList = deviceList

        // the chooser re-fires on every advertisement update — only log real changes
        const idsKey = deviceList.map(d => d.deviceId).sort().join('|')
        if (idsKey !== this._lastLoggedDeviceIds) {
            this._lastLoggedDeviceIds = idsKey
            this.logger.logEvent({
                message: 'select-bluetooth-device',
                scanning: this.scanning,
                connectTarget: this.connectTargetId,
                devices: deviceList.length,
                ids: deviceList.map(d => d.deviceId),
            })
        }

        // A pending connect request always takes priority — approve its target even
        // if it was already discovered during this scan.
        if (this._hasConnectTarget()) {
            const target = deviceList.find(d => d.deviceId === this.connectTargetId)
            if (target) {
                this.connectTargetId = null
                this._approve(target, callback)
                return
            }
        }

        if (this.scanning) {
            // Devices known to never work (persisted, repeated failures) are
            // excluded outright — not even as a last resort.
            this._logSkippedDevices(deviceList)
            const candidates = deviceList.filter(d => !this._skipReason(d))

            // tier 1: a device we already know we want (this session or a previous
            // one) always wins, regardless of chooser order or cooldown.
            let newDevice = candidates.find(d =>
                this.connectTargetMacs.has(d.deviceId) || this.deviceCache.isGood(d.deviceId))
            // tier 2: anything not currently cooled down from a recent probe failure.
            if (!newDevice) newDevice = candidates.find(d => !this._inCooldown(d.deviceId))
            // tier 3: nothing better available this round — try a parked/cooled-down
            // candidate anyway rather than leaving the chooser idle until it expires.
            if (!newDevice) newDevice = candidates[0]

            if (newDevice) {
                this._approve(newDevice, callback)
                return
            }
        }

        if (this._shouldLoop()) {
            // Nothing to approve right now — park the request. The event fires again
            // as soon as the device list changes.
            this.pendingCallback = callback
        } else {
            // idle: cancel the request so no chooser is left dangling
            callback('')
        }
    }

    /**
     * Why a device in the chooser list is not a candidate (undefined if it is one). Order matters: the first
     * matching reason is reported.
     */
    _skipReason(d) {
        if (this.discoveredDeviceIds.has(d.deviceId)) return 'already-approved'
        if (!this._isUsableName(d.deviceName, d.deviceId)) return 'no-name'
        if (this._isNameBlocked(d.deviceName, d.deviceId)) return 'name-blocked'
        if (this.deviceCache.isBad(d.deviceId)) return 'blacklisted'
        return undefined
    }

    // once per device and scan: the chooser re-fires constantly, and the reason is what is needed to understand
    // why a device that is in range never gets approved. Only the address is logged (as in select-bluetooth-device)
    _logSkippedDevices(deviceList) {
        for (const d of deviceList) {
            if (this.skipLoggedIds.has(d.deviceId)) continue
            const reason = this._skipReason(d)
            if (!reason || reason === 'already-approved') continue
            this.skipLoggedIds.add(d.deviceId)
            this.logger.logEvent({ message: 'skipping device', deviceId: d.deviceId, reason })
        }
    }

    startScan(serviceUUIDs, allowDuplicates) {
        this.logger.logEvent({ message: 'startScan', serviceUUIDs, allowDuplicates })
        this.scanning = true
        this.pendingCallback = null
        this.discoveredDeviceIds = new Set()
        this.skipLoggedIds = new Set()
        this._lastLoggedDeviceIds = null
        this._triggerScanIteration()
    }

    stopScan() {
        this.logger.logEvent({ message: 'stopScan', hadPendingCallback: !!this.pendingCallback })
        this.scanning = false

        // keep the loop alive while a connect request is still waiting for its device
        if (this._shouldLoop()) return

        if (this._scanLoopTimeout) {
            clearTimeout(this._scanLoopTimeout)
            this._scanLoopTimeout = null
        }
        if (this.pendingCallback) {
            const cb = this.pendingCallback
            this.pendingCallback = null
            cb('')
        }
    }

    connect(deviceId) {
        this.logger.logEvent({ message: 'connect', deviceId })
        this.connectTargetMacs.add(deviceId)
        this.deviceCache.markGood(deviceId)
        this.connectTargetId = deviceId
        this.connectTargetExpires = Date.now() + CONNECT_TARGET_TIMEOUT

        // A parked chooser only re-fires when its device list changes — if the target
        // is already in the last list, approve it right away.
        if (this.pendingCallback) {
            const target = this.lastDeviceList.find(d => d.deviceId === deviceId)
            if (target) {
                const cb = this.pendingCallback
                this.connectTargetId = null
                this._approve(target, cb)
                return
            }
        }

        // make sure the request loop is running (it may be idle when not scanning)
        if (!this._iterationInFlight && !this._scanLoopTimeout)
            this._triggerScanIteration()
    }

    disconnect(_deviceId) {
        // WebBluetooth GATT disconnect is handled in renderer directly
    }

    /**
     * Consume the approval that has not been picked up yet. Called (via sync IPC)
     * by the renderer right after requestDevice resolves. The device name must
     * match as a sanity check; the MAC is returned exactly once.
     */
    takeApproved(deviceName) {
        const approved = this.lastApproved
        if (!approved) return null
        if ((approved.deviceName ?? null) !== (deviceName ?? null)) return null
        this.lastApproved = null
        return approved.deviceId
    }

    /**
     * Best-effort name → MAC lookup. Names are not unique, so this only answers
     * when exactly one MAC is known for the name — otherwise null.
     */
    getMac(deviceName) {
        const macs = this.deviceMacsByName.get(deviceName)
        if (macs?.size === 1) return macs.values().next().value
        return null
    }

    _triggerScanIteration() {
        if (this._iterationInFlight) return
        if (!this._shouldLoop()) return
        const mainWindow = app.incyclistApp?.getMainWindow()
        const webContents = mainWindow?.win?.webContents
        if (!webContents || webContents.isDestroyed?.()) return

        const script = `(async function() {
            if (!window._webBleBinding) return
            try {
                const device = await navigator.bluetooth.requestDevice({
                    acceptAllDevices: true,
                    optionalServices: window._webBleBinding._optionalServices
                })
                if (device) await window._webBleBinding._processDiscoveredDevice(device, true)
            } catch(e) {}
        })()`

        this._iterationInFlight = true
        this._scanLoopTimeout = null
        webContents.executeJavaScript(script, true)
            .then(() => this._onIterationDone(500))
            .catch(() => this._onIterationDone(2000))
    }

    _onIterationDone(delay) {
        this._iterationInFlight = false
        if (this._shouldLoop())
            this._scanLoopTimeout = setTimeout(() => this._triggerScanIteration(), delay)
        else
            this._scanLoopTimeout = null
    }

    register(_props) {
        if (!SUPPORTED_PLATFORMS.has(process.platform)) {
            return;
        }
        this.logger.logEvent({ message: 'register' })


        app.on('web-contents-created', (_event, contents) => {
            contents.on('select-bluetooth-device', this._onSelectBluetoothDevice.bind(this))
        })

        ipcHandleNoResponse('webble-start-scan', this.startScan.bind(this), ipcMain)
        ipcHandleNoResponse('webble-stop-scan', this.stopScan.bind(this), ipcMain)
        ipcHandleNoResponse('webble-connect', this.connect.bind(this), ipcMain)
        ipcHandleNoResponse('webble-disconnect', this.disconnect.bind(this), ipcMain)
        ipcHandleSync('webble-get-mac', this.getMac.bind(this), ipcMain)
        ipcHandleSync('webble-take-approved', this.takeApproved.bind(this), ipcMain)
        ipcHandleNoResponse('webble-probe-failed', this.reportProbeFailed.bind(this), ipcMain)
        ipcHandleNoResponse('webble-connect-succeeded', this.reportConnectSucceeded.bind(this), ipcMain)
        ipcHandleNoResponse('webble-unsupported-device', this.reportUnsupportedDevice.bind(this), ipcMain)
        ipcHandleNoResponse('webble-log', this.log.bind(this), ipcMain)
    }

    registerRenderer(spec, ipcRenderer) {
        if (!SUPPORTED_PLATFORMS.has(process.platform)) {
            return;
        }

        spec.webble = {}

        WebBleIpcBinding.getInstance().setApi(spec.webble)

        spec.webble.getInstance = () => WebBleFeature.getInstance().getBinding()

        spec.webble.startScanning = (serviceUUIDs, allowDuplicates) => {
            ipcRenderer.send('webble-start-scan', serviceUUIDs, allowDuplicates)
        }

        spec.webble.stopScanning = () => {
            ipcRenderer.send('webble-stop-scan')
        }

        spec.webble.connect = (deviceId) => {
            ipcRenderer.send('webble-connect', deviceId)
        }

        spec.webble.disconnect = (deviceId) => {
            ipcRenderer.send('webble-disconnect', deviceId)
        }

        spec.webble.getMac = ipcCallSync('webble-get-mac', ipcRenderer)
        spec.webble.takeApproved = ipcCallSync('webble-take-approved', ipcRenderer)
        spec.webble.reportProbeFailed = ipcCallNoResponse('webble-probe-failed', ipcRenderer)
        spec.webble.reportConnectSucceeded = ipcCallNoResponse('webble-connect-succeeded', ipcRenderer)
        spec.webble.reportUnsupportedDevice = ipcCallNoResponse('webble-unsupported-device', ipcRenderer)
        spec.webble.log = ipcCallNoResponse('webble-log', ipcRenderer)

        // 'webble-services': binding supports setSupportedServices() (devices lib
        // announces its BLE service list — no desktop release needed for new services)
        spec.registerFeatures(['webble', 'webble-services'])
    }
}

module.exports = WebBleFeature
