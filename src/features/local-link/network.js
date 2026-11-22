const os = require('node:os')
const { isPrivateAddress } = require('./peer-filter')

/** Local interface addresses as [{address, family, interface, internal, private}]. */
function listLocalAddresses() {
    const result = []
    const interfaces = os.networkInterfaces()

    for (const [name, entries] of Object.entries(interfaces)) {
        for (const e of entries ?? []) {
            const family = typeof e.family === 'number' ? (e.family === 4 ? 'IPv4' : 'IPv6') : e.family
            result.push({
                address: e.address, family, interface: name, internal: e.internal,
                private: isPrivateAddress(e.address)
            })
        }
    }
    return result
}

module.exports = { listLocalAddresses }
