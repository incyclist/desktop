const os = require('os')

const PLACEHOLDER = '$HOME'
const MAX_DEPTH = 10

// a path segment of a user name: stops at separators, whitespace and quotes
const SEG = '[^\\\\/\\s\'"`:*?<>|]+'
const SEP = '(?:\\\\|/)'

// Fallback for home directories of other machines/users (e.g. in stack traces of bundled code)
const GENERIC_SOURCES = [
    `[A-Za-z]:${SEP}+Users${SEP}+${SEG}`,
    `/home/${SEG}`,
    `/Users/${SEG}`,
]

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// matches a path with either separator, and with JSON-escaped backslashes
const buildHomeSource = (home) => {
    const parts = home.split(/[\\/]+/).filter(p => p.length > 0)
    if (parts.length < 2) return undefined // never treat "/" or a bare drive as a home dir

    const lead = /^[\\/]/.test(home) ? SEP : ''
    return lead + parts.map(escapeRegExp).join(`${SEP}+`)
}

let cache

const getPatterns = () => {
    // the home directory does not change during the lifetime of the process
    if (cache) return cache

    let home
    try { home = os.homedir() } catch { /* ignore */ }

    // exact home first, so that user names containing spaces are replaced completely
    const homeSources = []
    if (home) {
        const exact = buildHomeSource(home)
        if (exact) homeSources.push(exact)

        // URL-encoded variant, as used in file:// urls
        const encoded = buildHomeSource(encodeURI(home))
        if (encoded && !homeSources.includes(encoded)) homeSources.push(encoded)
    }

    // one pass for all variants. Case-insensitive on purpose: Windows paths are, and for the
    // remaining platforms a false positive only costs readability, a miss would leak.
    const replace = new RegExp([...homeSources, ...GENERIC_SOURCES].join('|'), 'gi')

    // Cheap pre-check: the vast majority of log strings contain none of these and can skip the
    // replacement. It must never produce a false negative, so it includes the full home path.
    const quick = new RegExp(['users', 'home', ...homeSources].join('|'), 'i')

    cache = { replace, quick }
    return cache
}

const scrubString = (str) => {
    if (typeof str !== 'string' || str.length === 0) return str

    const { replace, quick } = getPatterns()
    if (!quick.test(str)) return str

    replace.lastIndex = 0
    return str.replace(replace, () => PLACEHOLDER)
}

const isPlainObject = (o) => {
    const proto = Object.getPrototypeOf(o)
    return proto === Object.prototype || proto === null
}

// copy-on-write: containers are only copied if something inside them changed
const walk = (value, depth, ctx) => {
    if (typeof value === 'string') return scrubString(value)
    if (value === null || typeof value !== 'object') return value

    const isArray = Array.isArray(value)
    if (!isArray && !isPlainObject(value)) return value // class instances (incl. Errors) as is

    if (ctx.done.has(value)) return ctx.done.get(value)
    if (ctx.active.has(value)) return '[Circular]'
    if (depth >= MAX_DEPTH) return '{...}' // fail closed, never pass on what we did not inspect

    ctx.active.add(value)
    let res = value

    if (isArray) {
        for (let i = 0; i < value.length; i++) {
            const v = value[i]
            const nv = walk(v, depth + 1, ctx)
            if (nv !== v) {
                if (res === value) res = value.slice()
                res[i] = nv
            }
        }
    }
    else {
        const keys = Object.keys(value)
        let out = null
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]
            const nk = scrubString(key)
            const v = value[key]
            const nv = walk(v, depth + 1, ctx)

            if (out === null && (nk !== key || nv !== v)) {
                out = {}
                for (let j = 0; j < i; j++) out[keys[j]] = value[keys[j]]
            }
            if (out !== null) out[nk] = nv
        }
        if (out !== null) res = out
    }

    ctx.active.delete(value)
    // unchanged containers are returned as is anyway, so only changed ones need to be remembered
    if (res !== value) ctx.done.set(value, res)
    return res
}

/**
 * Returns `value` with the user's home directory (and any /home/<x>, /Users/<x>, C:\Users\<x>
 * prefix) replaced by $HOME, in strings and in object keys. The input is never modified; it is
 * returned itself if nothing needed to be replaced.
 * Class instances (including Errors) are returned as is.
 */
const scrubValue = (value) => {
    if (typeof value === 'string') return scrubString(value)
    if (value === null || typeof value !== 'object') return value
    return walk(value, 0, { done: new Map(), active: new Set() })
}

/**
 * Makes an EventLogger adapter scrub user paths from every event before it is written/sent.
 * Patches the instance in place, so all holders of the adapter are covered.
 *
 * The raw event (3rd argument) is deliberately not forwarded: it carries unfiltered data and
 * would have to be scrubbed as well. Only use this for adapters that do not read it.
 */
const withPathScrubbing = (adapter) => {
    if (!adapter || adapter._pathScrubbing) return adapter

    const orig = adapter.log.bind(adapter)
    adapter.log = (context, event) => orig(context, scrubValue(event), undefined)
    adapter._pathScrubbing = true
    return adapter
}

const resetCache = () => { cache = undefined } // for tests

module.exports = { scrubString, scrubValue, withPathScrubbing, resetCache, PLACEHOLDER }
