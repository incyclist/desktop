const { parseList, parseArgs } = require('./suggest')

describe('parseList', () => {
    const ts = `import { KnownDeviceNames } from './types'

export const KNOWN_DEVICE_NAMES: KnownDeviceNames = {
    version: 7,
    names: [
        '808s',
        'assioma*',
        'kickr',
    ],
}
`

    test('reads the version and the names from the TypeScript file of incyclist-services', () => {
        expect(parseList(ts)).toEqual({ version: 7, names: ['808s', 'assioma*', 'kickr'] })
    })

    test('reads a JSON file', () => {
        expect(parseList('{ "version": 2, "names": ["tacx", "hrm*"] }')).toEqual({ version: 2, names: ['tacx', 'hrm*'] })
    })

    test('refuses a file without a list rather than suggesting against an empty one', () => {
        expect(() => parseList('export const x = 1')).toThrow(/no list of known device names/)
    })
})

describe('parseArgs', () => {
    test('defaults and options', () => {
        expect(parseArgs([])).toEqual(expect.objectContaining({ days: 90, top: 60, maxParts: 30 }))
        expect(parseArgs(['--list', 'a.ts', '--days', '30', '--top', '10'])).toEqual(expect.objectContaining({ list: 'a.ts', days: 30, top: 10 }))
    })

    test('an unknown option is refused', () => {
        expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/)
    })
})
