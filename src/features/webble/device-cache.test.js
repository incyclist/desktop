jest.mock('fs')
jest.mock('../../utils', () => ({
    getAppDirectory: jest.fn(() => '/fake/app/dir'),
}))

const fs = require('fs')
const path = require('path')
const WebBleDeviceCache = require('./device-cache')

const EXPECTED_FILE = path.join('/fake/app/dir', 'webble-devices.json')

beforeEach(() => {
    jest.clearAllMocks()
    fs.existsSync.mockReturnValue(false)
})

describe('WebBleDeviceCache — loading', () => {

    test('starts empty when no file exists', () => {
        fs.existsSync.mockReturnValue(false)
        const cache = new WebBleDeviceCache()
        expect(cache.isGood('aa')).toBe(false)
        expect(cache.isBad('aa')).toBe(false)
    })

    test('loads persisted entries from the app-data file', () => {
        fs.existsSync.mockReturnValue(true)
        fs.readFileSync.mockReturnValue(JSON.stringify({
            'D4:C9:BB:7D:CB:AF': { name: 'Volt', status: 'good', failCount: 0 },
            'AA:BB:CC:DD:EE:FF': { name: 'JBL PartyBox', status: 'bad', failCount: 3 },
        }))

        const cache = new WebBleDeviceCache()

        expect(cache.isGood('D4:C9:BB:7D:CB:AF')).toBe(true)
        expect(cache.isBad('AA:BB:CC:DD:EE:FF')).toBe(true)
    })

    test('reads from the app-data directory, not the source tree', () => {
        fs.existsSync.mockReturnValue(true)
        fs.readFileSync.mockReturnValue('{}')

        new WebBleDeviceCache()

        expect(fs.existsSync).toHaveBeenCalledWith(EXPECTED_FILE)
        expect(fs.readFileSync).toHaveBeenCalledWith(EXPECTED_FILE, 'utf8')
    })

    test('starts empty (does not throw) when the file is corrupt', () => {
        fs.existsSync.mockReturnValue(true)
        fs.readFileSync.mockReturnValue('{ not valid json')

        const cache = new WebBleDeviceCache()

        expect(cache.isGood('aa')).toBe(false)
        expect(cache.isBad('aa')).toBe(false)
    })

    test('starts empty (does not throw) when reading the file fails', () => {
        fs.existsSync.mockReturnValue(true)
        fs.readFileSync.mockImplementation(() => { throw new Error('EACCES') })

        expect(() => new WebBleDeviceCache()).not.toThrow()
    })

})

describe('WebBleDeviceCache — markGood', () => {

    let cache

    beforeEach(() => {
        cache = new WebBleDeviceCache()
    })

    test('marks a MAC as good', () => {
        cache.markGood('D4:C9:BB:7D:CB:AF', 'Volt')
        expect(cache.isGood('D4:C9:BB:7D:CB:AF')).toBe(true)
    })

    test('persists to the app-data file', () => {
        cache.markGood('D4:C9:BB:7D:CB:AF', 'Volt')
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            EXPECTED_FILE,
            expect.stringContaining('"D4:C9:BB:7D:CB:AF"'),
            expect.objectContaining({ encoding: 'utf8' })
        )
    })

    test('is a no-op without a deviceId', () => {
        cache.markGood(undefined, 'Volt')
        expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    test('overturns a previously-bad classification (explicit connect always wins)', () => {
        cache.recordFailure('aa', 'Flaky')
        cache.recordFailure('aa', 'Flaky')
        cache.recordFailure('aa', 'Flaky')
        expect(cache.isBad('aa')).toBe(true)

        cache.markGood('aa', 'Flaky')

        expect(cache.isBad('aa')).toBe(false)
        expect(cache.isGood('aa')).toBe(true)
    })

    test('does not re-save when already good (no-op on repeat calls)', () => {
        cache.markGood('D4:C9:BB:7D:CB:AF', 'Volt')
        fs.writeFileSync.mockClear()

        cache.markGood('D4:C9:BB:7D:CB:AF', 'Volt')

        expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

})

describe('WebBleDeviceCache — markBad', () => {

    let cache

    beforeEach(() => {
        cache = new WebBleDeviceCache()
    })

    test('blacklists immediately, without needing repeated failures', () => {
        cache.markBad('aa', 'JBL PartyBox')
        expect(cache.isBad('aa')).toBe(true)
    })

    test('persists to the app-data file', () => {
        cache.markBad('aa', 'JBL PartyBox')
        expect(fs.writeFileSync).toHaveBeenCalled()
    })

    test('is a no-op without a deviceId', () => {
        cache.markBad(undefined, 'JBL PartyBox')
        expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    test('never downgrades an already-good device', () => {
        cache.markGood('aa', 'Volt')
        cache.markBad('aa', 'Volt')
        expect(cache.isGood('aa')).toBe(true)
        expect(cache.isBad('aa')).toBe(false)
    })

})

describe('WebBleDeviceCache — recordFailure', () => {

    let cache

    beforeEach(() => {
        cache = new WebBleDeviceCache()
    })

    test('does not blacklist below the failure threshold', () => {
        cache.recordFailure('aa', 'JBL PartyBox')
        cache.recordFailure('aa', 'JBL PartyBox')
        expect(cache.isBad('aa')).toBe(false)
    })

    test('blacklists after repeated failures', () => {
        cache.recordFailure('aa', 'JBL PartyBox')
        cache.recordFailure('aa', 'JBL PartyBox')
        cache.recordFailure('aa', 'JBL PartyBox')
        expect(cache.isBad('aa')).toBe(true)
    })

    test('never downgrades a device that is already good, however often it fails', () => {
        cache.markGood('aa', 'Volt')
        cache.recordFailure('aa', 'Volt')
        cache.recordFailure('aa', 'Volt')
        cache.recordFailure('aa', 'Volt')
        cache.recordFailure('aa', 'Volt')
        expect(cache.isGood('aa')).toBe(true)
        expect(cache.isBad('aa')).toBe(false)
    })

    test('is a no-op without a deviceId', () => {
        expect(() => cache.recordFailure(undefined, 'x')).not.toThrow()
    })

    test('persists to the app-data file', () => {
        cache.recordFailure('aa', 'JBL PartyBox')
        expect(fs.writeFileSync).toHaveBeenCalled()
    })

})

describe('WebBleDeviceCache — getInstance', () => {

    test('returns the same instance across calls', () => {
        WebBleDeviceCache._instance = undefined
        const a = WebBleDeviceCache.getInstance()
        const b = WebBleDeviceCache.getInstance()
        expect(a).toBe(b)
    })

})
