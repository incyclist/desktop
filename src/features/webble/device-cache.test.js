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
            'AA:BB:CC:DD:EE:FF': { name: 'JBL PartyBox', status: 'bad', failCount: 3, ts: Date.now(), reason: 'failures' },
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

const HOUR = 60 * 60 * 1000

describe('WebBleDeviceCache — expiry', () => {

    const load = (entries) => {
        fs.existsSync.mockReturnValue(true)
        fs.readFileSync.mockReturnValue(JSON.stringify(entries))
        return new WebBleDeviceCache()
    }

    test('a blacklisting after failed connects expires after 24 hours', () => {
        const cache = load({
            fresh: { name: 'X', status: 'bad', failCount: 3, reason: 'failures', ts: Date.now() - 23 * HOUR },
            old: { name: 'X', status: 'bad', failCount: 3, reason: 'failures', ts: Date.now() - 25 * HOUR },
        })
        expect(cache.isBad('fresh')).toBe(true)
        expect(cache.isBad('old')).toBe(false)
    })

    test('a device confirmed unsupported stays blacklisted for 7 days', () => {
        const cache = load({
            fresh: { name: 'X', status: 'bad', failCount: 3, reason: 'unsupported', ts: Date.now() - 6 * 24 * HOUR },
            old: { name: 'X', status: 'bad', failCount: 3, reason: 'unsupported', ts: Date.now() - 8 * 24 * HOUR },
        })
        expect(cache.isBad('fresh')).toBe(true)
        expect(cache.isBad('old')).toBe(false)
    })

    test('entries written by older versions (no timestamp) are dropped once, and the file is rewritten', () => {
        const cache = load({
            legacyBad: { name: 'JBL PartyBox', status: 'bad', failCount: 3 },
            legacyGood: { name: 'Volt', status: 'good', failCount: 0 },
        })
        expect(cache.isBad('legacyBad')).toBe(false)
        expect(cache.entries.legacyBad).toBeUndefined()
        expect(cache.isGood('legacyGood')).toBe(true)
        expect(fs.writeFileSync).toHaveBeenCalled()
    })

    test('good devices never expire', () => {
        const cache = load({ trainer: { name: 'Volt', status: 'good', failCount: 0, ts: Date.now() - 400 * 24 * HOUR } })
        expect(cache.isGood('trainer')).toBe(true)
    })

    test('failure counts expire too: old failures do not add up to a blacklisting', () => {
        const cache = load({ aa: { name: 'X', failCount: 2, ts: Date.now() - 25 * HOUR } })
        cache.recordFailure('aa', 'X')
        expect(cache.entries.aa.failCount).toBe(1)
        expect(cache.isBad('aa')).toBe(false)
    })

    test('a new blacklisting records when and why it happened', () => {
        const cache = new WebBleDeviceCache()
        cache.markBad('aa', 'JBL')
        expect(cache.entries.aa).toEqual(expect.objectContaining({ status: 'bad', reason: 'unsupported', ts: expect.any(Number) }))
        for (let i = 0; i < 3; i++) cache.recordFailure('bb', 'Other')
        expect(cache.entries.bb).toEqual(expect.objectContaining({ status: 'bad', reason: 'failures', ts: expect.any(Number) }))
    })
})

describe('WebBleDeviceCache — name verdict (rotating addresses)', () => {

    let cache

    beforeEach(() => {
        cache = new WebBleDeviceCache()
    })

    test('a name is bad once three different addresses failed', () => {
        cache.recordFailure('a1', 'JBL PartyBox')
        cache.markBad('a2', 'JBL PartyBox')
        expect(cache.isNameBad('JBL PartyBox')).toBe(false)

        cache.recordFailure('a3', 'JBL PartyBox')

        expect(cache.isNameBad('JBL PartyBox')).toBe(true)
    })

    test('the same address failing repeatedly is one address, not three', () => {
        cache.recordFailure('a1', 'Volt')
        cache.recordFailure('a1', 'Volt')

        expect(cache.isNameBad('Volt')).toBe(false)
    })

    test('a name with a good device is never bad (several real devices can share a name)', () => {
        cache.markGood('mine', 'Volt')
        cache.recordFailure('a1', 'Volt')
        cache.markBad('a2', 'Volt')
        cache.recordFailure('a3', 'Volt')

        expect(cache.isNameBad('Volt')).toBe(false)
    })

    test('other names and missing names are unaffected', () => {
        cache.recordFailure('a1', 'JBL')
        cache.recordFailure('a2', 'JBL')
        cache.recordFailure('a3', 'JBL')

        expect(cache.isNameBad('Volt')).toBe(false)
        expect(cache.isNameBad(undefined)).toBe(false)
    })

    test('the verdict ends when the failures expire', () => {
        for (const mac of ['a1', 'a2', 'a3']) cache.recordFailure(mac, 'JBL')
        expect(cache.isNameBad('JBL')).toBe(true)

        for (const entry of Object.values(cache.entries)) entry.ts = Date.now() - 25 * HOUR

        expect(cache.isNameBad('JBL')).toBe(false)
    })
})

describe('WebBleDeviceCache — size limits', () => {

    test('hundreds of rotating addresses with one name keep only the newest entries', () => {
        const cache = new WebBleDeviceCache()
        for (let i = 0; i < 300; i++) {
            cache.markBad(`mac${i}`, 'JBL PartyBox')
            cache.entries[`mac${i}`].ts = Date.now() - (300 - i)    // later addresses are newer
        }
        cache.markBad('last', 'JBL PartyBox')

        const jbl = Object.keys(cache.entries).filter(mac => cache.entries[mac].name === 'JBL PartyBox')
        expect(jbl.length).toBeLessThanOrEqual(10)
        expect(jbl).toContain('last')
        expect(cache.isNameBad('JBL PartyBox')).toBe(true)
    })

    test('the total size is capped, and good devices are never dropped', () => {
        const cache = new WebBleDeviceCache()
        cache.markGood('mine', 'Volt')
        for (let i = 0; i < 700; i++) cache.entries[`dev${i}`] = { name: `Name ${i}`, status: 'bad', failCount: 3, reason: 'failures', ts: Date.now() - i }
        cache.markBad('trigger', 'Other')

        expect(Object.keys(cache.entries).length).toBeLessThanOrEqual(500)
        expect(cache.isGood('mine')).toBe(true)
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
