const { buildKnownParts } = require('./generate')

const real = (list) => list.map(([name, users]) => ({ name, users }))
const parts = (picked) => picked.map(p => p.part)

describe('buildKnownParts', () => {
    test('picks the brand part and not the parts that only occur next to it', () => {
        const picked = buildKnownParts(real([
            ['KICKR CORE 1111', 10], ['KICKR SNAP 2222', 6], ['Wahoo KICKR 3333', 4], ['KICKR CORE', 5],
        ]), [])
        expect(parts(picked)).toEqual(['kickr'])
    })

    test('device serial numbers do not matter: the same model counts as one part', () => {
        const picked = buildKnownParts(real([
            ['VANRYSEL-HT-c4d1', 2], ['VANRYSEL-HT-a40e', 2], ['VANRYSEL-HT-5701', 2],
        ]), [])
        expect(parts(picked)).toEqual(['vanrysel'])
        expect(picked[0]).toEqual(expect.objectContaining({ users: 6, names: 3 }))
    })

    test('a part that few users share is not picked', () => {
        const picked = buildKnownParts(real([['Rarebike X1', 1], ['Rarebike X2', 1]]), [], { minUsers: 3 })
        expect(picked).toEqual([])
    })

    test('a generic part that occurs in many confirmed-unsupported devices is not picked', () => {
        const unsupported = real([['Galaxy Buds2 Pro LE', 1], ['Galaxy Buds4 Pro LE', 1], ['Smart TV Pro', 1], ['Mi Pro', 1]])
        const picked = buildKnownParts(real([['Acme Pro', 5], ['Zeta Pro', 5], ['Omega Pro', 5]]), unsupported, { maxNoiseRatio: 0.3 })
        expect(parts(picked)).not.toContain('pro')
        expect(parts(picked).sort()).toEqual(['acme', 'omega', 'zeta'].filter(p => parts(picked).includes(p)))
    })

    test('a part that is rare among confirmed-unsupported devices is still picked (real trainers are sometimes flagged, too)', () => {
        const real10 = Array.from({ length: 10 }, (_, i) => [`Tacx Neo ${1000 + i}`, 2])
        const picked = buildKnownParts(real(real10), real([['Tacx Neo 07540', 1]]))
        expect(parts(picked)).toContain('tacx')
    })

    test('on a tie the brand wins over a generic model word: rarer among unsupported devices, then the longer part', () => {
        const names = Array.from({ length: 6 }, (_, i) => [`Tacx Neo ${1000 + i}`, 1])
        const picked = buildKnownParts(real(names), real([['65 Neo QLED', 1]]))
        expect(parts(picked)).toEqual(['tacx'])
    })

    test('the result is stable: equal parts are ordered alphabetically', () => {
        const picked = buildKnownParts(real([['Bbb Aaa', 5]]), [])
        expect(parts(picked)[0]).toBe('aaa')
    })

    test('works without any data', () => {
        expect(buildKnownParts([], [])).toEqual([])
    })
})
