const { Bonjour } = require('bonjour-service')
const { execFile } = require('node:child_process')

const TYPE = 'incyclist'
const PROTOCOL = 'tcp'

/** Services of type _incyclist._tcp seen within `timeout` ms by a fresh Bonjour instance. */
async function browse({ timeout = 3000, until } = {}) {
    const bonjour = new Bonjour()
    const found = new Map()
    try {
        await new Promise(resolve => {
            const browser = bonjour.find({ type: TYPE, protocol: PROTOCOL })
            const timer = setTimeout(resolve, timeout)
            browser.on('up', service => {
                found.set(service.fqdn ?? service.name, describe(service))
                if (until?.([...found.values()])) {
                    clearTimeout(timer)
                    resolve()
                }
            })
        })
    }
    finally {
        bonjour.destroy()
    }
    return [...found.values()]
}

function describe(s) {
    const addresses = (s.addresses ?? []).filter(a => !a.includes(':'))
    return { name: s.name, host: s.host, port: s.port, addresses, type: s.type, protocol: s.protocol, txt: s.txt }
}

/** Long-lived browser reporting up/down events, for observing re-announcements. */
function watch() {
    const bonjour = new Bonjour()
    const events = []
    const browser = bonjour.find({ type: TYPE, protocol: PROTOCOL })
    browser.on('up', s => events.push({ kind: 'up', at: Date.now(), ...describe(s) }))
    browser.on('down', s => events.push({ kind: 'down', at: Date.now(), ...describe(s) }))
    return { events, stop: () => bonjour.destroy() }
}

/** avahi-browse -p escapes bytes as \\DDD (decimal) */
const unescapeAvahi = (text) => text.replace(/\\(\d{3})/g, (_m, d) => String.fromCharCode(Number(d)))

/** Third-party view of the announcement: avahi-browse, when installed. Resolves undefined if not available. */
function avahiBrowse(timeout = 6000) {
    return new Promise(resolve => {
        execFile('avahi-browse', ['-rtp', `_${TYPE}._${PROTOCOL}`], { timeout }, (err, stdout) => {
            if (err && !stdout)
                return resolve(undefined)
            const rows = stdout.split('\n').filter(l => l.startsWith('=')).map(l => l.split(';'))
            resolve(rows.map(r => ({ iface: r[1], proto: r[2], name: unescapeAvahi(r[3]), host: r[6], address: r[7], port: Number(r[8]) })))
        })
    })
}

module.exports = { browse, watch, avahiBrowse, TYPE, PROTOCOL }
