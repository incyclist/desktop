const data = require('./known-device-names.json')

/**
 * Parts of the advertised names of the trainers and sensors our users ride with (e.g. "kickr", "tacx",
 * "vanrysel"). A device whose name contains such a part is never banned: not by the persisted blacklist, not by the
 * name cooldown. See scripts/known-device-names/README.md for how the list is maintained.
 *
 *  - manual:    written by hand, never touched by the generator
 *  - exclude:   parts that must never be on the list (the generator drops them, too generic)
 *  - generated: written by scripts/known-device-names/update.js from the devices users really started
 */

const MIN_PREFIX_LENGTH = 5

/**
 * Splits a device name into lower case parts. Per-device suffixes (serial numbers, MAC fragments such as "4d13",
 * "c4d1", "30485") are dropped, as are parts shorter than 3 characters.
 * "VANRYSEL-HT-c4d1" -> ['vanrysel']; "Tacx Flux-2 30485" -> ['tacx', 'flux']; "H6M 58398" -> ['h6m']
 */
function nameParts(name) {
    if (!name || typeof name !== 'string') return []
    return name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map(cutSerialNumber)
        .filter(part => part.length >= 3 && !isDeviceId(part))
}

// "assiomapro09885l" -> "assiomapro", "d2ride2121" -> "d2ride": everything from a run of 4+ digits on is a serial number
function cutSerialNumber(part) {
    return part.replace(/[0-9]{4,}.*$/, '')
}

// a purely numeric part, or one that only consists of hex digits and contains a digit, is part of a serial number
function isDeviceId(part) {
    return /^[0-9]+$/.test(part) || (/^[0-9a-f]+$/.test(part) && /[0-9]/.test(part))
}

function buildEntries(list = data) {
    const exclude = new Set((list.exclude ?? []).map(e => e.toLowerCase()))
    const all = [...(list.manual ?? []), ...(list.generated ?? [])].map(e => e.toLowerCase())
    return [...new Set(all)].filter(e => !exclude.has(e))
}

const ENTRIES = buildEntries()

/**
 * A part matches if it is equal to an entry. Longer entries (5+ characters) also match the start of a part, so
 * "assioma" finds "AssiomaPRO12774R" and "bkool" finds "BkoolSmartPro2", while a short entry such as "hrm" or "di"
 * only matches whole parts.
 */
function isKnownDeviceName(name, entries = ENTRIES) {
    const parts = nameParts(name)
    if (parts.length === 0) return false
    return parts.some(part => entries.some(entry =>
        part === entry || (entry.length >= MIN_PREFIX_LENGTH && part.startsWith(entry))))
}

module.exports = { isKnownDeviceName, nameParts, buildEntries, MIN_PREFIX_LENGTH }
