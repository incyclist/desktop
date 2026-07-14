jest.mock('electron', () => ({
    app: {
        on: jest.fn(),
        incyclistApp: { getMainWindow: () => ({ win: { webContents: { send: jest.fn() } } }) },
    },
    ipcMain: { on: jest.fn() },
}))

jest.mock('../utils', () => ({
    ipcHandleNoResponse: jest.fn(),
    ipcHandleSync: jest.fn(),
    ipcCallSync: jest.fn(() => jest.fn()),
    ipcSendEvent: jest.fn(),
}))

jest.mock('./ipc-binding', () => {
    const setApi = jest.fn()
    return { getInstance: jest.fn(() => ({ setApi })) }
})

const { app } = require('electron')
const { ipcHandleNoResponse, ipcHandleSync, ipcCallSync, ipcSendEvent } = require('../utils')
const WebBleFeature = require('./feature')

beforeEach(() => {
    jest.clearAllMocks()
    WebBleFeature._instance = undefined
})

// ── initial state ─────────────────────────────────────────────────────────────

describe('WebBleFeature — initial state', () => {

    test('scanning starts false', () => {
        expect(new WebBleFeature().scanning).toBe(false)
    })

    test('connectTargetId starts null', () => {
        expect(new WebBleFeature().connectTargetId).toBeNull()
    })

    test('pendingCallback starts null', () => {
        expect(new WebBleFeature().pendingCallback).toBeNull()
    })

    test('lastApproved starts null', () => {
        expect(new WebBleFeature().lastApproved).toBeNull()
    })

})

// ── startScan / stopScan ─────────────────────────────────────────────────────

describe('WebBleFeature — startScan / stopScan', () => {

    let feature

    beforeEach(() => {
        feature = new WebBleFeature()
        jest.spyOn(feature, '_triggerScanIteration').mockImplementation(() => {})
    })

    test('startScan sets scanning to true and resets accumulated state', () => {
        feature.scanning = false
        feature.pendingCallback = jest.fn()
        feature.discoveredDeviceIds = new Set(['old-id'])

        feature.startScan()

        expect(feature.scanning).toBe(true)
        expect(feature.pendingCallback).toBeNull()
        expect(feature.discoveredDeviceIds.size).toBe(0)
    })

    test('startScan calls _triggerScanIteration', () => {
        feature.startScan()
        expect(feature._triggerScanIteration).toHaveBeenCalled()
    })

    test('stopScan sets scanning to false', () => {
        feature.scanning = true
        feature.stopScan()
        expect(feature.scanning).toBe(false)
    })

    test('stopScan calls pendingCallback with empty string when no connect target', () => {
        const cb = jest.fn()
        feature.scanning = true
        feature.pendingCallback = cb

        feature.stopScan()

        expect(cb).toHaveBeenCalledWith('')
        expect(feature.pendingCallback).toBeNull()
    })

    test('stopScan is safe when pendingCallback is null', () => {
        feature.scanning = true
        feature.pendingCallback = null
        expect(() => feature.stopScan()).not.toThrow()
    })

    test('stopScan clears pending scan loop timeout when no connect target', () => {
        feature.scanning = true
        feature._scanLoopTimeout = setTimeout(() => {}, 60000)
        feature.stopScan()
        expect(feature._scanLoopTimeout).toBeNull()
    })

    test('stopScan keeps loop alive when a connect target is still pending', () => {
        feature.scanning = true
        feature.connectTargetId = 'D4:C9:BB:7D:CB:AF'
        feature.connectTargetExpires = Date.now() + 30000
        feature._scanLoopTimeout = null

        feature.stopScan()

        // scanning is false but connectTarget is active → _shouldLoop() is still true
        expect(feature.scanning).toBe(false)
        // pendingCallback should NOT be called (loop still needs it)
        const cb = jest.fn()
        feature.pendingCallback = cb
        feature.stopScan()
        // still has a connect target, so callback is not flushed
        expect(cb).not.toHaveBeenCalled()
    })

})

// ── connect ───────────────────────────────────────────────────────────────────

