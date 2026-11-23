const { isKnownDeviceName, nameParts, buildEntries } = require('./known-device-names')
const data = require('./known-device-names.json')

describe('nameParts', () => {
    test('drops serial numbers and MAC fragments', () => {
        expect(nameParts('VANRYSEL-HT-c4d1')).toEqual(['vanrysel'])
        expect(nameParts('Tacx Flux-2 30485')).toEqual(['tacx', 'flux'])
        expect(nameParts('KICKR CORE 4D13')).toEqual(['kickr', 'core'])
        expect(nameParts('H6M 58398')).toEqual(['h6m'])
        expect(nameParts('HRMPro+:329608')).toEqual(['hrmpro'])
    })

    test('cuts a serial number that is glued to the name', () => {
        expect(nameParts('AssiomaPRO12774R')).toEqual(['assiomapro'])
        expect(nameParts('YESOUL2708033')).toEqual(['yesoul'])
        expect(nameParts('D2Ride2121')).toEqual(['d2ride'])
    })

    test('copes with missing names', () => {
        expect(nameParts(undefined)).toEqual([])
        expect(nameParts('')).toEqual([])
        expect(nameParts(42)).toEqual([])
    })
})

describe('isKnownDeviceName (entries given)', () => {
    const entries = ['tacx', 'hrm', 'assioma']

    test('a part equal to an entry matches, in any position and spelling', () => {
        expect(isKnownDeviceName('Tacx Neo 2T', entries)).toBe(true)
        expect(isKnownDeviceName('Wahoo TACX', entries)).toBe(true)
        expect(isKnownDeviceName('Polar HRM-Dual:644478', entries)).toBe(true)
    })

    test('a short entry only matches whole parts', () => {
        expect(isKnownDeviceName('HRMPro+', entries)).toBe(false)
        expect(isKnownDeviceName('Hrmonic', entries)).toBe(false)
    })

    test('a long entry also matches the start of a part', () => {
        expect(isKnownDeviceName('AssiomaPRO12774R', entries)).toBe(true)
        expect(isKnownDeviceName('Assioma', entries)).toBe(true)
        expect(isKnownDeviceName('NotAssioma', entries)).toBe(false)
    })

    test('other devices do not match', () => {
        expect(isKnownDeviceName('JBL PartyBox Club 120', entries)).toBe(false)
        expect(isKnownDeviceName('free@home', entries)).toBe(false)
        expect(isKnownDeviceName(undefined, entries)).toBe(false)
    })
})

describe('buildEntries', () => {
    test('lower case, without duplicates', () => {
        expect(buildEntries(['Tacx', 'volt', 'TACX', 'Kickr']).sort()).toEqual(['kickr', 'tacx', 'volt'])
    })
})

describe('the list that is shipped', () => {
    test('is a list of lower case parts of at least 3 characters, without duplicates', () => {
        expect(Array.isArray(data)).toBe(true)
        for (const entry of data) {
            expect(entry).toBe(entry.toLowerCase())
            expect(entry.length).toBeGreaterThanOrEqual(3)
            expect(entry).toMatch(/^[a-z0-9]+$/)
        }
        expect(new Set(data).size).toBe(data.length)
    })

    test('has no redundant entries: an entry of 5+ characters already matches every part that starts with it', () => {
        const redundant = data.filter(entry => data.some(other => other !== entry && other.length >= 5 && entry.startsWith(other)))
        expect(redundant).toEqual([])
    })

    test('is sorted, so that a change shows up clearly in a review', () => {
        expect([...data]).toEqual([...data].sort())
    })

    test('contains the parts the maintainers asked for', () => {
        for (const entry of ['tacx', 'volt', 'wahoo', 'zwift', 'hrm']) {
            expect(buildEntries(data)).toContain(entry)
        }
    })

    test.each([
        'Tacx Flux-2 30485', 'KICKR CORE 4D13', 'Wahoo KICKR 7A07', 'Zwift Hub', 'Volt', 'HRM-Dual:644478', 'Polar H10 12345678',
        'ASSIOMA08675R', 'AssiomaPRO12774R',
    ])('recognises the trainer or sensor %s', (name) => {
        expect(isKnownDeviceName(name)).toBe(true)
    })

    test.each([
        'JBL PartyBox Club 120', 'free@home', '1K1DA2502P1761', 'Galaxy Buds2 Pro LE', 'Smart TV Pro', 'Core300s', undefined,
    ])('does not recognise the noise device %s', (name) => {
        expect(isKnownDeviceName(name)).toBe(false)
    })
})
