const readline = require('node:readline')

const ICON = { PASS: 'PASS  ', FAIL: 'FAIL  ', MANUAL: 'MANUAL', SKIP: 'SKIP  ' }

class AssertionError extends Error {}

const fmt = (v) => typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? String(x) : x)

const assert = {
    ok(cond, msg = 'expected truthy') { if (!cond) throw new AssertionError(msg) },
    eq(actual, expected, msg = '') {
        if (actual !== expected)
            throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(expected)}, got ${fmt(actual)}`)
    },
    deepEq(actual, expected, msg = '') {
        if (fmt(actual) !== fmt(expected))
            throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(expected)}, got ${fmt(actual)}`)
    },
    match(text, re, msg = '') {
        if (!re.test(String(text)))
            throw new AssertionError(`${msg ? msg + ': ' : ''}${fmt(text)} does not match ${re}`)
    },
    bytesEq(a, b, msg = '') {
        if (!Buffer.from(a).equals(Buffer.from(b)))
            throw new AssertionError(`${msg ? msg + ': ' : ''}byte content differs (${a.length} vs ${b.length} bytes)`)
    },
}

/** Returned from a check body to report something other than pass/fail. */
const manual = (reason) => ({ status: 'MANUAL', reason })
const skip = (reason) => ({ status: 'SKIP', reason })

class Reporter {
    constructor({ json } = {}) {
        this.results = []
        this.current = undefined
        this.json = json
    }

    group(id, title) {
        this.current = { id, title }
        console.log(`\n=== ${id} ${title}`)
    }

    record(id, desc, status, detail) {
        this.results.push({ group: this.current?.id, id, desc, status, detail })
        const line = `${ICON[status]} ${this.current?.id}.${id} ${desc}`
        console.log(detail && status !== 'PASS' ? `${line}\n         ${detail}` : line)
    }

    summary() {
        const groups = new Map()
        for (const r of this.results) {
            const g = groups.get(r.group) ?? { PASS: 0, FAIL: 0, MANUAL: 0, SKIP: 0 }
            g[r.status]++
            groups.set(r.group, g)
        }
        console.log('\n--- summary')
        console.log('group      pass  fail  manual  skip')
        for (const [id, g] of groups)
            console.log(`${id.padEnd(10)} ${String(g.PASS).padStart(4)}  ${String(g.FAIL).padStart(4)}  ${String(g.MANUAL).padStart(6)}  ${String(g.SKIP).padStart(4)}`)
        return this.results.filter(r => r.status === 'FAIL').length
    }
}

/**
 * Asks the human to do something and waits for Enter.
 * `confirm` resolves true when the step was done, false when skipped or when stdin is not interactive.
 */
function createPrompter({ interactive }) {
    const question = (text) => new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        rl.question(text, answer => { rl.close(); resolve(answer.trim()) })
    })
    return {
        interactive,
        async confirm(text) {
            console.log(`\n  >>> MANUAL STEP: ${text}`)
            if (!interactive)
                return false
            const answer = await question('  >>> press Enter when done (or type "skip"): ')
            return !/^skip$/i.test(answer)
        },
        async ask(text) {
            return interactive ? await question(`  >>> ${text}: `) : undefined
        },
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, { timeout = 5000, interval = 50, what = 'condition' } = {}) {
    const end = Date.now() + timeout
    for (;;) {
        const v = await fn()
        if (v)
            return v
        if (Date.now() > end)
            throw new AssertionError(`timeout waiting for ${what}`)
        await sleep(interval)
    }
}

module.exports = { assert, AssertionError, Reporter, createPrompter, manual, skip, sleep, waitFor }
