const net = require('node:net')

// Peer filter shared by the control and media listeners. It runs on the raw `connection`
// event, before any byte is read or parsed. Policy values come from the renderer; the
// default accepts private, link-local and loopback sources only.

const DEFAULT_RANGES = [
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8',
    'fc00::/7', 'fe80::/10', '::1/128'
]

const DEFAULT_FLUSH_INTERVAL_MS = 10000

const V4_BITS = 32
const V6_BITS = 128
const MAPPED_PREFIX = 0xffffn << 32n

// logger of the most recent PeerFilter, for the module-level helpers below
let moduleLogger

/** Logs a swallowed error of a module-level helper (function name and message only, never an address). Never throws. */
function logModuleError(fn, err) {
    try {
        moduleLogger?.logEvent({ message: 'local-link peer-filter error', fn, error: err?.message })
    }
    catch { /* the logger itself failed: nothing left to do */ }
}

function parseIPv4(str) {
    try {
        const parts = str.split('.')
        let value = 0n
        for (const p of parts)
            value = (value << 8n) | BigInt(Number(p))
        return value
    }
    catch (err) {
        logModuleError('parseIPv4', err)
        return undefined
    }
}

function parseIPv6(str) {
    try {
        let text = str
        let tail = []

        // embedded IPv4 in the last group (e.g. ::ffff:1.2.3.4)
        const lastColon = text.lastIndexOf(':')
        const last = text.slice(lastColon + 1)
        if (last.includes('.')) {
            const v4 = parseIPv4(last)
            if (v4 === undefined)
                return undefined
            tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)]
            text = text.slice(0, lastColon + 1) + '0:0'
        }

        const halves = text.split('::')
        const toGroups = (s) => s === '' ? [] : s.split(':').map(g => Number.parseInt(g, 16))
        const head = toGroups(halves[0])
        const rest = halves.length > 1 ? toGroups(halves[1]) : []
        const groups = halves.length > 1
            ? [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest]
            : head

        if (tail.length) {
            groups[6] = tail[0]
            groups[7] = tail[1]
        }

        let value = 0n
        for (const g of groups)
            value = (value << 16n) | BigInt(g)
        return value
    }
    catch (err) {
        logModuleError('parseIPv6', err)
        return undefined
    }
}

/**
 * Parses an IP address string to {family:4|6, value:BigInt}. Strips a zone id and maps
 * IPv4-mapped IPv6 addresses to IPv4. Returns undefined for anything that is not an IP.
 */
function normalizeAddress(address) {
    try {
        if (typeof address !== 'string' || address.length === 0)
            return undefined

        const zone = address.indexOf('%')
        const text = zone === -1 ? address : address.slice(0, zone)

        if (net.isIPv4(text)) {
            const value = parseIPv4(text)
            return value === undefined ? undefined : { family: 4, value }
        }

        if (net.isIPv6(text)) {
            const value = parseIPv6(text)
            if (value === undefined)
                return undefined
            if ((value >> 32n) === 0xffffn)
                return { family: 4, value: value & 0xffffffffn }
            return { family: 6, value }
        }
        return undefined
    }
    catch (err) {
        logModuleError('normalizeAddress', err)
        return undefined
    }
}

/** Parses a CIDR string (a bare address means a single host). Returns undefined if invalid. */
function parseCidr(cidr) {
    try {
        if (typeof cidr !== 'string')
            return undefined

        const slash = cidr.indexOf('/')
        const addrPart = slash === -1 ? cidr : cidr.slice(0, slash)
        const addr = normalizeAddress(addrPart)
        if (!addr)
            return undefined

        const mappedInput = addr.family === 4 && net.isIPv6(addrPart.split('%')[0])
        const total = addr.family === 4 ? V4_BITS : V6_BITS
        let bits = total

        if (slash !== -1) {
            const prefixText = cidr.slice(slash + 1)
            if (!/^\d{1,3}$/.test(prefixText))
                return undefined
            bits = Number(prefixText)
            if (mappedInput) {
                if (bits < 96 || bits > V6_BITS)
                    return undefined
                bits -= 96
            }
        }
        if (bits > total)
            return undefined

        const shift = BigInt(total - bits)
        return { family: addr.family, bits, total, base: (addr.value >> shift) << shift }
    }
    catch (err) {
        logModuleError('parseCidr', err)
        return undefined
    }
}

function inCidr(addr, cidr) {
    try {
        if (addr.family !== cidr.family)
            return false
        const shift = BigInt(cidr.total - cidr.bits)
        return (addr.value >> shift) << shift === cidr.base
    }
    catch (err) {
        logModuleError('inCidr', err)
        return false
    }
}

const DEFAULT_CIDRS = DEFAULT_RANGES.map(parseCidr)
const CGNAT = parseCidr('100.64.0.0/10')
const V4_OTHER = ['0.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4'].map(parseCidr)
const V6_OTHER = ['::/128', 'ff00::/8'].map(parseCidr)

/** Address class used for aggregated refusal reporting. Never contains the address. */
function classifyAddress(address) {
    try {
        const addr = normalizeAddress(address)
        if (!addr)
            return 'other'
        if (DEFAULT_CIDRS.some(c => inCidr(addr, c)))
            return 'other'
        if (addr.family === 4) {
            if (inCidr(addr, CGNAT))
                return 'cgnat'
            if (V4_OTHER.some(c => inCidr(addr, c)))
                return 'other'
            return 'public-v4'
        }
        if (V6_OTHER.some(c => inCidr(addr, c)))
            return 'other'
        return 'public-v6'
    }
    catch (err) {
        logModuleError('classifyAddress', err)
        return 'other'
    }
}

