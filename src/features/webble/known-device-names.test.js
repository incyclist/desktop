const { isKnownDeviceName, matchesPart, nameParts, buildEntries, setKnownDeviceNames, getKnownNamesVersion } = require('./known-device-names')

// The cases of nameParts, matchesPart and isKnownDeviceName are the same as in incyclist-services
// (src/devices/known-names/known-names.unit.test.ts), which has its own copy of the matching: keep them in line.

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

describe('matchesPart', () => {
    test('a plain entry matches an equal part only', () => {
        expect(matchesPart('hrm', 'hrm')).toBe(true)
        expect(matchesPart('hrm', 'hrm200')).toBe(false)
    })

    test('an entry ending with * is a family: it matches every part that starts with it', () => {
        expect(matchesPart('hrm*', 'hrm')).toBe(true)
        expect(matchesPart('hrm*', 'hrm200')).toBe(true)
        expect(matchesPart('hrm*', 'hrmpro')).toBe(true)
        expect(matchesPart('hrm*', 'xhrm')).toBe(false)
    })
})

describe('isKnownDeviceName (entries given)', () => {
    const entries = ['tacx', 'hrm', 'assioma*']

    test('a part equal to an entry matches, in any position and spelling', () => {
        expect(isKnownDeviceName('Tacx Neo 2T', entries)).toBe(true)
        expect(isKnownDeviceName('Wahoo TACX', entries)).toBe(true)
        expect(isKnownDeviceName('Polar HRM-Dual:644478', entries)).toBe(true)
    })

    test('a plain entry only matches whole parts, a family the start of a part', () => {
        expect(isKnownDeviceName('HRMPro+', entries)).toBe(false)
        expect(isKnownDeviceName('Tacxx', entries)).toBe(false)
        expect(isKnownDeviceName('AssiomaPRO12774R', entries)).toBe(true)
        expect(isKnownDeviceName('NotAssioma', entries)).toBe(false)
    })

    test('other devices and missing names do not match', () => {
        expect(isKnownDeviceName('JBL PartyBox Club 120', entries)).toBe(false)
        expect(isKnownDeviceName(undefined, entries)).toBe(false)
    })
})

describe('buildEntries', () => {
    test('lower case, without duplicates', () => {
        expect(buildEntries(['Tacx', 'volt', 'TACX', 'Kickr']).sort()).toEqual(['kickr', 'tacx', 'volt'])
    })
})

describe('the list that the renderer pushes in', () => {
    let known

    beforeEach(() => {
        jest.isolateModules(() => { known = require('./known-device-names') })
    })

    test('knows nothing until a list was set', () => {
        expect(known.getKnownNamesVersion()).toBe(0)
        expect(known.isKnownDeviceName('KICKR CORE 4D13')).toBe(false)
    })

    test('a list is taken over, with its version', () => {
        expect(known.setKnownDeviceNames({ version: 3, names: ['kickr', 'hrm*'] })).toBe(true)

        expect(known.getKnownNamesVersion()).toBe(3)
        expect(known.isKnownDeviceName('KICKR CORE 4D13')).toBe(true)
        expect(known.isKnownDeviceName('HRMPro+:329608')).toBe(true)
        expect(known.isKnownDeviceName('JBL PartyBox Club 120')).toBe(false)
    })

    test('a newer list replaces the list, the same version too, an older one is refused', () => {
        known.setKnownDeviceNames({ version: 3, names: ['kickr'] })

        expect(known.setKnownDeviceNames({ version: 4, names: ['tacx'] })).toBe(true)
        expect(known.isKnownDeviceName('KICKR CORE')).toBe(false)
        expect(known.isKnownDeviceName('Tacx Neo')).toBe(true)

        expect(known.setKnownDeviceNames({ version: 4, names: ['tacx', 'zwift'] })).toBe(true)
        expect(known.setKnownDeviceNames({ version: 2, names: ['kickr'] })).toBe(false)
        expect(known.getKnownNamesVersion()).toBe(4)
        expect(known.isKnownDeviceName('Zwift Hub')).toBe(true)
        expect(known.isKnownDeviceName('KICKR CORE')).toBe(false)
    })

    test.each([
        undefined, null, 'kickr', {}, { names: ['kickr'] }, { version: 1 }, { version: 0, names: [] },
        { version: 1.5, names: [] }, { version: '2', names: [] }, { version: 1, names: 'kickr' },
    ])('an invalid list is refused: %j', (list) => {
        expect(known.setKnownDeviceNames(list)).toBe(false)
        expect(known.getKnownNamesVersion()).toBe(0)
    })

    test('entries that are no names are left out (too short, not a string, not a family)', () => {
        known.setKnownDeviceNames({ version: 1, names: ['ab', 42, null, 'a b', 'kickr', 'x*', 'tacx*'] })

        expect(known.isKnownDeviceName('KICKR CORE')).toBe(true)
        expect(known.isKnownDeviceName('Tacx Neo')).toBe(true)
        expect(known.isKnownDeviceName('Ab')).toBe(false)
    })
})
