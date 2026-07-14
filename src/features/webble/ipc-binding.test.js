/**
 * Tests for WebBleIpcBinding (renderer-side Noble-compatible binding).
 *
 * navigator.bluetooth is mocked at the global level.
 * requestDevice scanning is driven by feature.js (main process) via
 * executeJavaScript — ipc-binding never calls requestDevice itself.
 *
 * Identity model under test:
 * - MAC address (from select-bluetooth-device, via takeApproved) is the primary id
 * - WebBLE opaque device.ids are session-local aliases
 * - device names are NOT unique and are never used for lookup
 */

let WebBleIpcBinding

// requestDevice that never settles — the binding must never call it
const neverSettle = jest.fn(() => new Promise(() => {}))

const makeBluetooth = (overrides = {}) => ({
    requestDevice: neverSettle,
    getDevices: jest.fn().mockResolvedValue([]),
    getAvailability: jest.fn().mockResolvedValue(true),
    ...overrides,
})

const expandUUID = uuid => {
    if (uuid.length === 4) return `0000${uuid}-0000-1000-8000-00805f9b34fb`
    if (uuid.length === 8) return `${uuid}-0000-1000-8000-00805f9b34fb`
    return uuid.toLowerCase()
}

const makeGattServer = (availableUuids = []) => {
    const fullUuids = availableUuids.map(expandUUID)
    return {
        getPrimaryService: jest.fn().mockImplementation(uuid =>
            fullUuids.includes(expandUUID(uuid))
                ? Promise.resolve({ uuid: expandUUID(uuid) })
                : Promise.reject(new Error('not found'))
        ),
        getPrimaryServices: jest.fn().mockResolvedValue(
            fullUuids.map(uuid => ({ uuid }))
        ),
    }
}

const makeBleDevice = (id = 'dev-1', name = 'Test Device', gattServer = null) => ({
    id,
    name,
    gatt: {
        connected: false,
        connect: jest.fn().mockResolvedValue(gattServer ?? makeGattServer()),
        disconnect: jest.fn(),
    },
    addEventListener: jest.fn(),
})

const makeApi = (overrides = {}) => ({
    startScanning: jest.fn(),
    stopScanning: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    getMac: jest.fn().mockReturnValue(null),
    takeApproved: jest.fn().mockReturnValue(null),
    ...overrides,
})

const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
    jest.resetModules()
    global.navigator = { bluetooth: makeBluetooth() }
    WebBleIpcBinding = require('./ipc-binding')
    WebBleIpcBinding._instance = undefined
})

afterEach(() => {
    delete global.navigator
})

// ── state ────────────────────────────────────────────────────────────────────

describe('WebBleIpcBinding — state', () => {

    test('initial state is unknown', () => {
        const binding = new WebBleIpcBinding()
        expect(binding.state).toBe('unknown')
    })

    test('on stateChange emits poweredOn when navigator.bluetooth available', done => {
        const binding = new WebBleIpcBinding()
        binding.on('stateChange', state => {
            expect(state).toBe('poweredOn')
            expect(binding.state).toBe('poweredOn')
            done()
        })
    })

    test('on stateChange emits poweredOff when navigator.bluetooth absent', done => {
        global.navigator = {}
        const binding = new WebBleIpcBinding()
        binding.on('stateChange', state => {
            expect(state).toBe('poweredOff')
            done()
        })
    })

    test('stateChange is emitted exactly once even with multiple on() calls', done => {
        const binding = new WebBleIpcBinding()
        const calls = []
        binding.on('stateChange', s => calls.push(s))
        binding.on('stateChange', s => calls.push(s))

        setTimeout(() => {
            // One emission, two listeners → two calls total
            expect(calls).toHaveLength(2)
            done()
        }, 50)
    })

    test('_bindings points to self', () => {
        const binding = new WebBleIpcBinding()
        expect(binding._bindings).toBe(binding)
    })

    test('_optionalServices contains full 128-bit UUIDs for fitness services', () => {
        const binding = new WebBleIpcBinding()
        expect(binding._optionalServices).toEqual(
            expect.arrayContaining(['00001826-0000-1000-8000-00805f9b34fb'])
        )
        expect(binding._optionalServices.every(u => u.includes('-'))).toBe(true)
    })

    test('getInstance sets window._webBleBinding to the singleton', () => {
        global.window = {}
        const binding = WebBleIpcBinding.getInstance()
        expect(global.window._webBleBinding).toBe(binding)
        delete global.window
    })

})

// ── setSupportedServices ──────────────────────────────────────────────────────

