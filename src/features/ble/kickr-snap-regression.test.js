// Regression test for the KICKR SNAP Windows discovery bug:
//   connect -> get services -> get characteristics (once per service) -> [pairing
//   timeout] -> retry: get services -> get characteristics (again, per service)
//
// Root cause: a retried discovery re-queries WinRT for a service that was already
// discovered successfully. If WinRT (still busy internally) answers the retry with
// an empty characteristics list, the plain `peripheral.characteristics = result`
// overwrite in getServicesAndCharacteristicsRequest wiped out the good data.
//
// This wires up the REAL noble Noble/Peripheral/Service/Characteristic classes plus
// the REAL WinrtBindings against the real BLEFeature (index.js) — only the native
// process boundary (_sendRequest) is mocked. Unlike the isolated unit tests in
// bleserver-binding.test.js and index.test.js, this proves the fix holds across the
// full stack the production bug actually went through.

jest.mock('../utils', () => ({
    ipcCall: jest.fn(() => jest.fn()),
    ipcSendEvent: jest.fn(),
    ipcResponse: jest.fn(),
    isTrue: jest.fn(),
    ipcCallNoResponse: jest.fn(() => jest.fn()),
    ipcHandle: jest.fn(),
    ipcHandleNoResponse: jest.fn(),
}))
jest.mock('./ipc-binding', () => ({ getInstance: jest.fn(() => ({ setApi: jest.fn() })) }))

const BLEFeature = require('./index')
const WinrtBindings = require('./bleserver-binding')
const Noble = require('@stoprocent/noble/lib/noble')

const DEVICE_ID = 'F8E1A4329C09'
const SERVICE_UUIDS = ['1800', '1801', '1818'] // last one is the "busy" service on retry
const BUSY_SERVICE = '1818'

const rawServices = () => SERVICE_UUIDS.map(s => `{${s}}`)
const rawCharacteristic = (uuid) => ({ uuid: `{${uuid}}`, properties: { notify: true, read: false } })

// one distinct characteristic per service, so we can tell whether it survived
const charForService = {
    1800: rawCharacteristic('2a00'),
    1801: rawCharacteristic('2a01'),
    1818: rawCharacteristic('2a63'),
}

const makeEvent = () => ({ sender: { send: jest.fn() } })

describe('KICKR SNAP Windows discovery regression', () => {

    let binding, noble, feature, peripheral

    beforeEach(async () => {
        binding = new WinrtBindings('./test/out', { bleServerDebug: false })
        binding._deviceMap = {}
        binding._requestId = 0
        binding._requests = {}
        binding._subscriptions = {}

        noble = new Noble(binding)

        feature = new BLEFeature()
        feature.ble = noble
        feature.ble.on('discover', feature.onDiscoverFn)

        // connect
        binding.emit('discover', DEVICE_ID, DEVICE_ID, 'public', true, {}, -60)
        peripheral = feature.peripherals.find(p => p.id === DEVICE_ID)

        jest.spyOn(binding, '_sendRequest').mockImplementation((msg) => {
            if (msg.cmd === 'connect')
                return Promise.resolve('device-handle-1')
            if (msg.cmd === 'services')
                return Promise.resolve(rawServices())
            if (msg.cmd === 'characteristics') {
                const serviceUuid = msg.service.replace(/[{}]/g, '')
                return Promise.resolve([charForService[serviceUuid]])
            }
            return Promise.reject(new Error(`unexpected cmd ${msg.cmd}`))
        })

        await feature.connectDeviceRequest(makeEvent(), 'call-connect', DEVICE_ID)
    })

    const charCallsFor = (serviceUuid) =>
        binding._sendRequest.mock.calls.filter(
            ([msg]) => msg.cmd === 'characteristics' && msg.service === `{${serviceUuid}}`
        ).length

    test('round 1 discovers all services and characteristics successfully', async () => {
        await feature.getServicesAndCharacteristicsRequest(makeEvent(), 'call-1', DEVICE_ID, [], [])

        expect(peripheral.characteristics.map(c => c.uuid)).toEqual(
            expect.arrayContaining(['2a00', '2a01', '2a63'])
        )
    })

    test('a retry that re-discovers the same device does not lose previously-discovered characteristics', async () => {
        // round 1: initial pairing attempt — succeeds fully
        await feature.getServicesAndCharacteristicsRequest(makeEvent(), 'call-1', DEVICE_ID, [], [])
        expect(peripheral.characteristics.map(c => c.uuid)).toEqual(
            expect.arrayContaining(['2a00', '2a01', '2a63'])
        )

        // simulate WinRT being internally busy for the '1818' service specifically:
        // any *new* raw round-trip for it from here on comes back empty
        binding._sendRequest.mockImplementation((msg) => {
            if (msg.cmd === 'services')
                return Promise.resolve(rawServices())
            if (msg.cmd === 'characteristics') {
                const serviceUuid = msg.service.replace(/[{}]/g, '')
                if (serviceUuid === BUSY_SERVICE)
                    return Promise.resolve([]) // WinRT: busy service -> empty result
                return Promise.resolve([charForService[serviceUuid]])
            }
            return Promise.reject(new Error(`unexpected cmd ${msg.cmd}`))
        })

        // round 2: the pairing timeout fired and the caller immediately retries
        // discovery on the same (still connected) peripheral
        await feature.getServicesAndCharacteristicsRequest(makeEvent(), 'call-2', DEVICE_ID, [], [])

        // the '1818' characteristic discovered in round 1 must still be there —
        // it must not have been wiped by the retry's empty/busy response
        expect(peripheral.characteristics.map(c => c.uuid)).toEqual(
            expect.arrayContaining(['2a00', '2a01', '2a63'])
        )

        // and the mechanism must be: the retry never even re-queried the already
        // successfully-discovered '1818' service — proving the round-trip was
        // actually shared/cached, not just a lucky mock response
        expect(charCallsFor(BUSY_SERVICE)).toBe(1)
    })

    // Note: a variant where round 2 starts *before* round 1's per-service
    // discoverCharacteristics settles is intentionally not modeled here — noble's
    // own onServicesDiscover rebuilds fresh Service objects and overwrites its
    // internal peripheralId/serviceUuid -> Service map on every discoverServices
    // call, which orphans round 1's in-flight per-service listeners regardless of
    // our binding. That's a noble object-lifecycle characteristic, not something
    // our WinRT binding fix controls. The concurrent/"still in flight" coalescing
    // behavior itself is covered deterministically at the binding level in
    // bleserver-binding.test.js (no dependency on noble's Service object identity).

})
