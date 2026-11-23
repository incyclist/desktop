/**
 * Parts of the advertised names of the trainers and sensors our users ride with (e.g. "kickr", "tacx",
 * "vanrysel"). A device whose name contains such a part is never put on the failed list just because it did not
 * respond (not by the persisted blacklist, not by the name cooldown). It is still blacklisted when it connects and
 * reports that it is not a fitness device.
 *
 * The list is owned by incyclist-services (OTA with the UI bundle, no desktop release needed) and pushed in by the
 * renderer at startup (webble feature 'webble-known-names', see WebBleFeature.setKnownDeviceNames). It is
 * `{ version, names }`: `names` is the list, `version` is increased with every change. Until a list was pushed
 * nothing is known: nothing scans before the renderer has pushed it.
 */

let entries = []
let version = 0

/**
 * @param {{version:number, names:string[]}} list
 * @returns {boolean} whether the list was taken over (only a valid list with a version above the current one)
 */
function setKnownDeviceNames(list) {
    if (!list || !Number.isInteger(list.version) || list.version < 1 || !Array.isArray(list.names)) return false
    if (list.version < version) return false
    entries = buildEntries(list.names.filter(n => typeof n === 'string' && /^[a-z0-9]{3,}\*?$/i.test(n)))
    version = list.version
    return true
}

function getKnownNamesVersion() {
    return version
}

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
    const start = part.search(/\d{4}/)
    return start < 0 ? part : part.slice(0, start)
}

// a purely numeric part, or one that only consists of hex digits and contains a digit, is part of a serial number
function isDeviceId(part) {
    return /^\d+$/.test(part) || (/^[\da-f]+$/.test(part) && /\d/.test(part))
}

function buildEntries(list) {
    return [...new Set(list.map(e => e.toLowerCase()))]
}

/**
 * An entry matches a part if it is equal to it. An entry that ends with `*` stands for a whole family and matches
 * every part that starts with it: "hrm*" matches "hrm", "hrm200" and "hrmpro", "assioma*" matches "assiomapro". The
 * prefix in front of the `*` needs at least 3 characters (see the tests of the shipped list).
 */
function matchesPart(entry, part) {
    return entry.endsWith('*') ? part.startsWith(entry.slice(0, -1)) : part === entry
}

function isKnownDeviceName(name, list = entries) {
    const parts = nameParts(name)
    if (parts.length === 0) return false
    return parts.some(part => list.some(entry => matchesPart(entry, part)))
}

module.exports = { isKnownDeviceName, matchesPart, nameParts, buildEntries, setKnownDeviceNames, getKnownNamesVersion }
