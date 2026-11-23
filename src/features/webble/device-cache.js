const fs = require('node:fs')
const path = require('node:path')
const { getAppDirectory } = require('../../utils')
const { EventLogger } = require('gd-eventlog')

const FILE_NAME = 'webble-devices.json'

// probe failures (for a device never explicitly connected to) before it's written off as "bad"
const BAD_THRESHOLD = 3

// Reputation is not forever: a device that failed because it was busy (e.g. connected to a phone), switched
// off or mid-update must get another chance. Entries without a timestamp (written by older versions) are
// treated as expired. "Good" entries never expire.
const HOUR = 60 * 60 * 1000
const FAILURE_TTL = 7* 24 * HOUR              // blacklisted after failed connects, and the failure counts
const UNSUPPORTED_TTL = 7 * 24 * HOUR      // connected fine, but it is the wrong kind of device

// Devices that advertise under rotating random addresses create a new entry for every address, none of which
// ever reaches BAD_THRESHOLD. The name is the stable key: once this many different addresses with the same
// name failed (and none with that name works), the name itself is written off.
const NAME_BAD_MIN_MACS = 3

// keeps the file small, whatever is around the user
const MAX_ENTRIES_PER_NAME = 10
const MAX_ENTRIES = 500

/**
 * Persists BLE device reputation (by MAC) across app launches, so a device the
 * user already uses (e.g. their trainer) is preferred from the very first scan of
 * a new session, and a device that never connects (e.g. a nearby speaker) stops
 * being offered at all — instead of both re-learning this from scratch, in-memory
 * only, every single launch.
 *
 * Session-local "this device just failed, try it again later" tracking stays in
 * feature.js's probeCooldowns — that's inherently transient and doesn't need to
 * survive a restart.
 */
class WebBleDeviceCache {
    static _instance

    static getInstance() {
        if (!WebBleDeviceCache._instance)
            WebBleDeviceCache._instance = new WebBleDeviceCache()
        return WebBleDeviceCache._instance
    }

    constructor() {
        this.logger = new EventLogger('WebBLE')
        this.entries = {}   // mac → { name, status: 'good'|'bad', failCount, ts, reason: 'unsupported'|'failures' }
        this._load()
    }

    _filePath() {
        return path.join(getAppDirectory(), FILE_NAME)
    }

    _load() {
        try {
            const file = this._filePath()
            if (fs.existsSync(file))
                this.entries = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (err) {
            this.logger.logEvent({ message: 'could not load webble device cache', error: err.message })
            this.entries = {}
        }
        if (this._prune())
            this._save()
    }

    _isExpired(entry) {
        if (entry.status === 'good') return false
        if (!entry.ts) return true
        const ttl = entry.status === 'bad' && entry.reason === 'unsupported' ? UNSUPPORTED_TTL : FAILURE_TTL
        return Date.now() - entry.ts > ttl
    }

    /** Drops expired entries and keeps the file bounded. @returns true if anything was removed */
    _prune() {
        const before = Object.keys(this.entries).length

        for (const [mac, entry] of Object.entries(this.entries)) {
            if (this._isExpired(entry)) delete this.entries[mac]
        }

        const byName = new Map()
        for (const [mac, entry] of Object.entries(this.entries)) {
            if (entry.status === 'good') continue
            const list = byName.get(entry.name) ?? []
            list.push(mac)
            byName.set(entry.name, list)
        }
        const newestFirst = (a, b) => (this.entries[b].ts ?? 0) - (this.entries[a].ts ?? 0)
        for (const macs of byName.values()) {
            macs.sort(newestFirst).slice(MAX_ENTRIES_PER_NAME).forEach(mac => delete this.entries[mac])
        }

        const excess = Object.keys(this.entries).length - MAX_ENTRIES
        if (excess > 0) {
            // oldest failure records go first, devices we use are never dropped
            const oldestFirst = Object.keys(this.entries).filter(mac => this.entries[mac].status !== 'good').sort(newestFirst).reverse()
            oldestFirst.slice(0, excess).forEach(mac => delete this.entries[mac])
        }

        return Object.keys(this.entries).length !== before
    }

    _save() {
        try {
            fs.writeFileSync(this._filePath(), JSON.stringify(this.entries, null, 2), { encoding: 'utf8' })
        } catch (err) {
            this.logger.logEvent({ message: 'could not save webble device cache', error: err.message })
        }
    }

    isGood(mac) {
        return this.entries[mac]?.status === 'good'
    }

    isBad(mac) {
        const entry = this.entries[mac]
        return entry?.status === 'bad' && !this._isExpired(entry)
    }

    /**
     * True if several different addresses with this name failed and none with that name ever worked: the
     * signature of a device that advertises under rotating addresses (speakers, earbuds, TVs).
     */
    isNameBad(name) {
        if (!name) return false
        let failed = 0
        for (const entry of Object.values(this.entries)) {
            if (entry.name !== name) continue
            if (entry.status === 'good') return false
            if (!this._isExpired(entry) && (entry.status === 'bad' || entry.failCount > 0)) failed++
        }
        return failed >= NAME_BAD_MIN_MACS
    }

    /**
     * Immediate blacklist — used when we have a definitive signal (a device whose
     * full GATT service list shares nothing with our fitness services), not just a
     * connection hiccup. The connection succeeded; we know for certain it's the
     * wrong kind of device, so there's no reason to wait for repeated misses like
     * recordFailure() does. Still never downgrades an explicitly-wanted device.
     */
    markBad(mac, name) {
        if (!mac || this.isGood(mac)) return
        this.entries[mac] = { name, status: 'bad', failCount: this.entries[mac]?.failCount ?? BAD_THRESHOLD, ts: Date.now(), reason: 'unsupported' }
        this.logger.logEvent({ message: 'webble device cache: marked bad (unsupported device type)', deviceId: mac, name })
        this._prune()
        this._save()
    }

    /**
     * Every MAC ever explicitly connected to — persisted so it's preferred by the
     * chooser from the very first scan of a later launch. Deliberately doesn't
     * remember service lists: some devices (e.g. a rower whose FTMS service only
     * appears once its GATT server has fully initialised) advertise a different,
     * incomplete service set depending on exactly when they're probed — reusing a
     * stale snapshot across launches could permanently hide a capability the
     * device actually has. Every discovery still gets a live probe; only the
     * ordering (who gets tried first) is influenced by this cache.
     */
    markGood(mac, name) {
        if (!mac || this.isGood(mac)) return
        this.entries[mac] = { name, status: 'good', failCount: 0, ts: Date.now() }
        this.logger.logEvent({ message: 'webble device cache: marked good', deviceId: mac, name })
        this._save()
    }

    /**
     * Records a probe failure. A device we've ever explicitly wanted (already
     * "good") is never downgraded, however flaky it is right now — that's what
     * the session-local cooldown/parking is for instead.
     */
    recordFailure(mac, name) {
        if (!mac || this.isGood(mac)) return

        const known = this.entries[mac]
        const entry = known && !this._isExpired(known) ? known : { name, status: undefined, failCount: 0 }
        entry.name = name ?? entry.name
        entry.failCount = (entry.failCount ?? 0) + 1
        entry.ts = Date.now()
        if (entry.failCount >= BAD_THRESHOLD) {
            entry.status = 'bad'
            entry.reason = entry.reason ?? 'failures'
        }
        this.entries[mac] = entry

        if (entry.status === 'bad')
            this.logger.logEvent({ message: 'webble device cache: marked bad', deviceId: mac, name: entry.name, failCount: entry.failCount })
        this._prune()
        this._save()
    }
}

module.exports = WebBleDeviceCache
