const path = require('node:path')
const fs = require('node:fs')
const Module = require('node:module')

// The desktop does not depend on incyclist-services (type references only). The harness uses the
// wire-protocol core from a CommonJS build of the sibling checkout, or from INCYCLIST_SERVICES_LIB.
const DEFAULT_LIB = path.resolve(__dirname, '../../../../services/lib/cjs')

function servicesLibDir() {
    const dir = process.env.INCYCLIST_SERVICES_LIB ?? DEFAULT_LIB
    if (!fs.existsSync(path.join(dir, 'link', 'index.js')))
        throw new Error(`services CommonJS build with src/link not found at ${dir}. Run "npm run build:cjs" in the services repo or set INCYCLIST_SERVICES_LIB`)
    return dir
}

/** Wire-protocol core (framing, channel, auth, version). Pure: no app state needed. */
function loadWire() {
    // the wire core takes its randomness and HMAC from the crypto binding, which the apps inject at startup
    require(path.join(servicesLibDir(), 'api', 'bindings')).getBindings().crypto = require('node:crypto')
    return require(path.join(servicesLibDir(), 'link'))
}

/** Replaces require('electron') for code that only needs a stub of the main-process API. */
function stubElectron() {
    const original = Module._load
    const stub = { ipcMain: { handle() {}, on() {} }, app: { getPath: () => require('node:os').tmpdir() } }
    Module._load = function (request, ...rest) {
        if (request === 'electron')
            return stub
        return original.call(this, request, ...rest)
    }
    return () => { Module._load = original }
}

module.exports = { servicesLibDir, loadWire, stubElectron }
