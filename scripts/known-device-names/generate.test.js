const { buildKnownParts, buildSuggestions, buildPartTable } = require('./generate')

const real = (list) => list.map(([name, users]) => ({ name, users }))
const parts = (picked) => picked.map(p => p.part)

describe('buildKnownParts', () => {
    test('picks the brand part and not the parts that only occur next to it', () => {
        const picked = buildKnownParts(real([
            ['KICKR CORE 1111', 10], ['KICKR SNAP 2222', 6], ['Wahoo KICKR 3333', 4], ['KICKR CORE', 5],
        ]))
        expect(parts(picked)).toEqual(['kickr'])
    })

    test('device serial numbers do not matter: the same model counts as one part', () => {
        const picked = buildKnownParts(real([
            ['VANRYSEL-HT-c4d1', 2], ['VANRYSEL-HT-a40e', 2], ['VANRYSEL-HT-5701', 2],
        ]))
        expect(parts(picked)).toEqual(['vanrysel'])
        expect(picked[0]).toEqual(expect.objectContaining({ users: 6, names: 3 }))
    })

    test('a part that few users share is not picked', () => {
        expect(buildKnownParts(real([['Rarebike X1', 1], ['Rarebike X2', 1]]), { minUsers: 3 })).toEqual([])
    })

    test('on a tie the more specific (longer) part wins: the brand, not the model word', () => {
        const names = Array.from({ length: 6 }, (_, i) => [`Tacx Neo ${1000 + i}`, 1])
        expect(parts(buildKnownParts(real(names)))).toEqual(['tacx'])
    })

    test('the result is stable: equal parts are ordered alphabetically', () => {
        expect(parts(buildKnownParts(real([['Bbb Aaa', 5]])))[0]).toBe('aaa')
    })

    test('works without any data', () => {
        expect(buildKnownParts([])).toEqual([])
    })

    test('at most maxParts parts are picked', () => {
        const words = ['alpha', 'bravo', 'charlie', 'delta', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo']
        const names = words.map((w, i) => [w, 5 + i])
        expect(buildKnownParts(real(names), { maxParts: 4 })).toHaveLength(4)
    })

    test('names that the current list already covers are not covered again', () => {
        const names = real([['KICKR CORE 1111', 10], ['VANRYSEL-HT-c4d1', 5], ['VANRYSEL-HT-a40e', 5]])
        const picked = buildKnownParts(names, { isCovered: name => name.startsWith('KICKR') })
        expect(parts(picked)).toEqual(['vanrysel'])
    })

    test('reports how many users the parts cover together', () => {
        const picked = buildKnownParts(real([['Aaaa One', 5], ['Bbbb Two', 4]]))
        expect(picked.map(p => p.coveredUsers)).toEqual([5, 9])
    })
})

describe('buildKnownParts: families', () => {
    test('several parts that share a part as their prefix become one family', () => {
        const picked = buildKnownParts(real([['HRM 1', 5], ['HRM200 2', 5], ['HRMPro 3', 5], ['HRM600 4', 5]]))
        expect(parts(picked)).toEqual(['hrm*'])
        expect(picked[0].members).toEqual(['hrm', 'hrm200', 'hrm600', 'hrmpro'])
    })

    test('parts that share a prefix of 5+ characters become a family, although the prefix is no part', () => {
        const picked = buildKnownParts(real([['BkoolSmartPro', 5], ['BkoolSmartPro2', 5], ['BkoolSmartGo', 5]]))
        expect(parts(picked)).toEqual(['bkool*'])
    })

    test('a prefix of less than 5 characters that is no part makes no family', () => {
        const picked = buildKnownParts(real([['Smarbike', 5], ['Smarfit', 5]]))
        expect(parts(picked).every(p => !p.endsWith('*'))).toBe(true)
    })

    test('the same users covered by two families: the shorter prefix, the brand, wins', () => {
        const picked = buildKnownParts(real([['BkoolSmartPro', 5], ['BkoolSmartPro2', 5], ['BkoolSmartGo', 5]]))
        expect(parts(picked)).toEqual(['bkool*'])
    })

    test('a part that covers the same users as a family stays a plain part', () => {
        const picked = buildKnownParts(real([['Stryd', 5], ['Stryd', 5]]))
        expect(parts(picked)).toEqual(['stryd'])
    })

    test('names that a family of the current list covers are not covered again', () => {
        const names = real([['HRM200 1', 5], ['HRMPro 2', 5], ['Quarq 3', 5]])
        const picked = buildKnownParts(names, { isCovered: name => /^hrm/i.test(name) })
        expect(parts(picked)).toEqual(['quarq'])
    })
})

describe('buildSuggestions', () => {
    const isCovered = name => /kickr/i.test(name)
    const data = real([['KICKR CORE 1111', 10], ['KICKR SNAP 2222', 6], ['VANRYSEL-HT-c4d1', 5], ['VANRYSEL-HT-a40e', 5], ['Rarebike', 1]])

    test('suggests what the list does not cover yet, with examples, and reports the coverage', () => {
        const result = buildSuggestions(data, { entries: ['kickr'], isCovered })
        expect(parts(result.suggestions)).toEqual(['vanrysel'])
        expect(result.suggestions[0].examples).toEqual(['VANRYSEL-HT-c4d1', 'VANRYSEL-HT-a40e'])
        expect(result.total).toBe(27)
        expect(result.coveredNow).toBe(16)
        expect(result.coveredWithSuggestions).toBe(26)
    })

    test('a family of the list covers its members, and is stale only if no device starts with it', () => {
        const names = real([['HRM200 1', 5], ['HRMPro 2', 5]])
        const covered = name => /^hrm/i.test(name)
        const result = buildSuggestions(names, { entries: ['hrm*', 'xyz*'], isCovered: covered })
        expect(result.suggestions).toEqual([])
        expect(result.stale).toEqual(['xyz*'])
    })

    test('lists the parts of the list that no device of the period contains, and changes nothing', () => {
        const entries = ['kickr', 'gone', 'assioma']
        const before = [...entries]
        const result = buildSuggestions(data, { entries, isCovered })
        expect(result.stale).toEqual(['gone', 'assioma'])
        expect(entries).toEqual(before)
    })
})

describe('buildPartTable', () => {
    const entries = ['kickr']
    const isCovered = name => /kickr/i.test(name)
    const data = real([
        ['KICKR CORE 1111', 10], ['KICKR SNAP 2222', 6], ['VANRYSEL-HT-c4d1', 5], ['VANRYSEL-HT-a40e', 5], ['Rarebike', 1],
    ])
    const table = buildPartTable(data, { entries, isCovered, suggested: ['vanrysel'] })
    const status = part => table.find(r => r.part === part)?.status

    test('shows every recurring part with its status, most used first', () => {
        expect(table[0].part).toBe('kickr')
        expect(status('kickr')).toBe('listed')
        expect(status('core')).toBe('covered')
        expect(status('vanrysel')).toBe('suggest')
        expect(status('rarebike')).toBe('other')
    })

    test('a part that a family of the list matches is listed', () => {
        const t = buildPartTable(real([['HRM200 1', 5], ['HRMPro 2', 5]]), { entries: ['hrm*'], isCovered: n => /^hrm/i.test(n) })
        expect(t.map(r => r.status)).toEqual(['listed', 'listed'])
    })

    test('counts users and distinct names', () => {
        expect(table.find(r => r.part === 'kickr')).toEqual(expect.objectContaining({ users: 16, names: 2 }))
        expect(table.find(r => r.part === 'vanrysel')).toEqual(expect.objectContaining({ users: 10, names: 2 }))
    })
})