describe('WebBleFeature — connect', () => {

    let feature

    beforeEach(() => {
        feature = new WebBleFeature()
        jest.spyOn(feature, '_triggerScanIteration').mockImplementation(() => {})
        jest.spyOn(feature, '_approve').mockImplementation((device, cb) => cb(device.deviceId))
    })

    test('sets connectTargetId', () => {
        feature.connect('D4:C9:BB:7D:CB:AF')
        expect(feature.connectTargetId).toBe('D4:C9:BB:7D:CB:AF')
    })

    test('sets connectTargetExpires in the future', () => {
        const before = Date.now()
        feature.connect('D4:C9:BB:7D:CB:AF')
        expect(feature.connectTargetExpires).toBeGreaterThan(before)
    })

    test('immediately approves from parked callback when target is already in lastDeviceList', () => {
        const cb = jest.fn()
        feature.pendingCallback = cb
        feature.lastDeviceList = [{ deviceId: 'D4:C9:BB:7D:CB:AF', deviceName: 'Volt' }]

        feature.connect('D4:C9:BB:7D:CB:AF')

        expect(feature._approve).toHaveBeenCalledWith(
            { deviceId: 'D4:C9:BB:7D:CB:AF', deviceName: 'Volt' },
            cb
        )
    })

    test('starts scan loop when idle and not already running', () => {
        feature._iterationInFlight = false
        feature._scanLoopTimeout = null

        feature.connect('D4:C9:BB:7D:CB:AF')

        expect(feature._triggerScanIteration).toHaveBeenCalled()
    })

})

// ── _triggerScanIteration ─────────────────────────────────────────────────────

