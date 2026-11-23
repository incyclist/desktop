const { nameParts } = require('../../src/features/webble/known-device-names')

const DEFAULTS = {
    minUsers: 3,          // a part must cover at least this many users that no earlier part covers
    maxNoiseRatio: 0.3,   // confirmed-unsupported names containing the part / real names containing it
}

/**
 * Picks the name parts that identify the trainers and sensors users really ride with.
 *
 * @param {{name:string, users:number}[]} real         devices users started (name, number of users)
 * @param {{name:string, users:number}[]} unsupported  devices the app connected to and found to be of another kind
 * @param {object} [options]
 * @returns {{part:string, users:number, names:number, noiseNames:number}[]}  in the order they were picked
 *
 * Greedy cover: the part that covers the most still uncovered users goes first (e.g. "kickr"), so parts that only
 * occur next to an already picked one ("core" in "KICKR CORE") never get on the list. A part is only eligible if
 * it is rare among confirmed-unsupported devices: generic words ("pro", "galaxy", "watch") also occur in earbuds,
 * watches and TVs.
 */
function buildKnownParts(real, unsupported, options = {}) {
    const { minUsers, maxNoiseRatio } = { ...DEFAULTS, ...options }

    const realNames = real.map(r => ({ parts: new Set(nameParts(r.name)), users: r.users ?? 1 }))

    const nameCount = new Map()
    for (const r of realNames) for (const p of r.parts) nameCount.set(p, (nameCount.get(p) ?? 0) + 1)

    const noiseCount = new Map()
    const seenNoise = new Set()
    for (const u of unsupported) {
        if (seenNoise.has(u.name)) continue
        seenNoise.add(u.name)
        for (const p of new Set(nameParts(u.name))) noiseCount.set(p, (noiseCount.get(p) ?? 0) + 1)
    }

    const eligible = new Set()
    for (const [part, names] of nameCount) {
        if ((noiseCount.get(part) ?? 0) / names <= maxNoiseRatio) eligible.add(part)
    }

    const noiseRatio = part => (noiseCount.get(part) ?? 0) / nameCount.get(part)

    // more users first. On a tie the part that is rarer among confirmed-unsupported devices, then the more specific
    // (longer) one - the brand ("tacx") rather than a model word that occurs everywhere ("neo") - then alphabetical,
    // so that the result is stable
    const isBetter = (a, b) => {
        if (a.users !== b.users) return a.users > b.users
        if (noiseRatio(a.part) !== noiseRatio(b.part)) return noiseRatio(a.part) < noiseRatio(b.part)
        if (a.part.length !== b.part.length) return a.part.length > b.part.length
        return a.part < b.part
    }

    const uncovered = new Set(realNames.keys())
    const picked = []

    for (;;) {
        const gain = new Map()
        for (const i of uncovered) {
            for (const p of realNames[i].parts) {
                if (eligible.has(p)) gain.set(p, (gain.get(p) ?? 0) + realNames[i].users)
            }
        }

        let best
        for (const [part, users] of gain) {
            if (!best || isBetter({ part, users }, best)) best = { part, users }
        }
        if (!best || best.users < minUsers) break

        picked.push({ part: best.part, users: best.users, names: nameCount.get(best.part), noiseNames: noiseCount.get(best.part) ?? 0 })
        for (const i of [...uncovered]) if (realNames[i].parts.has(best.part)) uncovered.delete(i)
    }

    return picked
}

module.exports = { buildKnownParts, DEFAULTS }
