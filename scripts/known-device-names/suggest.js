#!/usr/bin/env node
/**
 * Suggests parts for src/features/webble/known-device-names.json from the event log in Elasticsearch. The list is
 * maintained by hand: this script only PRINTS suggestions and never changes any file.
 *
 *   ES_URL=http://192.168.2.180:9200 node scripts/known-device-names/suggest.js [--days 90] [--max-parts 30]
 *                                                                               [--min-users 3] [--top 60]
 *
 * It reads the BLE devices that connected fine (`start result: success`: the device connected and delivered data).
 * Devices that failed or were found to be unsupported are not looked at. Only model names are read, users are only
 * counted.
 */
const path = require('node:path')
const { buildSuggestions, buildPartTable, DEFAULTS } = require('./generate')
const { isKnownDeviceName, buildEntries } = require('../../src/features/webble/known-device-names')

function parseArgs(argv) {
    const args = { top: 60, days: 90, maxParts: DEFAULTS.maxParts, minUsers: DEFAULTS.minUsers }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--days') args.days = Number(argv[++i])
        else if (a === '--max-parts') args.maxParts = Number(argv[++i])
        else if (a === '--top') args.top = Number(argv[++i])
        else if (a === '--min-users') args.minUsers = Number(argv[++i])
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

const pct = (part, total) => `${Math.round(100 * part / Math.max(1, total))}%`

async function main() {
    const args = parseArgs(process.argv.slice(2))
    const esUrl = (process.env.ES_URL ?? 'http://localhost:9200').replace(/\/$/, '')
    const real = await namesWithUsers(esUrl, args.days, 'start result: success', 'device', [{ term: { 'interface.keyword': 'ble' } }])
    const entries = buildEntries()
    const result = buildSuggestions(real, {
        entries, isCovered: name => isKnownDeviceName(name),
        maxParts: args.maxParts, minUsers: args.minUsers,
    })

    console.log(`${real.length} different device names connected fine in the last ${args.days} days`)
    console.log(`the list (${entries.length} parts) covers ${pct(result.coveredNow, result.total)} of the users; with all suggestions ${pct(result.coveredWithSuggestions, result.total)}`)

    const table = buildPartTable(real, {
        entries, isCovered: name => isKnownDeviceName(name),
        suggested: result.suggestions.map(x => x.part),
    })
    console.log(`\nThe ${args.top} parts that occur for most users (status: listed = in the list, suggest = worth adding,`)
    console.log('covered = the devices with it are covered by other parts anyway):')
    console.log('  part            users  names  status')
    for (const row of table.slice(0, args.top)) {
        console.log(`  ${row.part.padEnd(15)} ${String(row.users).padStart(5)} ${String(row.names).padStart(6)}  ${row.status}`)
    }

    console.log(`\nSuggested to add (${result.suggestions.length}), most useful first, with example names:`)
    for (const s of result.suggestions) {
        const family = s.part.endsWith('*') ? `  (${s.members.slice(0, 6).join(' ')}${s.members.length > 6 ? ' ...' : ''})` : ''
        console.log(`  ${s.part.padEnd(15)} +${String(s.users).padEnd(4)} users   ${s.examples.join(' | ')}${family}`)
    }
    console.log('  (generic words such as "bike" or "sensor" can show up here: skip them)')

    if (result.stale.length) {
        console.log(`\nIn the list, but in no device name of the last ${args.days} days (${result.stale.length}):`)
        console.log('  ' + result.stale.join(' '))
    }
    console.log('  (an entry ending with * is a family: it matches every part that starts with it)')
    console.log('\nNothing was changed. Edit src/features/webble/known-device-names.json by hand.')
}

if (require.main === module)
    main().catch(err => { console.error(err.message); process.exit(1) })

module.exports = { parseArgs }
