jest.mock('../utils', () => ({
    ipcCall: jest.fn(() => jest.fn()),
    ipcSendEvent: jest.fn(),
    ipcResponse: jest.fn(),
    isTrue: jest.fn(),
    ipcCallNoResponse: jest.fn(() => jest.fn()),
    ipcHandle: jest.fn(),
    ipcHandleNoResponse: jest.fn(),
}))

jest.mock('./bleserver-binding', () => ({ getInstance: jest.fn() }))
jest.mock('./ipc-binding', () => ({ getInstance: jest.fn(() => ({ setApi: jest.fn() })) }))

const { ipcResponse } = require('../utils')
const BLEFeature = require('./index')

const makeEvent = () => ({ sender: { send: jest.fn() } })

const lastResponsePayload = () => ipcResponse.mock.calls[ipcResponse.mock.calls.length - 1][3]

beforeEach(() => {
    jest.clearAllMocks()
})

// ── getServicesAndCharacteristicsRequest ───────────────────────────────────────
// Merge/never-overwrite-with-empty is handled inside WinrtBindings (bleserver-binding.js),
// scoped to the WinRT backend where the "busy service returns empty" quirk actually
// occurs. index.js runs on every platform (WinRT, mac/hci-socket, ...) so it stores
// exactly what the active binding's peripheral reports — a plain overwrite.

describe('BLEFeature — getServicesAndCharacteristicsRequest', () => {

    let feature, event

    beforeEach(() => {
        feature = new BLEFeature()
        event = makeEvent()
    })

    test('stores whatever the peripheral reports, as-is', async () => {
        const peripheral = {
            id: 'p1',
            services: [{ uuid: 'svc1' }],
            characteristics: [{ uuid: 'aaa', properties: ['read'] }],
            discoverSomeServicesAndCharacteristicsAsync: jest.fn().mockResolvedValue({
                services: [{ uuid: 'svc2' }],
                characteristics: [{ uuid: 'bbb', properties: ['notify'] }],
            }),
        }
        feature.peripherals = [peripheral]

        await feature.getServicesAndCharacteristicsRequest(event, 'call-1', 'p1', [], [])

        // the binding is the source of truth — index.js does not second-guess it
        expect(peripheral.services).toEqual([{ uuid: 'svc2' }])
        expect(peripheral.characteristics).toEqual([{ uuid: 'bbb', properties: ['notify'] }])
    })

    test('does not throw when discovery rejects, and reports the error via ipcResponse', async () => {
        const err = new Error('boom')
        const peripheral = {
            id: 'p1',
            discoverSomeServicesAndCharacteristicsAsync: jest.fn().mockRejectedValue(err),
        }
        feature.peripherals = [peripheral]

        await expect(
            feature.getServicesAndCharacteristicsRequest(event, 'call-1', 'p1', [], [])
        ).resolves.toBeUndefined()

        const payload = lastResponsePayload()
        expect(payload.error).toBe(err)
        expect(payload.services).toBeNull()
        expect(payload.characteristics).toBeNull()
    })

    test('response characteristics reflect the discovery result, not the requested filter', async () => {
        const peripheral = {
            id: 'p1',
            discoverSomeServicesAndCharacteristicsAsync: jest.fn().mockResolvedValue({
                services: [{ uuid: 'svc1' }],
                characteristics: [{ uuid: 'char1' }],
            }),
        }
        feature.peripherals = [peripheral]

        // requested characteristics filter is undefined — previously the response used
        // this argument (instead of the actual result) to decide whether to report null
        await feature.getServicesAndCharacteristicsRequest(event, 'call-1', 'p1', [], undefined)

        const payload = lastResponsePayload()
        expect(payload.characteristics).toEqual([{ uuid: 'char1' }])
    })

})

// ── getServicesRequest ──────────────────────────────────────────────────────

describe('BLEFeature — getServicesRequest', () => {

    let feature, event

    beforeEach(() => {
        feature = new BLEFeature()
        event = makeEvent()
    })

    test('stores whatever the peripheral reports, as-is', async () => {
        const peripheral = {
            id: 'p1',
            services: [{ uuid: 'svc1' }],
            discoverServicesAsync: jest.fn().mockResolvedValue([{ uuid: 'svc2' }]),
        }
        feature.peripherals = [peripheral]

        await feature.getServicesRequest(event, 'call-1', 'p1', [])

        expect(peripheral.services).toEqual([{ uuid: 'svc2' }])
    })

})

// ── subscribeRequest / unsubscribeRequest / readRequest / write — ─────────────
// ── null-check ordering: must not dereference peripheral.characteristics ──────
// ── before confirming the peripheral itself was found                    ──────

describe('BLEFeature — null-check ordering when peripheral is not found', () => {

    let feature, event

    beforeEach(() => {
        feature = new BLEFeature()
        event = makeEvent()
        feature.peripherals = []
    })

    test('subscribeRequest resolves and reports "device not found" instead of throwing', async () => {
        await expect(
            feature.subscribeRequest(event, 'call-1', 'missing-id', 'char-uuid')
        ).resolves.toBeUndefined()

        expect(ipcResponse).toHaveBeenCalledTimes(1)
        const payload = lastResponsePayload()
        expect(payload).toBeInstanceOf(Error)
        expect(payload.message).toBe('device not found')
    })

    test('unsubscribeRequest resolves and reports "device not found" instead of throwing', async () => {
        await expect(
            feature.unsubscribeRequest(event, 'call-1', 'missing-id', 'char-uuid')
        ).resolves.toBeUndefined()

        const payload = lastResponsePayload()
        expect(payload).toBeInstanceOf(Error)
        expect(payload.message).toBe('device not found')
    })

    test('readRequest resolves and reports "device not found" instead of throwing', async () => {
        await expect(
            feature.readRequest(event, 'call-1', 'missing-id', 'char-uuid')
        ).resolves.toBeUndefined()

        const payload = lastResponsePayload()
        expect(payload.err.message).toBe('device not found')
        expect(payload.data).toBeNull()
    })

    test('write rejects with "device not found" instead of throwing a TypeError', async () => {
        await expect(
            feature.write('missing-id', 'char-uuid', Buffer.from([1]), false)
        ).rejects.toThrow('device not found')
    })

})

describe('BLEFeature — null-check ordering when peripheral exists but characteristic is missing', () => {

    let feature, event

    beforeEach(() => {
        feature = new BLEFeature()
        event = makeEvent()
        feature.peripherals = [{ id: 'p1', characteristics: [] }]
    })

    test('subscribeRequest reports "characteristic not found"', async () => {
        await feature.subscribeRequest(event, 'call-1', 'p1', 'missing-char')
        const payload = lastResponsePayload()
        expect(payload.message).toBe('characteristic not found')
    })

    test('unsubscribeRequest reports "characteristic not found"', async () => {
        await feature.unsubscribeRequest(event, 'call-1', 'p1', 'missing-char')
        const payload = lastResponsePayload()
        expect(payload.message).toBe('characteristic not found')
    })

    test('write rejects with "characteristic not found"', async () => {
        await expect(
            feature.write('p1', 'missing-char', Buffer.from([1]), false)
        ).rejects.toThrow('characteristic not found')
    })

})
