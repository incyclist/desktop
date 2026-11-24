const { nameParts, matchesPart } = require('../../src/features/webble/known-device-names')

const DEFAULTS = {
    maxParts: 30,         // how many parts are suggested at most (the list is reviewed by hand, it stays short)
    minUsers: 3,          // a part must cover at least this many users that no earlier part covers
}

const MIN_FAMILY_PREFIX = 3        // shortest prefix of a family
const MIN_FAMILY_WORD = 5          // a prefix that is no part itself ("bkool") must be at least this long

/**
 * The candidates for the list: every part, and every family `prefix*` that several different parts share. A family
 * is only formed if its prefix is a part itself ("hrm" -> hrm, hrm200, hrmpro) or at least 4 characters long
 * ("bkool" -> bkoolsmartpro, bkoolsmartgo), so that nothing like "sma*" comes up.
 * @returns {Map<string, Set<string>>}  entry -> the distinct parts it matches
 */
function buildCandidates(allParts) {
    const candidates = new Map()
    for (const part of allParts) candidates.set(part, new Set([part]))

    const families = new Map()
    for (const part of allParts) {
        for (let len = MIN_FAMILY_PREFIX; len < part.length; len++) {
            const prefix = part.slice(0, len)
            const members = families.get(prefix) ?? new Set()
            members.add(part)
            families.set(prefix, members)
        }
    }
    for (const [prefix, members] of families) {
        const isPart = allParts.has(prefix)
        if (isPart) members.add(prefix)
        if (members.size >= 2 && (isPart || prefix.length >= MIN_FAMILY_WORD)) candidates.set(`${prefix}*`, members)
    }
    return candidates
}

// entry -> indices of the names it matches
function buildMatching(candidates, realNames) {
    const matching = new Map()
    for (const entry of candidates.keys()) matching.set(entry, [])
    realNames.forEach((r, i) => {
        for (const entry of candidates.keys()) {
            if ([...r.parts].some(p => matchesPart(entry, p))) matching.get(entry).push(i)
        }
    })
    return matching
}

// more users first. On a tie: an exact part before a family; among exact parts the longer one (the brand, not a model
// word that occurs everywhere); among families the shorter prefix ("bkool*" rather than "bkoolsmart*": the same users,
// but the brand); then alphabetical, so that the result is stable
function isBetter(a, b) {
    if (a.users !== b.users) return a.users > b.users
    const aFamily = a.entry.endsWith('*')
    const bFamily = b.entry.endsWith('*')
    if (aFamily !== bFamily) return !aFamily
    if (a.entry.length !== b.entry.length) return aFamily ? a.entry.length < b.entry.length : a.entry.length > b.entry.length
    return a.entry < b.entry
}

// the entry that covers the most users that are not covered yet
function findBest(matching, realNames, uncovered) {
    let best
    for (const [entry, indices] of matching) {
        let users = 0
        for (const i of indices) if (uncovered.has(i)) users += realNames[i].users
        if (users > 0 && (!best || isBetter({ entry, users }, best))) best = { entry, users }
    }
    return best
}

// the indices of the names that nothing covers yet: all, except those that the current list covers already
function findUncovered(real, isCovered) {
    const uncovered = new Set(real.keys())
    if (isCovered) {
        for (const i of uncovered) if (isCovered(real[i].name)) uncovered.delete(i)
    }
    return uncovered
}

/**
 * Picks the name parts that identify the trainers and sensors users ride with.
 *
 * @param {{name:string, users:number}[]} real  devices that connected fine (name, number of users)
 * @param {object} [options]  `isCovered(name)`: names that the current list covers already are not covered again
 * @returns {{part:string, users:number, names:number, coveredUsers:number, members:string[]}[]}  in the order they
 *          were picked. `part` is an entry of the list: a part ("kickr") or a family ("hrm*"). `members` are the
 *          distinct parts it matches. `coveredUsers` is the number of users covered by this entry and all before it
 *
 * Greedy cover: the entry that covers the most still uncovered users goes first (e.g. "kickr"), so parts that only
 * occur next to an already picked one ("core" in "KICKR CORE") never get on the list.
 */
function buildKnownParts(real, options = {}) {
    const { maxParts, minUsers } = { ...DEFAULTS, ...options }

    const realNames = real.map(r => ({ parts: new Set(nameParts(r.name)), users: r.users ?? 1 }))
    const allParts = new Set(realNames.flatMap(r => [...r.parts]))
    const candidates = buildCandidates(allParts)
    const matching = buildMatching(candidates, realNames)
    const uncovered = findUncovered(real, options.isCovered)

    const picked = []
    let coveredUsers = 0

    while (picked.length < maxParts) {
        const best = findBest(matching, realNames, uncovered)
        if (!best || best.users < minUsers) break

        coveredUsers += best.users
        picked.push({
            part: best.entry, users: best.users, names: matching.get(best.entry).length, coveredUsers,
            members: [...candidates.get(best.entry)].sort((a, b) => a.localeCompare(b)),
        })
        for (const i of matching.get(best.entry)) uncovered.delete(i)
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
        examples: real.filter(r => !isCovered(r.name) && nameParts(r.name).some(part => matchesPart(p.part, part)))
            .sort((a, b) => b.users - a.users).slice(0, 3).map(r => r.name),
    }))

    const stale = entries.filter(entry => !real.some(r => nameParts(r.name).some(part => matchesPart(entry, part))))

    return {
        suggestions,
        stale,
        total,
        coveredNow,
        coveredWithSuggestions: coveredNow + (picked.at(-1)?.coveredUsers ?? 0),
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

    const isListed = part => entries.some(e => matchesPart(e, part))
    // a part is suggested if it is one of the suggested parts or belongs to a suggested family
    const isSuggested = part => suggested.some(e => matchesPart(e, part))

    return [...stats.values()]
        .map(st => {
            let status = 'other'
            if (isListed(st.part)) status = 'listed'
            else if (isSuggested(st.part)) status = 'suggest'
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
