const os = require('node:os')
const { isPrivateAddress } = require('./peer-filter')

/** Local interface addresses as [{address, family, interface, internal, private}]. */
function listLocalAddresses() {
    try {
        const result = []
        const interfaces = os.networkInterfaces()

        for (const [name, entries] of Object.entries(interfaces)) {
            for (const e of entries ?? []) {
                try {
                    const family = typeof e.family === 'number' ? (e.family === 4 ? 'IPv4' : 'IPv6') : e.family
                    result.push({
                        address: e.address, family, interface: name, internal: e.internal,
                        private: isPrivateAddress(e.address)
                    })
                }
                catch { /* skip an unreadable entry */ }
            }
        }
        return result
    }
    catch {
        // os.networkInterfaces() can fail (e.g. uv_interface_addresses): report no addresses
        return []
    }
}

module.exports = { listLocalAddresses }