/**
 * Key for per-peer connection counting. IPv6 addresses collapse to their /64 prefix (a single
 * host can cycle through a whole /64); IPv4 and IPv4-mapped addresses use the full address.
 */
function peerKey(address) {
    try {
        const addr = normalizeAddress(address)
        if (!addr)
            return 'unknown'
        if (addr.family === 4)
            return addr.value.toString()
        return `v6:${(addr.value >> 64n).toString()}`
    }
    catch (err) {
        logModuleError('peerKey', err)
        return 'unknown'
    }
}

/** True if the address is in the default accept ranges (private, link-local, loopback). */
function isPrivateAddress(address) {
    try {
        const addr = normalizeAddress(address)
        return addr !== undefined && DEFAULT_CIDRS.some(c => inCidr(addr, c))
    }
    catch (err) {
        logModuleError('isPrivateAddress', err)
        return false
    }
}

class PeerFilter {

    /**
     * @param {{onRefused?: (listener:string, addressClass:string, count:number)=>void, flushIntervalMs?: number}} [props]
     */
    constructor(props = {}) {
        this.onRefused = props.onRefused
        this.logger = props.logger
        moduleLogger = props.logger ?? moduleLogger
        this.flushIntervalMs = props.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
        this.policy = { defaultPrivate: true, allow: [], deny: [] }
        this.counts = new Map()
        this.timer = undefined
    }

    /** Logs a swallowed error (function name and message only, never an address). */
    logError(fn, err) {
        try {
            this.logger?.logEvent({ message: 'local-link peer-filter error', fn, error: err?.message })
        }
        catch { /* the logger itself failed: nothing left to do */ }
    }

    /** Validates and applies a policy as a whole; on any invalid CIDR the previous policy stays. */
    setPolicy(policy) {
        try {
            if (!policy || typeof policy !== 'object' || typeof policy.defaultPrivate !== 'boolean')
                return { ok: false, error: 'invalid policy' }

            const parse = (list, name) => {
                if (list === undefined)
                    return { cidrs: [] }
                if (!Array.isArray(list))
                    return { error: `${name} must be an array` }
                const cidrs = []
                for (const entry of list) {
                    const c = parseCidr(entry)
                    if (!c)
                        return { error: `invalid CIDR in ${name}` }
                    cidrs.push(c)
                }
                return { cidrs }
            }

            const allow = parse(policy.allow, 'allow')
            if (allow.error)
                return { ok: false, error: allow.error }
            const deny = parse(policy.deny, 'deny')
            if (deny.error)
                return { ok: false, error: deny.error }

            this.policy = { defaultPrivate: policy.defaultPrivate, allow: allow.cidrs, deny: deny.cidrs }
            return { ok: true }
        }
        catch (err) {
            this.logError('setPolicy', err)
            return { ok: false, error: 'invalid policy' }
        }
    }

    /** Precedence: deny > allow > default. An unparsable or missing address is refused. */
    isAllowed(remoteAddress) {
        try {
            const addr = normalizeAddress(remoteAddress)
            if (!addr)
                return false

            if (this.policy.deny.some(c => inCidr(addr, c)))
                return false
            if (this.policy.allow.some(c => inCidr(addr, c)))
                return true
            if (this.policy.defaultPrivate)
                return DEFAULT_CIDRS.some(c => inCidr(addr, c))
            return false
        }
        catch (err) {
            this.logError('isAllowed', err)
            return false
        }
    }

    /**
     * To be called on the server's `connection` event. Destroys a refused socket without
     * writing anything and counts the refusal. Returns true if the peer is accepted.
     */
    guard(listener, socket) {
        try {
            const address = socket?.remoteAddress
            if (this.isAllowed(address))
                return true

            this.record(listener, classifyAddress(address))
            try { socket?.destroy() } catch { /* socket already gone */ }
            return false
        }
        catch (err) {
            this.logError('guard', err)
            try { socket?.destroy() } catch { /* socket already gone */ }
            return false
        }
    }

    record(listener, addressClass) {
        try {
            const key = `${listener}|${addressClass}`
            this.counts.set(key, (this.counts.get(key) ?? 0) + 1)

            if (!this.timer) {
                this.timer = setTimeout(() => this.flush(), this.flushIntervalMs)
                this.timer.unref?.()
            }
        }
        catch (err) {
            this.logError('record', err)
        }
    }

    /** Emits one aggregate per (listener, address class) since the last flush. */
    flush() {
        try {
            if (this.timer) {
                clearTimeout(this.timer)
                this.timer = undefined
            }
            const entries = [...this.counts.entries()]
            this.counts.clear()
            for (const [key, count] of entries) {
                const [listener, addressClass] = key.split('|')
                try {
                    this.onRefused?.(listener, addressClass, count)
                }
                catch (err) {
                    this.logError('flush.onRefused', err)
                }
            }
        }
        catch (err) {
            this.logError('flush', err)
        }
    }

    dispose() {
        try {
            this.flush()
        }
        catch (err) {
            this.logError('dispose', err)
        }
    }
}

module.exports = { PeerFilter, isPrivateAddress, normalizeAddress, peerKey, parseCidr, classifyAddress, DEFAULT_RANGES }
