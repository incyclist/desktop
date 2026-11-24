#!/usr/bin/env node
/**
 * Suggests parts for the list of known device names from the event log in Elasticsearch. The list lives in
 * incyclist-services (src/devices/known-names/known-device-names.ts, expected next to this repository, or
 * --list <file>) and is maintained by hand: this script only PRINTS suggestions and never changes any file.
 *
 *   ES_URL=http://192.168.2.180:9200 node scripts/known-device-names/suggest.js [--list <file>] [--days 90] [--max-parts 30]
 *                                                                               [--min-users 3] [--top 60]
 *
 * It reads the BLE devices that connected fine (`start result: success`: the device connected and delivered data).
 * Devices that failed or were found to be unsupported are not looked at. Only model names are read, users are only
 * counted.
 */
const fs = require('node:fs')
const path = require('node:path')
const { buildSuggestions, buildPartTable, DEFAULTS } = require('./generate')
const { isKnownDeviceName, buildEntries } = require('../../src/features/webble/known-device-names')

const DEFAULT_LIST = path.join(__dirname, '../../../services/src/devices/known-names/known-device-names.ts')

/**
 * Reads `{ version, names }` from the list of incyclist-services (a TypeScript file) or from a JSON file.
 * @throws if no list can be found in the text
 */
function parseList(text) {
    const trimmed = text.trim()
    if (trimmed.startsWith('{')) {
        const json = JSON.parse(trimmed)
        return { version: json.version, names: json.names }
    }
    const version = /version:\s*(\d+)/.exec(text)?.[1]
    const namesAt = text.indexOf('names:')
    const open = text.indexOf('[', Math.max(0, namesAt))
    const close = open < 0 ? -1 : text.indexOf(']', open)
    if (!version || !text.includes('names:') || close < 0)
        throw new Error('no list of known device names found (expected "version: <n>" and "names: [...]")')
    const block = text.slice(open + 1, close)
    return { version: Number(version), names: [...block.matchAll(/'([a-z0-9*]+)'/g)].map(m => m[1]) }
}

function parseArgs(argv) {
    const args = { list: process.env.KNOWN_NAMES_FILE ?? DEFAULT_LIST, top: 60, days: 90, maxParts: DEFAULTS.maxParts, minUsers: DEFAULTS.minUsers }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--list') args.list = argv[++i]
        else if (a === '--days') args.days = Number(argv[++i])
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

// the members of a family, to see what an entry like "bkool*" would match
function describeFamily(suggestion) {
    if (!suggestion.part.endsWith('*'))
        return ''
    const more = suggestion.members.length > 6 ? ' ...' : ''
    return `  (${suggestion.members.slice(0, 6).join(' ')}${more})`
}

// The only place that writes to the console: the report is the purpose of this tool. It contains device model names and
// counts read from the event log, no secrets (the Elasticsearch address and the path of the list are never printed).
const print = (line = '') => console.log(line) // NOSONAR

const pct = (part, total) => `${Math.round(100 * part / Math.max(1, total))}%`

async function main() {
    const args = parseArgs(process.argv.slice(2))
    const esUrl = (process.env.ES_URL ?? 'http://localhost:9200').replace(/\/$/, '')
    const real = await namesWithUsers(esUrl, args.days, 'start result: success', 'device', [{ term: { 'interface.keyword': 'ble' } }])
    const list = parseList(fs.readFileSync(args.list, 'utf8'))
    const entries = buildEntries(list.names)
    const isCovered = name => isKnownDeviceName(name, entries)
    const result = buildSuggestions(real, {
        entries, isCovered,
        maxParts: args.maxParts, minUsers: args.minUsers,
    })

    print('devices that connected fine in the look-back period:')
    print(`the list (version ${list.version}, ${entries.length} entries) covers ${pct(result.coveredNow, result.total)} of the users; with all suggestions ${pct(result.coveredWithSuggestions, result.total)}`)

    const table = buildPartTable(real, {
        entries, isCovered,
        suggested: result.suggestions.map(x => x.part),
    })
    print(`\nThe ${args.top} parts that occur for most users (status: listed = in the list, suggest = worth adding,`)
    print('covered = the devices with it are covered by other parts anyway):')
    print('  part            users  names  status')
    for (const row of table.slice(0, args.top)) {
        print(`  ${row.part.padEnd(15)} ${String(row.users).padStart(5)} ${String(row.names).padStart(6)}  ${row.status}`)
    }

    print(`\nSuggested to add (${result.suggestions.length}), most useful first, with example names:`)
    for (const s of result.suggestions) {
        print(`  ${s.part.padEnd(15)} +${String(s.users).padEnd(4)} users   ${s.examples.join(' | ')}${describeFamily(s)}`)
    }
    print('  (generic words such as "bike" or "sensor" can show up here: skip them)')

    if (result.stale.length) {
        print(`\nIn the list, but in no device name of the last ${args.days} days (${result.stale.length}):`)
        print('  ' + result.stale.join(' '))
    }
    print('  (an entry ending with * is a family: it matches every part that starts with it)')
    print('\nNothing was changed. Edit the list in incyclist-services by hand and increase its version.')
}

if (require.main === module)
    main().catch(err => { console.error(err.message); process.exit(1) })

module.exports = { parseArgs, parseList }
