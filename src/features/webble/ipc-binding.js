const EventEmitter = require('events')

// Default service list — only a FALLBACK for devices-lib versions that do not
// announce their supported services via setSupportedServices(). The authoritative
// list is pushed by the devices lib at scan start, so new BLE services do not
// require a desktop release.
const FITNESS_SERVICE_UUIDS = [
    '1826',                                    // FTMS
    '1818',                                    // Cycling Power (CSP)
    '1816',                                    // Cycling Speed & Cadence (CSC)
    '180d',                                    // Heart Rate
    'a026ee0b-0a7d-4ab3-97fa-f1500f9feb8b',   // Wahoo advanced FTMS
    '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e',   // Tacx FE-C BLE
    '00000001-19ca-4651-86e5-fa29dcdd09d1',    // Zwift Play
    '347b0001',                                // Elite trainer
]

// WebBluetooth only accepts dashed lowercase 128-bit UUIDs. Callers (the devices
// layer / Noble conventions) pass any of: 4- or 8-char short forms, 0x-prefixed,
// dashless 32-char, dashed 36-char — in any case.
function toFullUUID(uuid) {
    let u = uuid.toLowerCase()
    if (u.startsWith('0x')) u = u.slice(2)
    u = u.replace(/-/g, '')
    if (u.length === 4) return `0000${u}-0000-1000-8000-00805f9b34fb`
    if (u.length === 8) return `${u}-0000-1000-8000-00805f9b34fb`
    if (u.length === 32) return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`
    return u
}

const FITNESS_SERVICE_UUIDS_FULL = FITNESS_SERVICE_UUIDS.map(toFullUUID)

class WebBleIpcBinding extends EventEmitter {
    static _instance

    constructor() {
        super()
        this._state = 'unknown'
        this._bindings = this
        this.api = null
        this.stopRequested = false
        this._stateEmitted = false

        // Device identity:
        // - The MAC address (deviceId that main captures from select-bluetooth-device)
        //   is the ONLY stable, unique identifier — it survives restarts and is what
        //   gets persisted in settings.json.
        // - WebBLE opaque device.ids are session-local and can change between approvals.
        // - Device names are NOT unique (e.g. two "Zwift Click" controllers) and must
        //   never be used as a cache key or for device lookup.
        // Each physical device has ONE entry object, keyed in the map under both its
        // opaque id and (once known) its MAC.
        this._deviceCache = new Map()      // opaqueId | mac → { device, opaqueId, mac, name, serviceUuids, probed }
        this._pendingConnects = new Map()  // peripheral id → [{ resolve, timer }]

        // supported services: defaults, replaced/extended via setSupportedServices()
        this._knownServiceUUIDs = [...FITNESS_SERVICE_UUIDS]
        this._optionalServices = [...FITNESS_SERVICE_UUIDS_FULL]

        // timeouts / retries (instance fields so tests can shorten them)
        this._probeTimeoutMs = 10000
        this._gattConnectTimeoutMs = 10000
        this._gattConnectRetries = 3
        this._gattRetryDelayMs = 500
        this._connectWaitTimeoutMs = 30000
        this._gattReleaseGraceMs = 15000
    }

    static getInstance() {
        if (!WebBleIpcBinding._instance) {
            WebBleIpcBinding._instance = new WebBleIpcBinding()
            if (typeof window !== 'undefined')
                window._webBleBinding = WebBleIpcBinding._instance
        }
        return WebBleIpcBinding._instance
    }

    setApi(api) {
        this.api = api
    }

    getApi() {
        return this.api
    }

    get state() {
        return this._state
    }

    set state(s) {
        this._state = s
    }

    pauseLogging() {}
    resumeLogging() {}
    setServerDebug(_enabled) {}

    /**
     * Called by the devices lib (feature-detected, optional in its BleBinding
     * interface) with the full set of BLE service UUIDs it supports. These become
     * the optionalServices of every requestDevice call — WebBluetooth denies access
     * to any service not granted there — and the per-UUID probe fallback list.
     * Merged with the built-in defaults so an incomplete list can never remove
     * access; deduped on the full 128-bit form.
     */
    setSupportedServices(serviceUUIDs) {
        if (!Array.isArray(serviceUUIDs) || serviceUUIDs.length === 0) return

        const byFullUUID = new Map()
        for (const uuid of [...FITNESS_SERVICE_UUIDS, ...serviceUUIDs]) {
            if (typeof uuid === 'string' && uuid.length > 0)
                byFullUUID.set(toFullUUID(uuid), uuid)
        }
        this._knownServiceUUIDs = [...byFullUUID.values()]
        this._optionalServices = [...byFullUUID.keys()]
        console.log('[WebBLE] supported services set:', this._optionalServices.length)
    }

    on(event, callback) {
        super.on(event, callback)
        if (event === 'stateChange' && !this._stateEmitted) {
            this._stateEmitted = true
            setTimeout(() => {
                const available = typeof navigator !== 'undefined' && !!navigator.bluetooth
                const state = available ? 'poweredOn' : 'poweredOff'
                this._state = state
                this.emit('stateChange', state)
            }, 0)
        }
    }

    startScanning(serviceUUIDs, allowDuplicates, callback) {
        this.stopRequested = false
        this.getApi().startScanning(serviceUUIDs, allowDuplicates)

        // Fire callback first so the caller can register its 'discover' listener
        // (devices layer registers via ble.on('discover',...) inside the callback)
        if (callback) callback(null)

        // Re-emit devices already identified in this session. Only entries with a
        // known MAC are re-emitted — emitting an opaque id would poison the devices
        // layer's name-based dedupe and break address matching against settings.json.
        const seen = new Set()
        for (const entry of this._deviceCache.values()) {
            if (seen.has(entry)) continue
            seen.add(entry)
            if (!entry.probed || !entry.name || !entry.mac) continue
            console.log('[WebBLE] startScanning: re-emitting', entry.name, entry.serviceUuids)
            const peripheral = this._createPeripheral({ id: entry.mac, name: entry.name, serviceUuids: entry.serviceUuids })
            this.emit('discover', peripheral)
        }

        // Probe previously-approved devices (getDevices needs no user gesture).
        // Warms the device-object cache so a later scan-loop approval of the same
        // physical device can skip the GATT probe.
        this._discoverApprovedDevices()
    }

    async _discoverApprovedDevices() {
        try {
            const devices = await navigator.bluetooth.getDevices()
            console.log('[WebBLE] getDevices returned', devices.length, 'device(s)', devices.map(d => d.name))
            for (const device of devices) {
                if (this.stopRequested) break
                const entry = this._deviceCache.get(device.id)
                if (!entry?.probed) {
                    await this._processDiscoveredDevice(device, false)
                }
            }
        } catch (err) {
            console.log('[WebBLE] getDevices failed:', err?.message)
        }
    }

    stopScanning(callback) {
        this.stopRequested = true
        this.getApi().stopScanning()
        if (callback) callback()
    }

    /**
     * Merge a BluetoothDevice (and optionally its MAC) into the device cache.
     * The entry is keyed under both the opaque id and the MAC so lookups by either
     * identifier resolve to the same physical device.
     */
    _cacheDevice(device, mac) {
        let entry = (mac ? this._deviceCache.get(mac) : undefined) ?? this._deviceCache.get(device.id)
        if (!entry) {
            entry = { device, opaqueId: device.id, mac: null, name: device.name ?? null, serviceUuids: [], probed: false, inUse: false, releaseTimer: null }
        }
        entry.device = device
        entry.opaqueId = device.id
        if (device.name) entry.name = device.name
        if (mac) entry.mac = mac

        this._deviceCache.set(entry.opaqueId, entry)
        if (entry.mac) this._deviceCache.set(entry.mac, entry)
        return entry
    }

    /**
     * Hand the device object to any _connectPeripheral call waiting for it.
     * Returns true when at least one waiter was resolved.
     */
    _resolvePendingConnects(entry) {
        let resolved = false
        for (const key of [entry.mac, entry.opaqueId]) {
            if (!key) continue
            const waiters = this._pendingConnects.get(key)
            if (!waiters) continue
            this._pendingConnects.delete(key)
            for (const waiter of waiters) {
                clearTimeout(waiter.timer)
                waiter.resolve(entry.device)
                resolved = true
            }
        }
        return resolved
    }

    /**
     * Process a device handed over by the main-process request loop (approved=true)
     * or found via navigator.bluetooth.getDevices() (approved=false).
     *
     * Main approves exactly one device per requestDevice call, so an approved
     * device maps 1:1 to the approval main just recorded — takeApproved() returns
     * its MAC. This correlation stays correct even when several physical devices
     * share the same name.
     */
    async _processDiscoveredDevice(device, approved = false) {
        console.log('[WebBLE] _processDiscoveredDevice', device.name, 'approved:', approved)

        let mac = null
        if (approved) {
            mac = this.getApi().takeApproved?.(device.name ?? null) ?? null
        }

        const entry = this._cacheDevice(device, mac)
        const hadPendingConnect = this._resolvePendingConnects(entry)

        // Anonymous devices — fitness devices always have names and the adapter drops
        // nameless peripherals anyway. Skipping GATT here avoids wasting ~1s per device.
        if (!device.name) {
            console.log('[WebBLE] skipping anonymous device', device.id)
            entry.probed = true
            return
        }

        // Already probed this physical device (matched via MAC or session id) — the
        // opaque id may have changed, but the services are known: re-emit from cache.
        if (entry.probed) {
            const id = entry.mac ?? entry.opaqueId
            console.log('[WebBLE] re-emitting known device', entry.name, 'id:', id)
            const peripheral = this._createPeripheral({ id, name: entry.name, serviceUuids: entry.serviceUuids })
            this.emit('discover', peripheral)
            return
        }

        // A connect request was waiting for exactly this device — the device object
        // has been handed over; don't delay the connection with a GATT probe.
        if (hadPendingConnect) return

        const serviceUuids = await this._probeServices(device)
        if (serviceUuids === null) {
            // probe failed or timed out — leave probed=false so the next encounter retries
            return
        }
        entry.serviceUuids = serviceUuids
        entry.probed = true

        // Never emit an opaque id for a device found via getDevices(): the devices
        // layer dedupes announcements by name, so an opaque-id announcement would
        // block the later MAC announcement from the scan loop (breaking reconnect
        // by saved address). The scan loop will re-discover it with its MAC shortly.
        if (!entry.mac && !approved) {
            // Release the probe connection: a GATT-connected device stops advertising
            // and would never show up in the scan loop's chooser to get its MAC.
            try { device.gatt.disconnect() } catch {}
            console.log('[WebBLE] deferring emit for', device.name, '— MAC not known yet')
            return
        }

        // Keep the probe's GATT connection alive: pairing connects right after the
        // announcement, and a disconnect→connect cycle within a few seconds yields a
        // server whose link is already torn down (Chromium/BlueZ race — services and
        // characteristics then come back empty). Released after a grace period if no
        // connect request claims it.
        this._scheduleGattRelease(entry)

        const id = entry.mac ?? entry.opaqueId
        console.log('[WebBLE] emitting discover for', device.name, 'services:', serviceUuids, 'id:', id)
        const peripheral = this._createPeripheral({ id, name: device.name, serviceUuids })
        this.emit('discover', peripheral)
    }

    /**
     * Connect to the device's GATT server and read its primary services.
     * Returns the (possibly empty) list of service UUIDs, or null when the
     * probe failed or timed out.
     */
    async _probeServices(device) {
        console.log('[WebBLE] connecting to', device.name, 'for service discovery')
        try {
            const server = await this._withTimeout(device.gatt.connect(), this._probeTimeoutMs, 'GATT probe connect')
            console.log('[WebBLE] GATT connected to', device.name)

            const services = await this._withTimeout(this._getServerServices(server), this._probeTimeoutMs, 'service discovery')

            const serviceUuids = services.map(svc => {
                const shortUuid = this._knownServiceUUIDs.find(u => toFullUUID(u) === svc.uuid.toLowerCase())
                return shortUuid ?? svc.uuid
            })

            // deliberately NOT disconnecting here — the caller decides whether the
            // connection is kept for an imminent connect or released
            return serviceUuids
        } catch (err) {
            console.log('[WebBLE] GATT service discovery failed for', device.name, err?.message)
            try { device.gatt.disconnect() } catch {}
            return null
        }
    }

    /**
     * All primary services of a connected GATT server. Some devices (e.g. Wahoo
     * KICKR) don't support discover-all-primary-services — fall back to probing
     * each known fitness UUID in parallel.
     */
    async _getServerServices(server) {
        if (!server) return []

        let services = []
        try {
            services = await server.getPrimaryServices()
        } catch {}

        if (!services || services.length === 0) {
            const results = await Promise.allSettled(
                this._knownServiceUUIDs.map(async u => server.getPrimaryService(toFullUUID(u)))
            )
            services = results.filter(r => r.status === 'fulfilled').map(r => r.value)
        }
        return services
    }

    /**
     * Release the probe's GATT connection after a grace period unless a connect
     * request has claimed the device in the meantime.
     */
    _scheduleGattRelease(entry) {
        if (entry.releaseTimer) clearTimeout(entry.releaseTimer)
        const timer = setTimeout(() => {
            entry.releaseTimer = null
            if (entry.inUse) return
            try {
                if (entry.device?.gatt?.connected) {
                    console.log('[WebBLE] releasing unclaimed GATT connection for', entry.name)
                    entry.device.gatt.disconnect()
                }
            } catch {}
        }, this._gattReleaseGraceMs)
        timer.unref?.()
        entry.releaseTimer = timer
    }

    _claimGattConnection(entry) {
        if (!entry) return
        entry.inUse = true
        if (entry.releaseTimer) {
            clearTimeout(entry.releaseTimer)
            entry.releaseTimer = null
        }
    }

    _withTimeout(promise, ms, label) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
            promise.then(
                value => { clearTimeout(timer); resolve(value) },
                err => { clearTimeout(timer); reject(err) }
            )
        })
    }

    _createPeripheral(deviceInfo) {
        const binding = this
        const emitter = new EventEmitter()

        const peripheral = {
            id: deviceInfo.id,
            uuid: deviceInfo.id,
            address: deviceInfo.id,
            name: deviceInfo.name,
            advertisement: {
                localName: deviceInfo.name,
                serviceUuids: deviceInfo.serviceUuids || [],
            },
            state: 'disconnected',
            services: [],
            _device: null,
            _server: null,
            _characteristics: [],

            on:                 (ev, cb)    => emitter.on(ev, cb),
            off:                (ev, cb)    => emitter.off(ev, cb),
            once:               (ev, cb)    => emitter.once(ev, cb),
            removeAllListeners: (ev)        => emitter.removeAllListeners(ev),
            emit:               (ev, ...a)  => emitter.emit(ev, ...a),

            connectAsync:    () => binding._connectPeripheral(peripheral),
            disconnect:      (cb) => binding._disconnectPeripheral(peripheral, cb),
            disconnectAsync: () => new Promise(done => binding._disconnectPeripheral(peripheral, done)),

            discoverServicesAsync:                          (svcs)        => binding._discoverServices(peripheral, svcs),
            discoverSomeServicesAndCharacteristicsAsync:    (svcs, chars) => binding._discoverServicesAndCharacteristics(peripheral, svcs, chars),
        }

        return peripheral
    }

    async _connectPeripheral(peripheral) {
        // peripheral.id is the MAC whenever it was known at discovery time; the cache
        // is keyed under both the MAC and the opaque id, so either form resolves here.
        let device = this._deviceCache.get(peripheral.id)?.device
        let source = 'cache'

        if (!device) {
            // Previously granted device from the permission store. Only an exact id
            // match is trusted — device names are not unique, so matching by name
            // could connect to the wrong physical device.
            source = 'getDevices'
            try {
                const existingDevices = await navigator.bluetooth.getDevices()
                device = existingDevices.find(d => d.id === peripheral.id)
            } catch {}
        }

        if (!device) {
            // Ask main to approve this device (by MAC) inside its request loop.
            // requestDevice must not be called from here: it would race the scan
            // loop's chooser and needs a user gesture — both reject immediately.
            // The approved device arrives via _processDiscoveredDevice.
            source = 'approval'
            this.getApi().connect(peripheral.id)
            device = await this._waitForDevice(peripheral.id)
        }

        console.log('[WebBLE] connectPeripheral', peripheral.name, 'via', source)

        // claim the device: a probe connection kept alive for this device is reused,
        // and the grace-period release must not tear down an in-use connection
        const entry = this._cacheDevice(device, peripheral.id !== device.id ? peripheral.id : null)
        this._claimGattConnection(entry)

        peripheral._device = device
        device.addEventListener('gattserverdisconnected', () => {
            peripheral.state = 'disconnected'
            peripheral.emit('disconnect')
        }, { once: true })

        peripheral._server = await this._gattConnect(device)
        peripheral.state = 'connected'
        console.log('[WebBLE] connectPeripheral done', peripheral.name)
    }

    _waitForDevice(id) {
        const cached = this._deviceCache.get(id)
        if (cached?.device) return Promise.resolve(cached.device)

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingConnects.delete(id)
                reject(new Error(`device not found: ${id}`))
            }, this._connectWaitTimeoutMs)

            const waiters = this._pendingConnects.get(id) ?? []
            waiters.push({ resolve, timer })
            this._pendingConnects.set(id, waiters)
        })
    }

    async _gattConnect(device) {
        if (device.gatt.connected) return device.gatt

        let lastErr
        for (let attempt = 1; attempt <= this._gattConnectRetries; attempt++) {
            try {
                return await this._withTimeout(device.gatt.connect(), this._gattConnectTimeoutMs, 'GATT connect')
            } catch (err) {
                lastErr = err
                console.log('[WebBLE] GATT connect attempt', attempt, 'failed for', device.name, err?.message)
                if (attempt < this._gattConnectRetries)
                    await new Promise(res => setTimeout(res, this._gattRetryDelayMs))
            }
        }
        throw lastErr
    }

    async _disconnectPeripheral(peripheral, callback) {
        try {
            if (peripheral._device?.gatt?.connected) {
                peripheral._device.gatt.disconnect()
            }
        } catch {}
        const entry = this._deviceCache.get(peripheral.id)
            ?? (peripheral._device ? this._deviceCache.get(peripheral._device.id) : undefined)
        if (entry) entry.inUse = false
        peripheral.state = 'disconnected'
        if (callback) callback(null)
    }

    /**
     * A GATT server can report success on connect() while the underlying link is
     * already torn down (Chromium/BlueZ disconnect→connect race) — every
     * getPrimaryService then rejects immediately. When discovery comes back empty
     * and the server admits it is disconnected, reconnect once and retry.
     */
    async _reviveDeadServer(peripheral) {
        if (!peripheral._device || peripheral._server?.connected) return false
        console.log('[WebBLE] GATT server dead for', peripheral.name, '— reconnecting')
        try {
            peripheral._server = await this._gattConnect(peripheral._device)
            peripheral.state = 'connected'
            return true
        } catch (err) {
            console.log('[WebBLE] GATT reconnect failed for', peripheral.name, err?.message)
            return false
        }
    }

    /**
     * Make sure the peripheral has a usable GATT server before discovery. The
     * devices layer tracks connection state itself and may call discovery without
     * ever having called connectAsync on THIS peripheral object (its state can be
     * carried over from an earlier pairing round) — connect on demand using the
     * device object from the discovery cache.
     */
    async _ensureServer(peripheral) {
        if (peripheral._server && peripheral._server.connected !== false) return true

        if (!peripheral._device) {
            const entry = this._deviceCache.get(peripheral.id)
            if (entry?.device) {
                peripheral._device = entry.device
                this._claimGattConnection(entry)
            }
        }
        if (!peripheral._device) return false

        try {
            peripheral._server = await this._gattConnect(peripheral._device)
            peripheral.state = 'connected'
            return true
        } catch (err) {
            console.log('[WebBLE] on-demand GATT connect failed for', peripheral.name, err?.message)
            return false
        }
    }

    async _discoverServices(peripheral, serviceUUIDs) {
        if (!await this._ensureServer(peripheral)) return []

        let services = await this._collectServices(peripheral, serviceUUIDs)
        if (services.length === 0 && await this._reviveDeadServer(peripheral))
            services = await this._collectServices(peripheral, serviceUUIDs)
        return services
    }

    // Noble semantics: an empty uuid list means "discover ALL primary services"
    async _collectServices(peripheral, serviceUUIDs) {
        const found = await this._resolveServices(peripheral, serviceUUIDs)
        return found.map(f => ({ uuid: f.uuid }))
    }

    /**
     * Resolve the requested services to live service objects. Empty/absent list →
     * all primary services. For explicit requests the caller's uuid string is
     * preserved in the result so the devices layer gets back its own format.
     */
    async _resolveServices(peripheral, serviceUUIDs) {
        const found = []
        if (!serviceUUIDs || serviceUUIDs.length === 0) {
            const services = await this._getServerServices(peripheral._server)
            for (const svc of services) found.push({ uuid: svc.uuid, service: svc })
        } else {
            for (const uuid of serviceUUIDs) {
                try {
                    const service = await peripheral._server.getPrimaryService(toFullUUID(uuid))
                    found.push({ uuid, service })
                } catch {}
            }
        }
        return found
    }

    async _discoverServicesAndCharacteristics(peripheral, serviceUUIDs, characteristicUUIDs) {
        if (!await this._ensureServer(peripheral)) return { services: [], characteristics: [] }

        let result = await this._collectServicesAndCharacteristics(peripheral, serviceUUIDs, characteristicUUIDs)
        if (result.services.length === 0 && await this._reviveDeadServer(peripheral))
            result = await this._collectServicesAndCharacteristics(peripheral, serviceUUIDs, characteristicUUIDs)

        peripheral._characteristics = result.characteristics
        return result
    }

    // Noble semantics: empty serviceUUIDs → all services; empty characteristicUUIDs
    // → all characteristics of each service
    async _collectServicesAndCharacteristics(peripheral, serviceUUIDs, characteristicUUIDs) {
        const found = await this._resolveServices(peripheral, serviceUUIDs)
        const services = found.map(f => ({ uuid: f.uuid }))
        const characteristics = []

        const wantAll = !characteristicUUIDs || characteristicUUIDs.length === 0
        for (const { service } of found) {
            if (wantAll) {
                try {
                    const chars = await service.getCharacteristics()
                    for (const char of chars) {
                        characteristics.push(this._createCharacteristic(char, peripheral))
                    }
                } catch {}
            } else {
                for (const charUUID of characteristicUUIDs) {
                    try {
                        const char = await service.getCharacteristic(toFullUUID(charUUID))
                        characteristics.push(this._createCharacteristic(char, peripheral))
                    } catch {}
                }
            }
        }

        return { services, characteristics }
    }

    _createCharacteristic(bleChar, peripheral) {
        const binding = this
        const emitter = new EventEmitter()

        const char = {
            uuid:           bleChar.uuid,
            _serviceUuid:   bleChar.service?.uuid,
            _peripheralId:  peripheral.id,
            properties:     this._extractProperties(bleChar.properties),
            _bleChar:       bleChar,

            emit:               (ev, ...a)  => emitter.emit(ev, ...a),
            on:                 (ev, cb)    => emitter.on(ev, cb),
            off:                (ev, cb)    => emitter.off(ev, cb),
            once:               (ev, cb)    => emitter.once(ev, cb),
            removeAllListeners: (ev)        => emitter.removeAllListeners(ev),

            subscribe:   (cb)                      => binding._subscribeCharacteristic(char, cb),
            unsubscribe: (cb)                      => binding._unsubscribeCharacteristic(char, cb),
            read:        (cb)                      => binding._readCharacteristic(char, cb),
            write:       (data, noResp, cb)        => binding._writeCharacteristic(char, data, noResp, cb),
        }

        return char
    }

    _extractProperties(bleProps) {
        if (!bleProps) return []
        const props = []
        if (bleProps.broadcast)             props.push('broadcast')
        if (bleProps.read)                  props.push('read')
        if (bleProps.writeWithoutResponse)  props.push('writeWithoutResponse')
        if (bleProps.write)                 props.push('write')
        if (bleProps.notify)                props.push('notify')
        if (bleProps.indicate)              props.push('indicate')
        return props
    }

    async _subscribeCharacteristic(char, callback) {
        try {
            await char._bleChar.startNotifications()
            char._bleChar.addEventListener('characteristicvaluechanged', (event) => {
                const value = event.target.value
                const data = Buffer.from(value.buffer)
                char.emit('data', data, true)
            })
            if (callback) callback(null)
        } catch (err) {
            if (callback) callback(err)
        }
    }

    async _unsubscribeCharacteristic(char, callback) {
        try {
            await char._bleChar.stopNotifications()
            if (callback) callback(null)
        } catch (err) {
            if (callback) callback(err)
        }
    }

    async _readCharacteristic(char, callback) {
        try {
            const value = await char._bleChar.readValue()
            const data = Buffer.from(value.buffer)
            if (callback) callback(null, data)
        } catch (err) {
            if (callback) callback(err, null)
        }
    }

    async _writeCharacteristic(char, data, withoutResponse, callback) {
        try {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
            if (withoutResponse) {
                await char._bleChar.writeValueWithoutResponse(buf)
            } else {
                await char._bleChar.writeValueWithResponse(buf)
            }
            if (!withoutResponse && callback) callback(null)
        } catch (err) {
            if (!withoutResponse && callback) callback(err)
        }
    }
}

module.exports = WebBleIpcBinding
