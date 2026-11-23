const fs = require('node:fs')
const path = require('node:path')
const { getAppDirectory } = require('../../utils')
const { EventLogger } = require('gd-eventlog')
const { isKnownDeviceName } = require('./known-device-names')

const FILE_NAME = 'webble-devices.json'

// probe failures (for a device never explicitly connected to) before it's written off as "bad"
const BAD_THRESHOLD = 3

// A blacklisting is permanent: noise (speakers, TVs, smart home devices) is around all the time and would otherwise
// be probed again and again, which costs scan time and disturbs the connections that are in use. Real trainers and
// sensors are protected from the one thing that is not definitive: a device that merely did not respond (busy, out of
// reach, not yet ready) is never put on the failed list when its name contains a part of known-device-names.json,
// and an older blacklisting caused by failed connects is ignored. A device that connects and reports that it is not
// a fitness device ("unsupported") is blacklisted, whatever its name. A trainer of a brand that is not on the list
// yet can be released by deleting its entry (or the file) and by extending the list.

// Devices that advertise under rotating random addresses create a new entry for every address, none of which
// ever reaches BAD_THRESHOLD. The name is the stable key: once this many different addresses with the same
// name failed (and none with that name works), the name itself is written off.
const NAME_BAD_MIN_MACS = 3

// keeps the file small, whatever is around the user
const MAX_ENTRIES_PER_NAME = 10
const MAX_ENTRIES = 2000

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

    /**
     * Keeps the file bounded (not a time limit: a blacklisting is permanent): at most MAX_ENTRIES_PER_NAME failure
     * records per name and MAX_ENTRIES in total, oldest first. Devices we use are never dropped.
     * @returns true if anything was removed
     */
    _prune() {
        const before = Object.keys(this.entries).length

        const byName = new Map()
        for (const [mac, entry] of Object.entries(this.entries)) {
            if (entry.status === 'good') continue
            const list = byName.get(entry.name) ?? []
            list.push(mac)
            byName.set(entry.name, list)
        }
        // entries from older versions have no timestamp: they count as the oldest
        const newestFirst = (a, b) => (this.entries[b].ts ?? 0) - (this.entries[a].ts ?? 0)
        for (const macs of byName.values()) {
            macs.sort(newestFirst).slice(MAX_ENTRIES_PER_NAME).forEach(mac => delete this.entries[mac])
        }

        const excess = Object.keys(this.entries).length - MAX_ENTRIES
        if (excess > 0) {
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
        if (entry?.status !== 'bad') return false
        // a known trainer or sensor is only blacklisted if it said it is not a fitness device. Older entries do not
        // tell why they were made: they count as "did not respond", and a device that really is unsupported is
        // blacklisted again by its next probe
        return !isKnownDeviceName(entry.name) || entry.reason === 'unsupported'
    }

    /**
     * True if several different addresses with this name failed and none with that name ever worked: the
     * signature of a device that advertises under rotating addresses (speakers, earbuds, TVs). Never true for the
     * name of a known trainer or sensor: one unresponsive or unsupported KICKR must not hide the others.
     */
    isNameBad(name) {
        if (!name || isKnownDeviceName(name)) return false
        let failed = 0
        for (const entry of Object.values(this.entries)) {
            if (entry.name !== name) continue
            if (entry.status === 'good') return false
            if (entry.status === 'bad' || entry.failCount > 0) failed++
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
        if (!mac || this.isGood(mac) || isKnownDeviceName(name)) return

        const entry = this.entries[mac] ?? { name, status: undefined, failCount: 0 }
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
