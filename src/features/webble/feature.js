const { app, ipcMain } = require('electron')
const { ipcHandleNoResponse, ipcHandleSync, ipcCallSync } = require('../utils')
const Feature = require('../base')
const WebBleIpcBinding = require('./ipc-binding')
const { EventLogger } = require('gd-eventlog')

const CONNECT_TARGET_TIMEOUT = 30 * 1000

class WebBleFeature extends Feature {
    static _instance

    constructor() {
        super()
        this.logger = new EventLogger('WebBLE')

        // Scanning and connecting are independent: a connect request must never
        // stop the request loop, otherwise no further devices get discovered.
        this.scanning = false
        this.connectTargetId = null          // MAC of the device a connect is waiting for
        this.connectTargetExpires = 0

        this.pendingCallback = null          // parked select-bluetooth-device callback
        this.lastDeviceList = []             // device list of the most recent event
        this.discoveredDeviceIds = new Set() // MACs approved in the current scan

        // deviceName → Set<MAC>. Device names are NOT unique (e.g. two "Zwift Click"
        // controllers), so a name can map to several MACs.
        this.deviceMacsByName = new Map()

        // The approval the renderer has not consumed yet. Exactly one device is
        // approved per requestDevice call, so this maps 1:1 to the device object
        // that requestDevice resolves with — consumed via takeApproved().
        this.lastApproved = null             // { deviceId, deviceName }

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
     * that do not advertise a name. Fitness devices always advertise a name, so
     * nameless devices are never approved.
     */
    _isUsableName(name) {
        return !!name && !name.startsWith('Unknown or Unsupported Device')
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
            // Only named devices get approved. When nothing usable is new, the
            // callback is parked below — the event re-fires on device list changes.
            const newDevice = deviceList.find(d =>
                !this.discoveredDeviceIds.has(d.deviceId) && this._isUsableName(d.deviceName))
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

    startScan(serviceUUIDs, allowDuplicates) {
        this.logger.logEvent({ message: 'startScan', serviceUUIDs, allowDuplicates })
        this.scanning = true
        this.pendingCallback = null
        this.discoveredDeviceIds = new Set()
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
        if (process.platform !== 'linux') {
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
    }

    registerRenderer(spec, ipcRenderer) {
        if (process.platform !== 'linux') {
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

        // 'webble-services': binding supports setSupportedServices() (devices lib
        // announces its BLE service list — no desktop release needed for new services)
        spec.registerFeatures(['webble', 'webble-services'])
    }
}

module.exports = WebBleFeature