describe('WebBleIpcBinding — setSupportedServices', () => {

    let binding

    beforeEach(() => {
        binding = new WebBleIpcBinding()
        binding.setApi(makeApi())
    })

    test('adds new services (any format) to optionalServices as full lowercase uuids', () => {
        binding.setSupportedServices(['FD69', '0000000119ca465186e5fa29dcdd09d1'])

        expect(binding._optionalServices).toContain('0000fd69-0000-1000-8000-00805f9b34fb')
        expect(binding._optionalServices).toContain('00000001-19ca-4651-86e5-fa29dcdd09d1')
    })

    test('merges with built-in defaults — defaults are never lost', () => {
        binding.setSupportedServices(['fd69'])

        expect(binding._optionalServices).toContain(expandUUID('1826'))   // FTMS default
        expect(binding._optionalServices).toContain(expandUUID('180d'))   // HR default
        expect(binding._optionalServices).toContain(expandUUID('fd69'))
    })

    test('dedupes services that appear in defaults and announcement (different formats)', () => {
        const before = binding._optionalServices.length
        binding.setSupportedServices(['1826', '0000182600001000800000805F9B34FB'])

        expect(binding._optionalServices.length).toBe(before)   // both map to existing FTMS
    })

    test('ignores empty or invalid input', () => {
        const services = [...binding._optionalServices]
        binding.setSupportedServices([])
        binding.setSupportedServices(null)
        binding.setSupportedServices('1826')
        expect(binding._optionalServices).toEqual(services)
    })

    test('announced services are used for the per-UUID probe fallback', async () => {
        binding.setSupportedServices(['fd69'])
        const fullFd69 = expandUUID('fd69')
        const server = {
            getPrimaryServices: jest.fn().mockRejectedValue(new Error('not supported')),
            getPrimaryService: jest.fn().mockImplementation(uuid =>
                uuid === fullFd69 ? Promise.resolve({ uuid: fullFd69 }) : Promise.reject(new Error('not found'))
            ),
        }
        const device = makeBleDevice('dev-1', 'New Trainer', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        // announced with the uuid in the form the devices lib registered it
        expect(discovered).toHaveLength(1)
        expect(discovered[0].advertisement.serviceUuids).toEqual(['fd69'])
    })

})

// ── no-op methods ─────────────────────────────────────────────────────────────

describe('WebBleIpcBinding — no-op methods', () => {

    test('pauseLogging does not throw', () => {
        expect(() => new WebBleIpcBinding().pauseLogging()).not.toThrow()
    })

    test('resumeLogging does not throw', () => {
        expect(() => new WebBleIpcBinding().resumeLogging()).not.toThrow()
    })

    test('setServerDebug does not throw', () => {
        expect(() => new WebBleIpcBinding().setServerDebug(true)).not.toThrow()
    })

})

// ── startScanning ────────────────────────────────────────────────────────────

describe('WebBleIpcBinding — startScanning', () => {

    let binding, api

    beforeEach(() => {
        api = makeApi()
        binding = new WebBleIpcBinding()
        binding.setApi(api)
    })

    test('sends webble-start-scan to main via api.startScanning', () => {
        binding.startScanning(['1234'], true, jest.fn())
        expect(api.startScanning).toHaveBeenCalledWith(['1234'], true)
    })

    test('invokes callback immediately with null', () => {
        const callback = jest.fn()
        binding.startScanning([], false, callback)
        expect(callback).toHaveBeenCalledWith(null)
    })

    test('resets stopRequested on each scan start', () => {
        binding.stopRequested = true
        binding.startScanning([], false, jest.fn())
        expect(binding.stopRequested).toBe(false)
    })

    test('does not call requestDevice directly (scanning is driven by main process)', () => {
        binding.startScanning([], false, jest.fn())
        expect(global.navigator.bluetooth.requestDevice).not.toHaveBeenCalled()
    })

    test('re-emits discover with the MAC for known devices on subsequent startScanning', () => {
        const entry = binding._cacheDevice(makeBleDevice('opaque-1', 'KICKR CORE'), 'F8:E1:A4:32:9C:09')
        entry.probed = true
        entry.serviceUuids = ['1826', '1818']

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        binding.startScanning([], true, jest.fn())

        // entry is keyed under both opaque id and MAC — must be emitted only once
        expect(discovered).toHaveLength(1)
        expect(discovered[0].id).toBe('F8:E1:A4:32:9C:09')
        expect(discovered[0].address).toBe('F8:E1:A4:32:9C:09')
        expect(discovered[0].advertisement.serviceUuids).toEqual(['1826', '1818'])
    })

    test('does not re-emit devices without a known MAC (opaque id would poison address matching)', () => {
        const entry = binding._cacheDevice(makeBleDevice('opaque-1', 'KICKR CORE'), null)
        entry.probed = true
        entry.serviceUuids = ['1826']

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        binding.startScanning([], true, jest.fn())

        expect(discovered).toHaveLength(0)
    })

    test('does not re-emit devices that have not been probed yet', () => {
        binding._cacheDevice(makeBleDevice('opaque-1', 'KICKR CORE'), 'F8:E1:A4:32:9C:09')

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        binding.startScanning([], true, jest.fn())

        expect(discovered).toHaveLength(0)
    })

    test('emits no discover from cache when cache is empty', () => {
        const discovered = []
        binding.on('discover', p => discovered.push(p))

        binding.startScanning([], true, jest.fn())

        expect(discovered).toHaveLength(0)
    })

    test('calls _discoverApprovedDevices', () => {
        jest.spyOn(binding, '_discoverApprovedDevices').mockResolvedValue()
        binding.startScanning([], true, jest.fn())
        expect(binding._discoverApprovedDevices).toHaveBeenCalled()
    })

})

// ── _discoverApprovedDevices ──────────────────────────────────────────────────

describe('WebBleIpcBinding — _discoverApprovedDevices', () => {

    let binding

    beforeEach(() => {
        binding = new WebBleIpcBinding()
        binding.setApi(makeApi())
        jest.spyOn(binding, '_processDiscoveredDevice').mockResolvedValue()
    })

    test('calls _processDiscoveredDevice with approved=false for each unknown device', async () => {
        const dev1 = makeBleDevice('dev-1', 'KICKR')
        const dev2 = makeBleDevice('dev-2', 'Volt')
        global.navigator.bluetooth.getDevices.mockResolvedValue([dev1, dev2])

        await binding._discoverApprovedDevices()

        expect(binding._processDiscoveredDevice).toHaveBeenCalledWith(dev1, false)
        expect(binding._processDiscoveredDevice).toHaveBeenCalledWith(dev2, false)
    })

    test('skips devices whose cache entry has already been probed', async () => {
        const dev1 = makeBleDevice('dev-1', 'KICKR')
        const dev2 = makeBleDevice('dev-2', 'Volt')
        global.navigator.bluetooth.getDevices.mockResolvedValue([dev1, dev2])
        const entry = binding._cacheDevice(dev1, null)
        entry.probed = true

        await binding._discoverApprovedDevices()

        expect(binding._processDiscoveredDevice).not.toHaveBeenCalledWith(dev1, false)
        expect(binding._processDiscoveredDevice).toHaveBeenCalledWith(dev2, false)
    })

    test('re-processes devices that are cached but not yet probed (failed probe retry)', async () => {
        const dev1 = makeBleDevice('dev-1', 'KICKR')
        global.navigator.bluetooth.getDevices.mockResolvedValue([dev1])
        binding._cacheDevice(dev1, null)   // cached, probed stays false

        await binding._discoverApprovedDevices()

        expect(binding._processDiscoveredDevice).toHaveBeenCalledWith(dev1, false)
    })

    test('stops processing when stopRequested is set', async () => {
        const dev1 = makeBleDevice('dev-1', 'KICKR')
        const dev2 = makeBleDevice('dev-2', 'Volt')
        global.navigator.bluetooth.getDevices.mockResolvedValue([dev1, dev2])

        binding._processDiscoveredDevice.mockImplementation(async () => {
            binding.stopRequested = true
        })

        await binding._discoverApprovedDevices()

        expect(binding._processDiscoveredDevice).toHaveBeenCalledTimes(1)
    })

    test('does not throw when getDevices is unavailable', async () => {
        global.navigator.bluetooth.getDevices.mockRejectedValue(new Error('not supported'))
        await expect(binding._discoverApprovedDevices()).resolves.not.toThrow()
    })

})

// ── stopScanning ──────────────────────────────────────────────────────────────

describe('WebBleIpcBinding — stopScanning', () => {

    test('sets stopRequested to true', () => {
        const binding = new WebBleIpcBinding()
        binding.setApi(makeApi())

        binding.stopScanning()

        expect(binding.stopRequested).toBe(true)
    })

    test('calls api.stopScanning', () => {
        const api = makeApi()
        const binding = new WebBleIpcBinding()
        binding.setApi(api)

        binding.stopScanning()

        expect(api.stopScanning).toHaveBeenCalled()
    })

    test('invokes callback when provided', () => {
        const binding = new WebBleIpcBinding()
        binding.setApi(makeApi())
        const callback = jest.fn()

        binding.stopScanning(callback)

        expect(callback).toHaveBeenCalled()
    })

})

// ── _processDiscoveredDevice ──────────────────────────────────────────────────

describe('WebBleIpcBinding — _processDiscoveredDevice', () => {

    let binding, api

    beforeEach(() => {
        api = makeApi()
        binding = new WebBleIpcBinding()
        binding.setApi(api)
    })

    test('skips anonymous devices without GATT or emit and marks them probed', async () => {
        const device = makeBleDevice('anon-1', null)
        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(device.gatt.connect).not.toHaveBeenCalled()
        expect(discovered).toHaveLength(0)
        expect(binding._deviceCache.get('anon-1')).toBeDefined()
        expect(binding._deviceCache.get('anon-1').probed).toBe(true)
    })

    test('approved device: consumes takeApproved and emits with the MAC as id/uuid/address', async () => {
        api.takeApproved.mockReturnValue('F8:E1:A4:32:9C:09')
        const server = makeGattServer(['1826'])
        const device = makeBleDevice('opaque-id-1', 'KICKR CORE C378', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(api.takeApproved).toHaveBeenCalledWith('KICKR CORE C378')
        expect(discovered).toHaveLength(1)
        expect(discovered[0].id).toBe('F8:E1:A4:32:9C:09')
        expect(discovered[0].uuid).toBe('F8:E1:A4:32:9C:09')
        expect(discovered[0].address).toBe('F8:E1:A4:32:9C:09')
        expect(discovered[0].name).toBe('KICKR CORE C378')
    })

    test('approved device: entry is reachable under both the MAC and the opaque id', async () => {
        api.takeApproved.mockReturnValue('F8:E1:A4:32:9C:09')
        const device = makeBleDevice('opaque-id-1', 'KICKR', makeGattServer(['1826']))

        await binding._processDiscoveredDevice(device, true)

        const byMac = binding._deviceCache.get('F8:E1:A4:32:9C:09')
        const byOpaque = binding._deviceCache.get('opaque-id-1')
        expect(byMac).toBeDefined()
        expect(byMac).toBe(byOpaque)
        expect(byMac.device).toBe(device)
    })

    test('approved device: falls back to the opaque id when takeApproved returns null', async () => {
        api.takeApproved.mockReturnValue(null)
        const server = makeGattServer(['180d'])
        const device = makeBleDevice('opaque-id-1', 'HRM Pro', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(1)
        expect(discovered[0].id).toBe('opaque-id-1')
        expect(discovered[0].address).toBe('opaque-id-1')
    })

    test('approved device: does not throw when api.takeApproved is not available (older shell)', async () => {
        delete api.takeApproved
        const server = makeGattServer(['180d'])
        const device = makeBleDevice('opaque-id-1', 'HRM Pro', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(1)
        expect(discovered[0].id).toBe('opaque-id-1')
    })

    test('getDevices path (approved=false): probes and caches but does NOT emit without a MAC', async () => {
        const server = makeGattServer(['1826'])
        const device = makeBleDevice('opaque-id-1', 'Volt', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, false)

        expect(device.gatt.connect).toHaveBeenCalled()
        expect(discovered).toHaveLength(0)
        const entry = binding._deviceCache.get('opaque-id-1')
        expect(entry.probed).toBe(true)
        expect(entry.serviceUuids).toContain('1826')
        // deferred device must resume advertising so the scan loop can approve it
        expect(device.gatt.disconnect).toHaveBeenCalled()
    })

    test('getDevices path then scan approval: same opaque id is merged, MAC emitted without re-probe', async () => {
        // second launch: getDevices() finds Volt before the scan loop has approved it
        const server = makeGattServer(['1826'])
        const device = makeBleDevice('opaque-id-1', 'Volt', server)
        await binding._processDiscoveredDevice(device, false)
        expect(device.gatt.connect).toHaveBeenCalledTimes(1)

        // scan loop approves the same granted device → same session opaque id + MAC
        api.takeApproved.mockReturnValue('D4:C9:BB:7D:CB:AF')
        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(device.gatt.connect).toHaveBeenCalledTimes(1)   // no second probe
        expect(discovered).toHaveLength(1)
        expect(discovered[0].id).toBe('D4:C9:BB:7D:CB:AF')
        expect(discovered[0].advertisement.serviceUuids).toEqual(['1826'])
        expect(binding._deviceCache.get('D4:C9:BB:7D:CB:AF').device).toBe(device)
    })

    test('re-approval with same MAC but new opaque id: re-emits from cache and updates the device object', async () => {
        api.takeApproved.mockReturnValue('F8:E1:A4:32:9C:09')
        const device1 = makeBleDevice('opaque-id-1', 'KICKR CORE C378', makeGattServer(['1826']))
        await binding._processDiscoveredDevice(device1, true)

        // next scan: WebBLE handed out a new opaque id for the same physical device
        api.takeApproved.mockReturnValue('F8:E1:A4:32:9C:09')
        const device2 = makeBleDevice('opaque-id-2', 'KICKR CORE C378')
        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device2, true)

        expect(device2.gatt.connect).not.toHaveBeenCalled()   // no re-probe
        expect(discovered).toHaveLength(1)
        expect(discovered[0].id).toBe('F8:E1:A4:32:9C:09')
        expect(discovered[0].advertisement.serviceUuids).toEqual(['1826'])
        // device object refreshed so connects use the live grant
        expect(binding._deviceCache.get('F8:E1:A4:32:9C:09').device).toBe(device2)
    })

    test('two devices sharing the same name get separate entries keyed by their MACs', async () => {
        api.takeApproved.mockReturnValueOnce('AA:BB:CC:DD:EE:01')
        const click1 = makeBleDevice('opaque-1', 'Zwift Click', makeGattServer(['00000001-19ca-4651-86e5-fa29dcdd09d1']))
        await binding._processDiscoveredDevice(click1, true)

        api.takeApproved.mockReturnValueOnce('AA:BB:CC:DD:EE:02')
        const click2 = makeBleDevice('opaque-2', 'Zwift Click', makeGattServer(['00000001-19ca-4651-86e5-fa29dcdd09d1']))
        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(click2, true)

        // second Click was probed and emitted with its own MAC
        expect(click2.gatt.connect).toHaveBeenCalled()
        expect(discovered).toHaveLength(1)
        expect(discovered[0].id).toBe('AA:BB:CC:DD:EE:02')

        // each MAC resolves to its own physical device
        expect(binding._deviceCache.get('AA:BB:CC:DD:EE:01').device).toBe(click1)
        expect(binding._deviceCache.get('AA:BB:CC:DD:EE:02').device).toBe(click2)
    })

    test('emits discover with service UUIDs found on the device', async () => {
        const server = makeGattServer(['1826', '1818'])
        const device = makeBleDevice('dev-1', 'KICKR CORE', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(1)
        expect(discovered[0].advertisement.serviceUuids).toContain('1826')
        expect(discovered[0].advertisement.serviceUuids).toContain('1818')
        expect(discovered[0].advertisement.serviceUuids).not.toContain('180d')
    })

    test('probe failure: emits nothing and stays retryable — succeeds on next encounter', async () => {
        const device = makeBleDevice('dev-1', 'KICKR CORE')
        device.gatt.connect.mockRejectedValueOnce(new Error('connection failed'))

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(0)
        expect(binding._deviceCache.get('dev-1').probed).toBe(false)

        // next encounter retries the probe and emits
        device.gatt.connect.mockResolvedValue(makeGattServer(['1826']))
        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(1)
        expect(discovered[0].advertisement.serviceUuids).toEqual(['1826'])
    })

    test('probe timeout: a hanging GATT connect does not block processing forever', async () => {
        binding._probeTimeoutMs = 50
        const device = makeBleDevice('dev-1', 'Stuck Device')
        device.gatt.connect.mockReturnValue(new Promise(() => {}))   // never settles

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(0)
        expect(binding._deviceCache.get('dev-1').probed).toBe(false)
    })

    test('keeps the GATT connection open after a successful probe (announced device)', async () => {
        const server = makeGattServer(['1826'])
        const device = makeBleDevice('dev-1', 'Trainer', server)

        await binding._processDiscoveredDevice(device, true)

        // an immediate disconnect→connect cycle yields a dead server (Chromium/BlueZ
        // race) — the connection is kept for the connect that follows the announcement
        expect(device.gatt.disconnect).not.toHaveBeenCalled()
    })

    test('releases the probe connection after the grace period when no connect claims it', async () => {
        binding._gattReleaseGraceMs = 20
        const server = makeGattServer(['1826'])
        const device = makeBleDevice('dev-1', 'Trainer', server)
        device.gatt.connect.mockImplementation(async () => { device.gatt.connected = true; return server })

        await binding._processDiscoveredDevice(device, true)
        expect(device.gatt.disconnect).not.toHaveBeenCalled()

        await new Promise(r => setTimeout(r, 60))
        expect(device.gatt.disconnect).toHaveBeenCalled()
    })

    test('a connect within the grace period claims the connection — never released', async () => {
        binding._gattReleaseGraceMs = 20
        api.takeApproved.mockReturnValue('D4:C9:BB:7D:CB:AF')
        const server = makeGattServer(['1826'])
        const device = makeBleDevice('opaque-1', 'Volt', server)
        device.gatt.connect.mockImplementation(async () => { device.gatt.connected = true; return server })

        await binding._processDiscoveredDevice(device, true)

        const peripheral = binding._createPeripheral({ id: 'D4:C9:BB:7D:CB:AF', name: 'Volt', serviceUuids: ['1826'] })
        await peripheral.connectAsync()
        expect(peripheral.state).toBe('connected')

        await new Promise(r => setTimeout(r, 60))
        expect(device.gatt.disconnect).not.toHaveBeenCalled()
    })

    test('attempts GATT disconnect when the probe fails', async () => {
        const device = makeBleDevice('dev-1', 'Trainer')
        device.gatt.connect.mockRejectedValue(new Error('boom'))

        await binding._processDiscoveredDevice(device, true)

        expect(device.gatt.disconnect).toHaveBeenCalled()
    })

    test('stores device and serviceUuids in cache after discovery', async () => {
        const server = makeGattServer(['1826', '1818'])
        const device = makeBleDevice('dev-1', 'KICKR', server)

        await binding._processDiscoveredDevice(device, true)

        const cached = binding._deviceCache.get('dev-1')
        expect(cached).toBeDefined()
        expect(cached.device).toBe(device)
        expect(cached.serviceUuids).toContain('1826')
        expect(cached.serviceUuids).toContain('1818')
    })

    test('emits discover even when no fitness services are found', async () => {
        const server = makeGattServer([])
        const device = makeBleDevice('dev-1', 'Unknown BLE', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(1)
        expect(discovered[0].advertisement.serviceUuids).toEqual([])
    })

    test('falls back to per-UUID probing when getPrimaryServices throws (e.g. Wahoo KICKR)', async () => {
        const fullUuids1826 = expandUUID('1826')
        const server = {
            getPrimaryServices: jest.fn().mockRejectedValue(new Error('Not supported')),
            getPrimaryService: jest.fn().mockImplementation(uuid =>
                uuid === fullUuids1826
                    ? Promise.resolve({ uuid: fullUuids1826 })
                    : Promise.reject(new Error('not found'))
            ),
        }
        const device = makeBleDevice('dev-1', 'KICKR CORE', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(1)
        expect(discovered[0].advertisement.serviceUuids).toContain('1826')
    })

    test('falls back to per-UUID probing when getPrimaryServices returns empty', async () => {
        const fullUuids1818 = expandUUID('1818')
        const server = {
            getPrimaryServices: jest.fn().mockResolvedValue([]),
            getPrimaryService: jest.fn().mockImplementation(uuid =>
                uuid === fullUuids1818
                    ? Promise.resolve({ uuid: fullUuids1818 })
                    : Promise.reject(new Error('not found'))
            ),
        }
        const device = makeBleDevice('dev-1', 'KICKR CORE', server)

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        expect(discovered).toHaveLength(1)
        expect(discovered[0].advertisement.serviceUuids).toContain('1818')
    })

    test('hands the device to a waiting connect request instead of probing', async () => {
        api.takeApproved.mockReturnValue('D4:C9:BB:7D:CB:AF')
        const device = makeBleDevice('opaque-id-1', 'Volt')

        const waiter = binding._waitForDevice('D4:C9:BB:7D:CB:AF')

        const discovered = []
        binding.on('discover', p => discovered.push(p))

        await binding._processDiscoveredDevice(device, true)

        await expect(waiter).resolves.toBe(device)
        expect(device.gatt.connect).not.toHaveBeenCalled()   // no probe while connect is waiting
        expect(discovered).toHaveLength(0)
    })

    test('discovered peripheral has Noble-compatible shape', async () => {
        const server = makeGattServer(['180d'])
        const device = makeBleDevice('dev-1', 'HRM Pro', server)

        let peripheral
        binding.on('discover', p => { peripheral = p })

        await binding._processDiscoveredDevice(device, true)

        expect(peripheral.id).toBe('dev-1')
        expect(peripheral.uuid).toBe('dev-1')
        expect(peripheral.address).toBe('dev-1')
        expect(peripheral.advertisement.localName).toBe('HRM Pro')
        expect(peripheral.advertisement.serviceUuids).toContain('180d')
        expect(peripheral.state).toBe('disconnected')
        expect(typeof peripheral.connectAsync).toBe('function')
        expect(typeof peripheral.disconnect).toBe('function')
        expect(typeof peripheral.disconnectAsync).toBe('function')
        expect(typeof peripheral.discoverSomeServicesAndCharacteristicsAsync).toBe('function')
        expect(typeof peripheral.discoverServicesAsync).toBe('function')
        expect(typeof peripheral.on).toBe('function')
        expect(typeof peripheral.emit).toBe('function')
        expect(typeof peripheral.once).toBe('function')
        expect(typeof peripheral.removeAllListeners).toBe('function')
    })

})

// ── _connectPeripheral ────────────────────────────────────────────────────────

describe('WebBleIpcBinding — _connectPeripheral', () => {

    let binding, api

    beforeEach(() => {
        api = makeApi()
        binding = new WebBleIpcBinding()
        binding.setApi(api)
        binding._gattRetryDelayMs = 1
        binding._connectWaitTimeoutMs = 200
    })

    const getPeripheral = (id = 'dev-1', name = 'Trainer') =>
        binding._createPeripheral({ id, name, serviceUuids: [] })

    test('uses cached BluetoothDevice — no getDevices or requestDevice call', async () => {
        const cachedDevice = makeBleDevice('dev-1')
        binding._cacheDevice(cachedDevice, null)
        global.navigator.bluetooth.requestDevice = jest.fn().mockRejectedValue(new Error('should not call'))

        const peripheral = getPeripheral()
        await peripheral.connectAsync()

        expect(global.navigator.bluetooth.getDevices).not.toHaveBeenCalled()
        expect(global.navigator.bluetooth.requestDevice).not.toHaveBeenCalled()
        expect(cachedDevice.gatt.connect).toHaveBeenCalled()
        expect(peripheral.state).toBe('connected')
        expect(peripheral._server).toBeDefined()
    })

    test('resolves the cache by MAC when the device was approved with one (bug 1 regression)', async () => {
        // scan loop discovered Volt: opaque id + MAC recorded via takeApproved
        api.takeApproved.mockReturnValue('D4:C9:BB:7D:CB:AF')
        const device = makeBleDevice('opaque-id-1', 'Volt', makeGattServer(['1826']))
        await binding._processDiscoveredDevice(device, true)
        global.navigator.bluetooth.requestDevice = jest.fn().mockRejectedValue(new Error('should not call'))
        global.navigator.bluetooth.getDevices.mockClear()

        // settings.json address is the MAC — the peripheral connects by MAC
        const peripheral = getPeripheral('D4:C9:BB:7D:CB:AF', 'Volt')
        await peripheral.connectAsync()

        expect(global.navigator.bluetooth.getDevices).not.toHaveBeenCalled()
        expect(global.navigator.bluetooth.requestDevice).not.toHaveBeenCalled()
        expect(peripheral.state).toBe('connected')
        expect(peripheral._server).toBeDefined()
    })

    test('falls back to getDevices exact-id match when device not in cache', async () => {
        const existingDevice = makeBleDevice('dev-1')
        global.navigator.bluetooth.getDevices.mockResolvedValue([existingDevice])
        global.navigator.bluetooth.requestDevice = jest.fn().mockRejectedValue(new Error('should not call'))

        const peripheral = getPeripheral()
        await peripheral.connectAsync()

        expect(global.navigator.bluetooth.getDevices).toHaveBeenCalled()
        expect(global.navigator.bluetooth.requestDevice).not.toHaveBeenCalled()
        expect(existingDevice.gatt.connect).toHaveBeenCalled()
        expect(peripheral.state).toBe('connected')
    })

    test('never matches getDevices by name — names are not unique', async () => {
        // a granted device shares the target name but is a DIFFERENT physical device
        const wrongDevice = makeBleDevice('other-opaque-id', 'Zwift Click')
        global.navigator.bluetooth.getDevices.mockResolvedValue([wrongDevice])

        const peripheral = getPeripheral('AA:BB:CC:DD:EE:02', 'Zwift Click')
        const connecting = peripheral.connectAsync()
        await flush()

        // binding asked main to approve the target instead of trusting the name match
        expect(api.connect).toHaveBeenCalledWith('AA:BB:CC:DD:EE:02')

        // main approves the right device; scan pipeline hands it over
        api.takeApproved.mockReturnValue('AA:BB:CC:DD:EE:02')
        const rightDevice = makeBleDevice('opaque-2', 'Zwift Click')
        await binding._processDiscoveredDevice(rightDevice, true)

        await connecting

        expect(wrongDevice.gatt.connect).not.toHaveBeenCalled()
        expect(rightDevice.gatt.connect).toHaveBeenCalled()
        expect(peripheral.state).toBe('connected')
    })

    test('unknown device: asks main via api.connect and waits for the scan pipeline hand-over', async () => {
        global.navigator.bluetooth.getDevices.mockResolvedValue([])

        const peripheral = getPeripheral('D4:C9:BB:7D:CB:AF', 'Volt')
        const connecting = peripheral.connectAsync()
        await flush()

        expect(api.connect).toHaveBeenCalledWith('D4:C9:BB:7D:CB:AF')
        expect(global.navigator.bluetooth.requestDevice).not.toHaveBeenCalled()

        api.takeApproved.mockReturnValue('D4:C9:BB:7D:CB:AF')
        const device = makeBleDevice('opaque-1', 'Volt')
        await binding._processDiscoveredDevice(device, true)

        await connecting

        expect(device.gatt.connect).toHaveBeenCalled()
        expect(peripheral.state).toBe('connected')
    })

    test('rejects when the device never shows up within the wait timeout', async () => {
        binding._connectWaitTimeoutMs = 50
        global.navigator.bluetooth.getDevices.mockResolvedValue([])

        const peripheral = getPeripheral('D4:C9:BB:7D:CB:AF', 'Volt')

        await expect(peripheral.connectAsync()).rejects.toThrow('device not found')
        expect(peripheral.state).toBe('disconnected')
    })

    test('retries GATT connect when the first attempt fails', async () => {
        const device = makeBleDevice('dev-1')
        device.gatt.connect
            .mockRejectedValueOnce(new Error('flaky'))
            .mockResolvedValueOnce(makeGattServer())
        binding._cacheDevice(device, null)

        const peripheral = getPeripheral()
        await peripheral.connectAsync()

        expect(device.gatt.connect).toHaveBeenCalledTimes(2)
        expect(peripheral.state).toBe('connected')
    })

    test('rejects when all GATT connect attempts fail', async () => {
        binding._gattConnectRetries = 2
        const device = makeBleDevice('dev-1')
        device.gatt.connect.mockRejectedValue(new Error('unreachable'))
        binding._cacheDevice(device, null)

        const peripheral = getPeripheral()

        await expect(peripheral.connectAsync()).rejects.toThrow('unreachable')
        expect(device.gatt.connect).toHaveBeenCalledTimes(2)
        expect(peripheral.state).toBe('disconnected')
    })

    test('applies a timeout to hanging GATT connects', async () => {
        binding._gattConnectTimeoutMs = 30
        binding._gattConnectRetries = 1
        const device = makeBleDevice('dev-1')
        device.gatt.connect.mockReturnValue(new Promise(() => {}))   // never settles
        binding._cacheDevice(device, null)

        const peripheral = getPeripheral()

        await expect(peripheral.connectAsync()).rejects.toThrow('timeout')
    })

    test('sets up gattserverdisconnected listener and emits disconnect event', async () => {
        const device = makeBleDevice('dev-1')
        let disconnectListener
        device.addEventListener.mockImplementation((ev, fn) => {
            if (ev === 'gattserverdisconnected') disconnectListener = fn
        })
        binding._cacheDevice(device, null)

        const peripheral = getPeripheral()
        await peripheral.connectAsync()

        const events = []
        peripheral.on('disconnect', () => events.push(true))

        disconnectListener()

        expect(peripheral.state).toBe('disconnected')
        expect(events).toHaveLength(1)
    })

})

// ── _disconnectPeripheral ─────────────────────────────────────────────────────

describe('WebBleIpcBinding — _disconnectPeripheral', () => {

    let binding

    beforeEach(() => {
        binding = new WebBleIpcBinding()
        binding.setApi(makeApi())
    })

    const getPeripheral = () =>
        binding._createPeripheral({ id: 'dev-1', name: 'Trainer', serviceUuids: [] })

    test('calls gatt.disconnect when connected and sets state to disconnected', async () => {
        const gattDisconnect = jest.fn()
        const peripheral = getPeripheral()
        peripheral._device = { gatt: { connected: true, disconnect: gattDisconnect } }
        peripheral.state = 'connected'

        await peripheral.disconnectAsync()

        expect(gattDisconnect).toHaveBeenCalled()
        expect(peripheral.state).toBe('disconnected')
    })

    test('does not throw when _device is not set', async () => {
        const peripheral = getPeripheral()
        await expect(peripheral.disconnectAsync()).resolves.not.toThrow()
        expect(peripheral.state).toBe('disconnected')
    })

    test('callback form (disconnect) invokes callback with null', done => {
        const peripheral = getPeripheral()
        peripheral.disconnect(err => {
            expect(err).toBeNull()
            done()
        })
    })

    test('clears the inUse claim so the release logic can act on later probes', async () => {
        const device = makeBleDevice('dev-1', 'Trainer')
        const entry = binding._cacheDevice(device, null)
        entry.inUse = true

        const peripheral = getPeripheral()
        peripheral._device = device

        await peripheral.disconnectAsync()

        expect(entry.inUse).toBe(false)
    })

})

// ── discovery: noble semantics (empty list = all) and uuid formats ────────────

describe('WebBleIpcBinding — discovery noble semantics', () => {

    let binding

    beforeEach(() => {
        binding = new WebBleIpcBinding()
        binding.setApi(makeApi())
    })

    const getPeripheral = () =>
        binding._createPeripheral({ id: 'dev-1', name: 'Volt', serviceUuids: [] })

    test('discoverServicesAsync([]) returns ALL primary services', async () => {
        const server = makeGattServer(['1826', '180d'])
        server.connected = true
        const peripheral = getPeripheral()
        peripheral._server = server

        const services = await peripheral.discoverServicesAsync([])

        expect(services.map(s => s.uuid)).toEqual([expandUUID('1826'), expandUUID('180d')])
    })

    test('discoverServicesAsync([]) falls back to per-UUID probing when discover-all fails (Wahoo)', async () => {
        const full1826 = expandUUID('1826')
        const server = {
            connected: true,
            getPrimaryServices: jest.fn().mockRejectedValue(new Error('not supported')),
            getPrimaryService: jest.fn().mockImplementation(uuid =>
                uuid === full1826 ? Promise.resolve({ uuid: full1826 }) : Promise.reject(new Error('not found'))
            ),
        }
        const peripheral = getPeripheral()
        peripheral._server = server

        const services = await peripheral.discoverServicesAsync([])

        expect(services).toEqual([{ uuid: full1826 }])
    })

    test('discoverSomeServicesAndCharacteristicsAsync([],[]) returns all services and all characteristics', async () => {
        const bleChar = {
            uuid: expandUUID('2ad2'),
            properties: { notify: true },
            service: { uuid: expandUUID('1826') },
        }
        const service = { uuid: expandUUID('1826'), getCharacteristics: jest.fn().mockResolvedValue([bleChar]) }
        const server = { connected: true, getPrimaryServices: jest.fn().mockResolvedValue([service]) }
        const peripheral = getPeripheral()
        peripheral._server = server

        const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync([], [])

        expect(result.services).toEqual([{ uuid: expandUUID('1826') }])
        expect(result.characteristics).toHaveLength(1)
        expect(result.characteristics[0].uuid).toBe(expandUUID('2ad2'))
        expect(result.characteristics[0].properties).toEqual(['notify'])
    })

    test('discoverSomeServicesAndCharacteristicsAsync([], target) accepts devices-layer uuid formats', async () => {
        const bleChar = { uuid: expandUUID('2ad2'), properties: { notify: true }, service: { uuid: expandUUID('1826') } }
        const service = {
            uuid: expandUUID('1826'),
            getCharacteristic: jest.fn().mockImplementation(uuid =>
                uuid === expandUUID('2ad2') ? Promise.resolve(bleChar) : Promise.reject(new Error('not found'))
            ),
        }
        const server = { connected: true, getPrimaryServices: jest.fn().mockResolvedValue([service]) }
        const peripheral = getPeripheral()
        peripheral._server = server

        // devices layer fullUUID() produces dashed UPPERCASE
        const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
            [], ['00002AD2-0000-1000-8000-00805F9B34FB'])

        expect(service.getCharacteristic).toHaveBeenCalledWith(expandUUID('2ad2'))
        expect(result.characteristics).toHaveLength(1)
    })

    test('discovery on a never-connected peripheral connects on demand via the device cache (KICKR regression)', async () => {
        const bleChar = { uuid: expandUUID('2ad2'), properties: { notify: true }, service: { uuid: expandUUID('1826') } }
        const service = { uuid: expandUUID('1826'), getCharacteristics: jest.fn().mockResolvedValue([bleChar]) }
        const server = { connected: true, getPrimaryServices: jest.fn().mockResolvedValue([service]) }
        const device = makeBleDevice('opaque-1', 'KICKR CORE C378', server)
        binding._cacheDevice(device, 'F8:E1:A4:32:9C:09')

        // devices layer thinks it is connected and skips connectAsync — _server is null
        const peripheral = binding._createPeripheral({ id: 'F8:E1:A4:32:9C:09', name: 'KICKR CORE C378', serviceUuids: [] })

        const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync([], [])

        expect(device.gatt.connect).toHaveBeenCalled()
        expect(result.services).toEqual([{ uuid: expandUUID('1826') }])
        expect(result.characteristics).toHaveLength(1)
        expect(peripheral.state).toBe('connected')
    })

    test('discovery without server or cached device returns empty instead of throwing', async () => {
        const peripheral = getPeripheral()   // no _server, no _device, nothing cached

        const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync([], [])
        const services = await peripheral.discoverServicesAsync([])

        expect(result).toEqual({ services: [], characteristics: [] })
        expect(services).toEqual([])
    })

    test('explicit service uuids: noble short/dashless/uppercase forms resolve and are echoed back', async () => {
        const server = makeGattServer(['180d'])
        server.connected = true
        const peripheral = getPeripheral()
        peripheral._server = server

        const services = await peripheral.discoverServicesAsync(
            ['180D', '0000180D00001000800000805F9B34FB'])

        // caller's own uuid format is preserved in the result
        expect(services).toEqual([
            { uuid: '180D' },
            { uuid: '0000180D00001000800000805F9B34FB' },
        ])
    })

})

// ── dead-server recovery (service discovery after Chromium/BlueZ race) ────────

describe('WebBleIpcBinding — dead-server recovery', () => {

    let binding

    beforeEach(() => {
        binding = new WebBleIpcBinding()
        binding.setApi(makeApi())
        binding._gattRetryDelayMs = 1
    })

    const getPeripheral = (name = 'Volt') =>
        binding._createPeripheral({ id: 'dev-1', name, serviceUuids: [] })

    const makeDeadServer = () => ({
        connected: false,
        getPrimaryService: jest.fn().mockRejectedValue(new Error('GATT Server is disconnected')),
    })

    test('discoverServicesAsync reconnects and retries when the server is dead', async () => {
        const liveServer = makeGattServer(['1826'])
        liveServer.connected = true
        const device = makeBleDevice('dev-1', 'Volt', liveServer)

        const peripheral = getPeripheral()
        peripheral._device = device
        peripheral._server = makeDeadServer()

        const services = await peripheral.discoverServicesAsync(['1826'])

        expect(device.gatt.connect).toHaveBeenCalled()
        expect(services).toEqual([{ uuid: '1826' }])
        expect(peripheral._server).toBe(liveServer)
        expect(peripheral.state).toBe('connected')
    })

    test('discoverSomeServicesAndCharacteristicsAsync recovers on a dead server', async () => {
        const bleChar = {
            uuid: expandUUID('2ad2'),
            properties: { notify: true },
            service: { uuid: expandUUID('1826') },
        }
        const service = { uuid: expandUUID('1826'), getCharacteristic: jest.fn().mockResolvedValue(bleChar) }
        const liveServer = { connected: true, getPrimaryService: jest.fn().mockResolvedValue(service) }
        const device = makeBleDevice('dev-1', 'Volt', liveServer)

        const peripheral = getPeripheral()
        peripheral._device = device
        peripheral._server = makeDeadServer()

        const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync(['1826'], ['2ad2'])

        expect(device.gatt.connect).toHaveBeenCalled()
        expect(result.services).toEqual([{ uuid: '1826' }])
        expect(result.characteristics).toHaveLength(1)
        expect(result.characteristics[0].uuid).toBe(expandUUID('2ad2'))
    })

    test('does not reconnect when the server is connected and services are simply absent', async () => {
        const server = makeGattServer([])
        server.connected = true
        const device = makeBleDevice('dev-1', 'Volt', server)

        const peripheral = getPeripheral()
        peripheral._device = device
        peripheral._server = server

        const services = await peripheral.discoverServicesAsync(['1826'])

        expect(device.gatt.connect).not.toHaveBeenCalled()
        expect(services).toEqual([])
    })

    test('returns the empty result when the reconnect itself fails', async () => {
        binding._gattConnectRetries = 1
        const device = makeBleDevice('dev-1', 'Volt')
        device.gatt.connect.mockRejectedValue(new Error('unreachable'))

        const peripheral = getPeripheral()
        peripheral._device = device
        peripheral._server = makeDeadServer()

        const services = await peripheral.discoverServicesAsync(['1826'])

        expect(services).toEqual([])
    })

})
