// the whitelist is tested in known-device-names.test.js: here a name starting with "known" counts as known
let mockListVersion = 2
jest.mock('./known-device-names', () => ({
    isKnownDeviceName: jest.fn(name => /^known/i.test(name ?? '')),
    getKnownNamesVersion: jest.fn(() => mockListVersion),
}))

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
    mockListVersion = 2
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

const DAY = 24 * 60 * 60 * 1000

describe('WebBleDeviceCache — a blacklisting is permanent', () => {

    const load = (entries) => {
        fs.existsSync.mockReturnValue(true)
        fs.readFileSync.mockReturnValue(JSON.stringify(entries))
        return new WebBleDeviceCache()
    }

    test('a blacklisting stays, however old it is', () => {
        const cache = load({
            week: { name: 'X', status: 'bad', failCount: 3, reason: 'failures', ts: Date.now() - 8 * DAY },
            year: { name: 'X', status: 'bad', failCount: 3, reason: 'unsupported', ts: Date.now() - 400 * DAY },
        })
        expect(cache.isBad('week')).toBe(true)
        expect(cache.isBad('year')).toBe(true)
    })

    test('entries written by older versions (no timestamp) are kept', () => {
        const cache = load({ legacy: { name: 'JBL PartyBox', status: 'bad', failCount: 3 } })
        expect(cache.isBad('legacy')).toBe(true)
    })

    test('failure counts add up across sessions, however far apart', () => {
        const cache = load({ aa: { name: 'X', failCount: 2, ts: Date.now() - 100 * DAY } })
        cache.recordFailure('aa', 'X')
        expect(cache.isBad('aa')).toBe(true)
    })

    test('a new blacklisting records when and why it happened', () => {
        const cache = new WebBleDeviceCache()
        cache.markBad('aa', 'JBL')
        expect(cache.entries.aa).toEqual(expect.objectContaining({ status: 'bad', reason: 'unsupported', ts: expect.any(Number) }))
        for (let i = 0; i < 3; i++) cache.recordFailure('bb', 'Other')
        expect(cache.entries.bb).toEqual(expect.objectContaining({ status: 'bad', reason: 'failures', ts: expect.any(Number) }))
    })

    test('good devices stay good', () => {
        const cache = load({ trainer: { name: 'Volt', status: 'good', failCount: 0, ts: Date.now() - 400 * DAY } })
        expect(cache.isGood('trainer')).toBe(true)
    })
})