describe('WebBleFeature — _triggerScanIteration', () => {

    let feature, webContents

    beforeEach(() => {
        feature = new WebBleFeature()
        feature.scanning = true
        webContents = {
            executeJavaScript: jest.fn(() => Promise.resolve()),
        }
        app.incyclistApp = { getMainWindow: () => ({ win: { webContents } }) }
    })

    afterEach(async () => {
        // stop the self-rescheduling loop: _onIterationDone may still be pending
        // as a microtask and would otherwise re-arm the timer forever
        feature.scanning = false
        feature.connectTargetId = null
        await new Promise(r => setImmediate(r))
        if (feature._scanLoopTimeout) clearTimeout(feature._scanLoopTimeout)
    })

    test('calls executeJavaScript with userGesture=true when scanning', () => {
        feature._triggerScanIteration()
        expect(webContents.executeJavaScript).toHaveBeenCalledWith(
            expect.stringContaining('requestDevice'),
            true
        )
    })

    test('skips executeJavaScript when not scanning and no connect target', () => {
        feature.scanning = false
        feature._triggerScanIteration()
        expect(webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    test('skips executeJavaScript when no main window available', () => {
        app.incyclistApp = null
        feature._triggerScanIteration()
        expect(webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    test('skips when _iterationInFlight is already true', () => {
        feature._iterationInFlight = true
        feature._triggerScanIteration()
        expect(webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    test('sets _scanLoopTimeout after scan completes while still scanning', async () => {
        feature._triggerScanIteration()
        await new Promise(r => setImmediate(r))
        expect(feature._scanLoopTimeout).not.toBeNull()
        clearTimeout(feature._scanLoopTimeout)
    })

    test('does not set _scanLoopTimeout when scanning stops and no connect target', async () => {
        let resolveJs
        webContents.executeJavaScript.mockReturnValue(new Promise(r => { resolveJs = r }))
        feature._triggerScanIteration()
        feature.scanning = false
        resolveJs()
        await new Promise(r => setImmediate(r))
        expect(feature._scanLoopTimeout).toBeNull()
    })

    test('script references window._webBleBinding and _processDiscoveredDevice', () => {
        feature._triggerScanIteration()
        const [script] = webContents.executeJavaScript.mock.calls[0]
        expect(script).toContain('window._webBleBinding')
        expect(script).toContain('_processDiscoveredDevice')
    })

    test('script passes approved=true to _processDiscoveredDevice', () => {
        feature._triggerScanIteration()
        const [script] = webContents.executeJavaScript.mock.calls[0]
        expect(script).toContain('_processDiscoveredDevice(device, true)')
    })

})

// ── _onSelectBluetoothDevice ──────────────────────────────────────────────────

describe('WebBleFeature — _onSelectBluetoothDevice', () => {

    let feature

    beforeEach(() => {
        feature = new WebBleFeature()
    })

    const makeEvent = () => ({ preventDefault: jest.fn() })
    const makeDeviceList = (...ids) =>
        ids.map(id => ({ deviceId: id, deviceName: `Device ${id}` }))

    test('scanning: calls preventDefault', () => {
        feature.scanning = true
        const event = makeEvent()
        feature._onSelectBluetoothDevice(event, makeDeviceList('aa'), jest.fn())
        expect(event.preventDefault).toHaveBeenCalled()
    })

    test('scanning: approves first new named device', () => {
        feature.scanning = true
        const cb = jest.fn()
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa', 'bb'), cb)
        expect(cb).toHaveBeenCalledWith('aa')
    })

    test('scanning: prefers named device over anonymous', () => {
        feature.scanning = true
        const cb = jest.fn()
        const deviceList = [
            { deviceId: 'anon-1', deviceName: null },
            { deviceId: 'kickr-1', deviceName: 'KICKR CORE' },
        ]
        feature._onSelectBluetoothDevice(makeEvent(), deviceList, cb)
        expect(cb).toHaveBeenCalledWith('kickr-1')
    })

    test('scanning: parks callback when only anonymous devices remain', () => {
        feature.scanning = true
        const cb = jest.fn()
        const deviceList = [
            { deviceId: 'anon-1', deviceName: null },
            { deviceId: 'anon-2', deviceName: null },
        ]
        feature._onSelectBluetoothDevice(makeEvent(), deviceList, cb)
        expect(cb).not.toHaveBeenCalled()
        expect(feature.pendingCallback).toBe(cb)
    })

    test('scanning: never approves Chromium "Unknown or Unsupported Device" placeholders', () => {
        feature.scanning = true
        const cb = jest.fn()
        const deviceList = [
            { deviceId: '52:7F:3B:3C:DE:AB', deviceName: 'Unknown or Unsupported Device (52:7F:3B:3C:DE:AB)' },
        ]
        feature._onSelectBluetoothDevice(makeEvent(), deviceList, cb)
        expect(cb).not.toHaveBeenCalled()
        expect(feature.pendingCallback).toBe(cb)
        expect(feature.deviceMacsByName.size).toBe(0)
    })

    test('logs select-bluetooth-device only when the device list changes', () => {
        feature.scanning = true
        feature.logger.logEvent = jest.fn()
        feature.discoveredDeviceIds = new Set(['aa', 'bb'])   // nothing to approve → parked

        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa'), jest.fn())
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa'), jest.fn())
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa', 'bb'), jest.fn())

        const selectLogs = feature.logger.logEvent.mock.calls
            .filter(c => c[0].message === 'select-bluetooth-device')
        expect(selectLogs).toHaveLength(2)
    })

    test('scanning: parks callback when all devices already seen', () => {
        feature.scanning = true
        feature.discoveredDeviceIds = new Set(['aa', 'bb'])
        const cb = jest.fn()
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa', 'bb'), cb)
        expect(cb).not.toHaveBeenCalled()
        expect(feature.pendingCallback).toBe(cb)
    })

    test('scanning: deduplicates — same device not approved twice', () => {
        feature.scanning = true
        const cb1 = jest.fn()
        const cb2 = jest.fn()
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa'), cb1)
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa'), cb2)
        expect(cb1).toHaveBeenCalledWith('aa')
        expect(cb2).not.toHaveBeenCalled()
        expect(feature.pendingCallback).toBe(cb2)
    })

    test('scanning: approves second new device on subsequent event', () => {
        feature.scanning = true
        const cb1 = jest.fn()
        const cb2 = jest.fn()
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa'), cb1)
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa', 'bb'), cb2)
        expect(cb1).toHaveBeenCalledWith('aa')
        expect(cb2).toHaveBeenCalledWith('bb')
    })

    test('scanning: stores MAC in deviceMacsByName as a Set', () => {
        feature.scanning = true
        feature._onSelectBluetoothDevice(makeEvent(), [
            { deviceId: 'F8:E1:A4:32:9C:09', deviceName: 'KICKR CORE C378' },
        ], jest.fn())
        const macs = feature.deviceMacsByName.get('KICKR CORE C378')
        expect(macs).toBeInstanceOf(Set)
        expect(macs.has('F8:E1:A4:32:9C:09')).toBe(true)
    })

    test('scanning: two devices with the same name both get their MACs stored', () => {
        feature.scanning = true
        feature._onSelectBluetoothDevice(makeEvent(), [
            { deviceId: 'AA:BB:CC:DD:EE:01', deviceName: 'Zwift Click' },
        ], jest.fn())
        feature._onSelectBluetoothDevice(makeEvent(), [
            { deviceId: 'AA:BB:CC:DD:EE:02', deviceName: 'Zwift Click' },
        ], jest.fn())
        const macs = feature.deviceMacsByName.get('Zwift Click')
        expect(macs.size).toBe(2)
        expect(macs.has('AA:BB:CC:DD:EE:01')).toBe(true)
        expect(macs.has('AA:BB:CC:DD:EE:02')).toBe(true)
    })

    test('scanning: does not store MAC for anonymous device', () => {
        feature.scanning = true
        feature._onSelectBluetoothDevice(makeEvent(), [
            { deviceId: 'anon-1', deviceName: null },
        ], jest.fn())
        expect(feature.deviceMacsByName.size).toBe(0)
    })

    test('scanning: sets lastApproved to the approved device', () => {
        feature.scanning = true
        feature._onSelectBluetoothDevice(makeEvent(), [
            { deviceId: 'F8:E1:A4:32:9C:09', deviceName: 'KICKR CORE' },
        ], jest.fn())
        expect(feature.lastApproved).toEqual({ deviceId: 'F8:E1:A4:32:9C:09', deviceName: 'KICKR CORE' })
    })

    test('connect target: auto-approves target when found in list', () => {
        feature.connectTargetId = 'target-mac'
        feature.connectTargetExpires = Date.now() + 30000
        const cb = jest.fn()
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('other', 'target-mac'), cb)
        expect(cb).toHaveBeenCalledWith('target-mac')
        expect(feature.connectTargetId).toBeNull()
    })

    test('connect target: takes priority over scan when both active', () => {
        feature.scanning = true
        feature.connectTargetId = 'target-mac'
        feature.connectTargetExpires = Date.now() + 30000
        const cb = jest.fn()
        feature.discoveredDeviceIds = new Set()
        // List contains both a new named scan device and the connect target
        const deviceList = [
            { deviceId: 'new-device', deviceName: 'SomeDevice' },
            { deviceId: 'target-mac', deviceName: 'Volt' },
        ]
        feature._onSelectBluetoothDevice(makeEvent(), deviceList, cb)
        // Should approve the connect target, not the scan device
        expect(cb).toHaveBeenCalledWith('target-mac')
        expect(feature.connectTargetId).toBeNull()
    })

    test('connect target: parks callback when target not in list', () => {
        feature.connectTargetId = 'target-mac'
        feature.connectTargetExpires = Date.now() + 30000
        const cb = jest.fn()
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('other-device'), cb)
        expect(cb).not.toHaveBeenCalled()
        expect(feature.pendingCallback).toBe(cb)
    })

    test('idle: cancels the chooser with empty string', () => {
        feature.scanning = false
        const cb = jest.fn()
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa'), cb)
        expect(cb).toHaveBeenCalledWith('')
    })

    test('idle: does not call ipcSendEvent', () => {
        feature.scanning = false
        feature._onSelectBluetoothDevice(makeEvent(), makeDeviceList('aa'), jest.fn())
        expect(ipcSendEvent).not.toHaveBeenCalled()
    })

})

// ── takeApproved ──────────────────────────────────────────────────────────────

describe('WebBleFeature — takeApproved', () => {

    let feature

    beforeEach(() => {
        feature = new WebBleFeature()
    })

    test('returns MAC when device name matches', () => {
        feature.lastApproved = { deviceId: 'F8:E1:A4:32:9C:09', deviceName: 'KICKR CORE' }
        expect(feature.takeApproved('KICKR CORE')).toBe('F8:E1:A4:32:9C:09')
    })

    test('consume-once: returns null on second call', () => {
        feature.lastApproved = { deviceId: 'F8:E1:A4:32:9C:09', deviceName: 'KICKR CORE' }
        feature.takeApproved('KICKR CORE')
        expect(feature.takeApproved('KICKR CORE')).toBeNull()
    })

    test('returns null when name does not match', () => {
        feature.lastApproved = { deviceId: 'F8:E1:A4:32:9C:09', deviceName: 'KICKR CORE' }
        expect(feature.takeApproved('Volt')).toBeNull()
    })

    test('returns null when no device has been approved', () => {
        expect(feature.takeApproved('Volt')).toBeNull()
    })

    test('handles null name for anonymous device', () => {
        feature.lastApproved = { deviceId: 'anon-id', deviceName: null }
        expect(feature.takeApproved(null)).toBe('anon-id')
    })

    test('returns null when lastApproved name is null but argument is a string', () => {
        feature.lastApproved = { deviceId: 'anon-id', deviceName: null }
        expect(feature.takeApproved('SomeName')).toBeNull()
    })

})

// ── getMac ────────────────────────────────────────────────────────────────────

describe('WebBleFeature — getMac', () => {

    let feature

    beforeEach(() => {
        feature = new WebBleFeature()
    })

    test('returns MAC when exactly one MAC is known for the name', () => {
        feature.deviceMacsByName.set('Volt', new Set(['D4:C9:BB:7D:CB:AF']))
        expect(feature.getMac('Volt')).toBe('D4:C9:BB:7D:CB:AF')
    })

    test('returns null when multiple MACs are known for the name (duplicate device names)', () => {
        feature.deviceMacsByName.set('Zwift Click', new Set(['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02']))
        expect(feature.getMac('Zwift Click')).toBeNull()
    })

    test('returns null for unknown device name', () => {
        expect(feature.getMac('Unknown Device')).toBeNull()
    })

    test('returns null when called with undefined', () => {
        expect(feature.getMac(undefined)).toBeNull()
    })

})

// ── register / registerRenderer ───────────────────────────────────────────────

describe('WebBleFeature — register', () => {

    test('registers web-contents-created listener on app', () => {
        const feature = WebBleFeature.getInstance()
        feature.register({})
        expect(app.on).toHaveBeenCalledWith('web-contents-created', expect.any(Function))
    })

    test('registers all four no-response IPC handlers', () => {
        const feature = WebBleFeature.getInstance()
        feature.register({})
        const keys = ipcHandleNoResponse.mock.calls.map(c => c[0])
        expect(keys).toContain('webble-start-scan')
        expect(keys).toContain('webble-stop-scan')
        expect(keys).toContain('webble-connect')
        expect(keys).toContain('webble-disconnect')
    })

    test('registers webble-get-mac and webble-take-approved as sync handlers', () => {
        const feature = WebBleFeature.getInstance()
        feature.register({})
        const syncKeys = ipcHandleSync.mock.calls.map(c => c[0])
        expect(syncKeys).toContain('webble-get-mac')
        expect(syncKeys).toContain('webble-take-approved')
    })

})

describe('WebBleFeature — registerRenderer', () => {

    let spec, ipcRenderer

    beforeEach(() => {
        spec = { registerFeatures: jest.fn() }
        ipcRenderer = {
            send: jest.fn(),
            on: jest.fn(),
            removeAllListeners: jest.fn(),
        }
    })

    test('populates spec.webble with all required methods', () => {
        const feature = WebBleFeature.getInstance()
        feature.registerRenderer(spec, ipcRenderer)
        expect(typeof spec.webble.getInstance).toBe('function')
        expect(typeof spec.webble.startScanning).toBe('function')
        expect(typeof spec.webble.stopScanning).toBe('function')
        expect(typeof spec.webble.connect).toBe('function')
        expect(typeof spec.webble.disconnect).toBe('function')
        expect(typeof spec.webble.getMac).toBe('function')
        expect(typeof spec.webble.takeApproved).toBe('function')
    })

    test('wires getMac and takeApproved via ipcCallSync', () => {
        const feature = WebBleFeature.getInstance()
        feature.registerRenderer(spec, ipcRenderer)
        const syncKeys = ipcCallSync.mock.calls.map(c => c[0])
        expect(syncKeys).toContain('webble-get-mac')
        expect(syncKeys).toContain('webble-take-approved')
    })

    test('announces webble capabilities', () => {
        const feature = WebBleFeature.getInstance()
        feature.registerRenderer(spec, ipcRenderer)
        expect(spec.registerFeatures).toHaveBeenCalledWith(['webble', 'webble-services'])
    })

    test('startScanning sends webble-start-scan IPC', () => {
        const feature = WebBleFeature.getInstance()
        feature.registerRenderer(spec, ipcRenderer)
        spec.webble.startScanning(['1234'], true)
        expect(ipcRenderer.send).toHaveBeenCalledWith('webble-start-scan', ['1234'], true)
    })

    test('stopScanning sends webble-stop-scan IPC', () => {
        const feature = WebBleFeature.getInstance()
        feature.registerRenderer(spec, ipcRenderer)
        spec.webble.stopScanning()
        expect(ipcRenderer.send).toHaveBeenCalledWith('webble-stop-scan')
    })

    test('connect sends webble-connect IPC with deviceId', () => {
        const feature = WebBleFeature.getInstance()
        feature.registerRenderer(spec, ipcRenderer)
        spec.webble.connect('dev-123')
        expect(ipcRenderer.send).toHaveBeenCalledWith('webble-connect', 'dev-123')
    })

})
