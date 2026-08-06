const fs = require('node:fs')
const path = require('node:path')
const { getAppDirectory } = require('../../utils')
const { EventLogger } = require('gd-eventlog')

const FILE_NAME = 'webble-devices.json'

// consecutive probe failures (for a device never explicitly connected to) before
// it's written off as "bad" and excluded from the chooser for good
const BAD_THRESHOLD = 3

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
        this.entries = {}   // mac → { name, status: 'good'|'bad', failCount }
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
        return this.entries[mac]?.status === 'bad'
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
        this.entries[mac] = { name, status: 'bad', failCount: this.entries[mac]?.failCount ?? BAD_THRESHOLD }
        this.logger.logEvent({ message: 'webble device cache: marked bad (unsupported device type)', deviceId: mac, name })
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
        this.entries[mac] = { name, status: 'good', failCount: 0 }
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

        const entry = this.entries[mac] ?? { name, status: undefined, failCount: 0 }
        entry.name = name ?? entry.name
        entry.failCount = (entry.failCount ?? 0) + 1
        if (entry.failCount >= BAD_THRESHOLD) entry.status = 'bad'
        this.entries[mac] = entry

        if (entry.status === 'bad')
            this.logger.logEvent({ message: 'webble device cache: marked bad', deviceId: mac, name: entry.name, failCount: entry.failCount })
        this._save()
    }
}

module.exports = WebBleDeviceCache