describe('WebBleDeviceCache — known trainer and sensor names', () => {

    const load = (content) => {
        fs.existsSync.mockReturnValue(true)
        fs.readFileSync.mockReturnValue(JSON.stringify(content))
        return new WebBleDeviceCache()
    }
    const stored = (entries, knownNamesVersion = 2) => ({ knownNamesVersion, entries })
    const written = () => JSON.parse(fs.writeFileSync.mock.calls.at(-1)[1])

    const entries = () => ({
        failed: { name: 'KnownTrainer 1', status: 'bad', failCount: 3, reason: 'failures', ts: 1 },
        unsupported: { name: 'KnownTrainer 2', status: 'bad', failCount: 3, reason: 'unsupported', ts: 1 },
        legacy: { name: 'KnownTrainer 3', status: 'bad', failCount: 3 },
        counting: { name: 'KnownTrainer 4', failCount: 2, ts: 1 },
        good: { name: 'KnownTrainer 5', status: 'good', failCount: 0, ts: 1 },
        noise: { name: 'JBL PartyBox', status: 'bad', failCount: 3, reason: 'unsupported', ts: 1 },
    })

    describe('while the device is probed', () => {
        test('a device with a known name is never put on the failed list because it did not respond', () => {
            const cache = new WebBleDeviceCache()
            for (let i = 0; i < 5; i++) cache.recordFailure('aa', 'KnownTrainer 1234')

            expect(cache.isBad('aa')).toBe(false)
            expect(cache.entries.aa).toBeUndefined()
        })

        test('a device with a known name that reports "unsupported" is still blacklisted, and stays so', () => {
            const cache = new WebBleDeviceCache()
            cache.markBad('aa', 'KnownTrainer 1234')

            expect(cache.isBad('aa')).toBe(true)
            expect(cache.entries.aa.reason).toBe('unsupported')
        })

        test('other names are blacklisted for both reasons', () => {
            const cache = new WebBleDeviceCache()
            cache.markBad('aa', 'JBL PartyBox')
            for (let i = 0; i < 3; i++) cache.recordFailure('bb', 'Free Home')

            expect(cache.isBad('aa')).toBe(true)
            expect(cache.isBad('bb')).toBe(true)
        })

        test('the name verdict never applies to a known name: one unsupported KICKR must not hide the others', () => {
            const cache = load(stored({
                a1: { name: 'KnownTrainer', status: 'bad', failCount: 3, reason: 'unsupported', ts: 1 },
                a2: { name: 'KnownTrainer', status: 'bad', failCount: 3, reason: 'unsupported', ts: 2 },
                a3: { name: 'KnownTrainer', status: 'bad', failCount: 3, reason: 'unsupported', ts: 3 },
            }))
            expect(cache.isNameBad('KnownTrainer')).toBe(false)
        })
    })

    describe('the version of the list', () => {
        test('loading a file cleans nothing: the list is not known yet', () => {
            const cache = load(entries())

            expect(cache.isBad('unsupported')).toBe(true)
            expect(fs.writeFileSync).not.toHaveBeenCalled()
        })

        test('a file without a version (older release) is cleaned when the list is set: entries it matches are removed, whatever the reason', () => {
            const cache = load(entries())

            expect(cache.applyKnownNames()).toBe(true)

            expect(cache.isBad('failed')).toBe(false)
            expect(cache.isBad('unsupported')).toBe(false)
            expect(cache.isBad('legacy')).toBe(false)
            expect(cache.entries.counting).toBeUndefined()
            expect(cache.isBad('noise')).toBe(true)
            expect(cache.isGood('good')).toBe(true)
        })

        test('the cleaned file is written with the version of the list', () => {
            const cache = load(entries())
            cache.applyKnownNames()

            const content = written()
            expect(content.knownNamesVersion).toBe(2)
            expect(Object.keys(content.entries).sort()).toEqual(['good', 'noise'])
        })

        test('a file that was cleaned against an older version is cleaned again', () => {
            const cache = load(stored(entries(), 1))

            expect(cache.applyKnownNames()).toBe(true)
            expect(cache.isBad('unsupported')).toBe(false)
            expect(cache.isBad('noise')).toBe(true)
            expect(written().knownNamesVersion).toBe(2)
        })

        test('the cleanup is logged', () => {
            const cache = load(stored(entries(), 1))
            cache.logger.logEvent = jest.fn()

            cache.applyKnownNames()

            expect(cache.logger.logEvent).toHaveBeenCalledWith({ message: 'webble device cache: known device names updated', from: 1, to: 2, removed: 4 })
        })

        test('a file of the same version is left alone: a known device that is unsupported stays blacklisted', () => {
            const cache = load(stored(entries(), 2))

            expect(cache.applyKnownNames()).toBe(false)
            expect(cache.isBad('unsupported')).toBe(true)
            expect(cache.isBad('failed')).toBe(true)
            expect(fs.writeFileSync).not.toHaveBeenCalled()
        })

        test('a file of a higher version (a newer list was seen before) is left alone, too', () => {
            const cache = load(stored(entries(), 5))

            expect(cache.applyKnownNames()).toBe(false)
            expect(cache.isBad('unsupported')).toBe(true)
        })

        test('no list set yet (version 0): nothing is cleaned', () => {
            mockListVersion = 0
            const cache = load(entries())

            expect(cache.applyKnownNames()).toBe(false)
            expect(cache.isBad('unsupported')).toBe(true)
        })

        test('a device that is blacklisted again after the cleanup stays blacklisted until the version changes', () => {
            const cache = load(entries())
            cache.applyKnownNames()
            cache.markBad('again', 'KnownTrainer 6')
            expect(cache.isBad('again')).toBe(true)

            const reloaded = load(written())
            expect(reloaded.applyKnownNames()).toBe(false)
            expect(reloaded.isBad('again')).toBe(true)
        })

        test('a new installation (no file) has nothing to clean and writes nothing when the list is set', () => {
            const cache = new WebBleDeviceCache()

            expect(cache.applyKnownNames()).toBe(true)
            expect(cache.knownNamesVersion).toBe(2)
            expect(fs.writeFileSync).not.toHaveBeenCalled()
        })

        test('the first file that is written carries the version', () => {
            const cache = new WebBleDeviceCache()
            cache.applyKnownNames()
            cache.markBad('aa', 'JBL PartyBox')

            expect(written()).toEqual(expect.objectContaining({ knownNamesVersion: 2, entries: expect.objectContaining({ aa: expect.any(Object) }) }))
        })

        test('a file in the new format is read', () => {
            const cache = load(stored({ aa: { name: 'JBL', status: 'bad', failCount: 3, ts: 1 } }))
            expect(cache.isBad('aa')).toBe(true)
        })
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

    test('the verdict is permanent', () => {
        for (const mac of ['a1', 'a2', 'a3']) cache.recordFailure(mac, 'JBL')
        for (const entry of Object.values(cache.entries)) entry.ts = Date.now() - 400 * DAY

        expect(cache.isNameBad('JBL')).toBe(true)
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
        for (let i = 0; i < 2300; i++) cache.entries[`dev${i}`] = { name: `Name ${i}`, status: 'bad', failCount: 3, reason: 'failures', ts: Date.now() - i }
        cache.markBad('trigger', 'Other')

        expect(Object.keys(cache.entries).length).toBeLessThanOrEqual(2000)
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
