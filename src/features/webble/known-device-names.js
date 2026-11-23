const { version, names } = require('./known-device-names.json')

/**
 * Parts of the advertised names of the trainers and sensors our users ride with (e.g. "kickr", "tacx",
 * "vanrysel"). A device whose name contains such a part is never put on the failed list just because it did not
 * respond (not by the persisted blacklist, not by the name cooldown). It is still blacklisted when it connects and
 * reports that it is not a fitness device.
 *
 * The list (known-device-names.json) is maintained by hand: `names` is the list, `version` is increased with every
 * change. The block list (device-cache.js) stores the version it was last cleaned against: if it differs, the
 * entries of the block list that the list matches are removed once. scripts/known-device-names/suggest.js proposes
 * additions from the event log, it never changes the file. See scripts/known-device-names/README.md.
 */

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

function buildEntries(list = names) {
    return [...new Set(list.map(e => e.toLowerCase()))]
}

const ENTRIES = buildEntries()

/**
 * An entry matches a part if it is equal to it. An entry that ends with `*` stands for a whole family and matches
 * every part that starts with it: "hrm*" matches "hrm", "hrm200" and "hrmpro", "assioma*" matches "assiomapro". The
 * prefix in front of the `*` needs at least 3 characters (see the tests of the shipped list).
 */
function matchesPart(entry, part) {
    return entry.endsWith('*') ? part.startsWith(entry.slice(0, -1)) : part === entry
}

function isKnownDeviceName(name, entries = ENTRIES) {
    const parts = nameParts(name)
    if (parts.length === 0) return false
    return parts.some(part => entries.some(entry => matchesPart(entry, part)))
}

module.exports = { isKnownDeviceName, matchesPart, nameParts, buildEntries, KNOWN_NAMES_VERSION: version }
