const { nameParts } = require('../../src/features/webble/known-device-names')

const DEFAULTS = {
    maxParts: 30,         // how many parts are suggested at most (the list is reviewed by hand, it stays short)
    minUsers: 3,          // a part must cover at least this many users that no earlier part covers
}

/**
 * Picks the name parts that identify the trainers and sensors users ride with.
 *
 * @param {{name:string, users:number}[]} real  devices that connected fine (name, number of users)
 * @param {object} [options]  `isCovered(name)`: names that the current list covers already are not covered again
 * @returns {{part:string, users:number, names:number, coveredUsers:number}[]}  in the order they were picked.
 *          `coveredUsers` is the number of users covered by this part and all parts before it
 *
 * Greedy cover: the part that covers the most still uncovered users goes first (e.g. "kickr"), so parts that only
 * occur next to an already picked one ("core" in "KICKR CORE") never get on the list.
 */
function buildKnownParts(real, options = {}) {
    const { maxParts, minUsers } = { ...DEFAULTS, ...options }

    const realNames = real.map(r => ({ parts: new Set(nameParts(r.name)), users: r.users ?? 1 }))

    const nameCount = new Map()
    for (const r of realNames) for (const p of r.parts) nameCount.set(p, (nameCount.get(p) ?? 0) + 1)

    // more users first. On a tie the more specific (longer) part - the brand ("tacx") rather than a model word that
    // occurs everywhere ("neo") - then alphabetical, so that the result is stable
    const isBetter = (a, b) => {
        if (a.users !== b.users) return a.users > b.users
        if (a.part.length !== b.part.length) return a.part.length > b.part.length
        return a.part < b.part
    }

    const uncovered = new Set(realNames.keys())
    if (options.isCovered) {
        for (const i of [...uncovered]) if (options.isCovered(real[i].name)) uncovered.delete(i)
    }
    const picked = []
    let coveredUsers = 0

    while (picked.length < maxParts) {
        const gain = new Map()
        for (const i of uncovered) {
            for (const p of realNames[i].parts) gain.set(p, (gain.get(p) ?? 0) + realNames[i].users)
        }

        let best
        for (const [part, users] of gain) {
            if (!best || isBetter({ part, users }, best)) best = { part, users }
        }
        if (!best || best.users < minUsers) break

        coveredUsers += best.users
        picked.push({ part: best.part, users: best.users, names: nameCount.get(best.part), coveredUsers })
        for (const i of [...uncovered]) if (realNames[i].parts.has(best.part)) uncovered.delete(i)
    }

    return picked
}

/**
 * What to suggest for a list that is maintained by hand.
 * @param {{name:string, users:number}[]} real
 * @param {object} options  `entries`: the current list (lower case parts), `isCovered(name)`: whether the current list
 *                          covers a name, plus the options of buildKnownParts
 * @returns {{suggestions, stale, total, coveredNow, coveredWithSuggestions}}
 *   suggestions: parts to consider, most useful first, with example names. stale: parts of the list that no device
 *   of the period contains. coveredNow / coveredWithSuggestions: users covered without / with the suggestions.
 */
function buildSuggestions(real, options) {
    const { entries, isCovered, ...rest } = options
    const total = totalUsers(real)
    const coveredNow = real.filter(r => isCovered(r.name)).reduce((sum, r) => sum + (r.users ?? 1), 0)

    const picked = buildKnownParts(real, { ...rest, isCovered })
    const suggestions = picked.map(p => ({
        ...p,
        examples: real.filter(r => !isCovered(r.name) && nameParts(r.name).includes(p.part))
            .sort((a, b) => b.users - a.users).slice(0, 3).map(r => r.name),
    }))

    const stale = entries.filter(entry => !real.some(r => nameParts(r.name).some(part => part === entry || (entry.length >= 5 && part.startsWith(entry)))))

    return {
        suggestions,
        stale,
        total,
        coveredNow,
        coveredWithSuggestions: coveredNow + (picked.length ? picked[picked.length - 1].coveredUsers : 0),
    }
}

/**
 * The recurring parts of the names of devices that connected fine, most used first, with what to do about each:
 *  - listed:  in the list already
 *  - suggest: not in the list, worth adding (see buildSuggestions)
 *  - covered: not in the list, but the devices that have it are covered by other parts anyway ("core" in "KICKR CORE")
 *  - other:   none of the above (few users)
 * @returns {{part:string, users:number, names:number, status:string}[]}
 */
function buildPartTable(real, { entries, isCovered, suggested = [] }) {
    const stats = new Map()
    for (const r of real) {
        for (const part of new Set(nameParts(r.name))) {
            const st = stats.get(part) ?? { part, users: 0, names: 0, coveredUsers: 0 }
            st.users += r.users ?? 1
            st.names += 1
            if (isCovered(r.name)) st.coveredUsers += r.users ?? 1
            stats.set(part, st)
        }
    }

    const isListed = part => entries.some(e => part === e || (e.length >= 5 && part.startsWith(e)))
    const suggestedSet = new Set(suggested)

    return [...stats.values()]
        .map(st => {
            let status = 'other'
            if (isListed(st.part)) status = 'listed'
            else if (suggestedSet.has(st.part)) status = 'suggest'
            else if (st.coveredUsers / st.users >= 0.8) status = 'covered'
            return { part: st.part, users: st.users, names: st.names, status }
        })
        .sort((a, b) => b.users - a.users || a.part.localeCompare(b.part))
}

/** Sum of the users of all names, i.e. what the `coveredUsers` of the picked parts is compared with. */
function totalUsers(real) {
    return real.reduce((sum, r) => sum + (r.users ?? 1), 0)
}

module.exports = { buildKnownParts, buildSuggestions, buildPartTable, totalUsers, DEFAULTS }
