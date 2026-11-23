#!/usr/bin/env node
/**
 * Regenerates the "generated" part of src/features/webble/known-device-names.json from the event log in
 * Elasticsearch: the BLE trainers and sensors users really started in the last N days, minus the parts that also
 * occur in devices the app found to be of another kind.
 *
 *   ES_URL=http://192.168.2.180:9200 node scripts/known-device-names/update.js [--days 90] [--min-users 3]
 *                                                                              [--max-noise-ratio 0.3] [--dry-run]
 *
 * Only device model names are read (no user ids leave Elasticsearch: users are only counted). The manual and exclude
 * lists of the file are kept as they are.
 */
const fs = require('node:fs')
const path = require('node:path')
const { buildKnownParts, DEFAULTS } = require('./generate')

const FILE = path.join(__dirname, '../../src/features/webble/known-device-names.json')

function parseArgs(argv) {
    const args = { days: 90, minUsers: DEFAULTS.minUsers, maxNoiseRatio: DEFAULTS.maxNoiseRatio, dryRun: false }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--days') args.days = Number(argv[++i])
        else if (a === '--min-users') args.minUsers = Number(argv[++i])
        else if (a === '--max-noise-ratio') args.maxNoiseRatio = Number(argv[++i])
        else if (a === '--dry-run') args.dryRun = true
        else throw new Error(`unknown argument '${a}'`)
    }
    return args
}

async function search(esUrl, body) {
    const res = await fetch(`${esUrl}/incyclist-*/_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Elasticsearch answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return res.json()
}

// device names with the number of different users that used them
async function namesWithUsers(esUrl, days, message, field, extraFilter = []) {
    const body = {
        size: 0,
        query: { bool: { filter: [
            { range: { ts: { gte: `now-${days}d` } } },
            { term: { 'message.keyword': message } },
            ...extraFilter,
        ] } },
        aggs: { names: { terms: { field: `${field}.keyword`, size: 10000 }, aggs: { users: { cardinality: { field: 'uuid.keyword' } } } } },
    }
    const res = await search(esUrl, body)
    return res.aggregations.names.buckets.map(b => ({ name: b.key, users: b.users.value }))
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    const esUrl = (process.env.ES_URL ?? 'http://localhost:9200').replace(/\/$/, '')
    const ble = [{ prefix: { 'interface.keyword': 'BLE' } }]

    const [bikes, sensors, unsupported] = await Promise.all([
        namesWithUsers(esUrl, args.days, 'start bike request', 'bike', ble),
        namesWithUsers(esUrl, args.days, 'start sensor request', 'sensor', ble),
        namesWithUsers(esUrl, args.days, 'device confirmed unsupported', 'deviceName'),
    ])
    const real = [...bikes, ...sensors]
    const picked = buildKnownParts(real, unsupported, { minUsers: args.minUsers, maxNoiseRatio: args.maxNoiseRatio })

    const current = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    const next = {
        manual: current.manual ?? [],
        exclude: current.exclude ?? [],
        generated: picked.map(p => p.part).filter(p => !(current.exclude ?? []).includes(p)).sort(),
        meta: {
            generatedAt: new Date().toISOString().slice(0, 10),
            days: args.days,
            minUsers: args.minUsers,
            maxNoiseRatio: args.maxNoiseRatio,
            realNames: real.length,
            unsupportedNames: unsupported.length,
        },
    }

    const before = new Set(current.generated ?? [])
    const added = next.generated.filter(p => !before.has(p))
    const removed = [...before].filter(p => !next.generated.includes(p))
    console.log(`${real.length} device names (${bikes.length} bikes, ${sensors.length} sensors), ${unsupported.length} confirmed-unsupported names`)
    console.log(`${next.generated.length} parts (${added.length} new, ${removed.length} removed)`)
    if (added.length) console.log('new:    ', added.join(' '))
    if (removed.length) console.log('removed:', removed.join(' '))

    if (args.dryRun) {
        console.log('dry run: file not written')
        return
    }
    fs.writeFileSync(FILE, JSON.stringify(next, null, 4) + '\n')
    console.log(`written ${path.relative(process.cwd(), FILE)}`)
}

if (require.main === module)
    main().catch(err => { console.error(err.message); process.exit(1) })

module.exports = { parseArgs }
