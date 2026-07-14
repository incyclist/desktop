const { EventLogger } = require('gd-eventlog')
const { networkInterfaces } = require('node:os')
const net = require('node:net')

/**
 * Vendored from incyclist-devices (src/serial/bindings/tcp.ts).
 *
 * Kept as a local copy rather than a dependency on incyclist-devices: this app
 * releases 2-4x/year while incyclist-devices publishes near-daily, and the
 * binding only ever touched gd-eventlog and Node built-ins, so there is no
 * real coupling to vendor against.
 */

const DEFAULT_TIMEOUT = 3000

function resolveNextTick() {
    return new Promise(resolve => process.nextTick(() => resolve()))
}

class CanceledError extends Error {
    constructor(message) {
        super(message)
        this.canceled = true
    }
}

function scanPort(host, port) {
    return new Promise((resolve) => {
        try {
            const socket = new net.Socket()

            const cleanup = () => {
                try {
                    socket.destroy()
                }
                catch {}
                socket.removeAllListeners()
            }

            socket.setTimeout(1000)
            socket.on('timeout', () => { resolve(false); cleanup() })
            socket.on('error', () => { resolve(false); cleanup() })
            socket.on('ready', () => { resolve(true); cleanup() })

            socket.connect(port, host)
        }
        catch {
            // just in case - this code should never be reached
            resolve(false)
        }
    })
}

function scanSubNet(sn, port, excludeHosts) {
    const range = []
    for (let i = 1; i < 255; i++)
        if (!excludeHosts?.includes(`${sn}.${i}`)) range.push(i)

    return Promise.all(range.map(j => scanPort(`${sn}.${j}`, port).then(success => success ? `${sn}.${j}` : null).catch()))
        .then(hosts => hosts.filter(h => h !== null))
        .catch()
}

function getSubnets() {
    const address = Object.keys(networkInterfaces())
        .reduce((a, key) => [
            ...a,
            ...networkInterfaces()[key]
        ], [])
        .filter(iface => iface.family === 'IPv4' && !iface.internal && iface.netmask === '255.255.255.0')
        .map(iface => {
            const parts = iface.address.split('.')
            return `${parts[0]}.${parts[1]}.${parts[2]}`
        })

    const subnets = address.filter((x, i) => i === address.indexOf(x))
    subnets.push('127.0.0')
    return subnets
}

class TCPPortBinding {
    onDataHandler = this.onData.bind(this)
    onErrorHandler = this.onError.bind(this)
    onTimeoutHandler = this.onTimeout.bind(this)
    onCloseHandler = this.onClose.bind(this)

    constructor(socket, options) {
        this.logger = new EventLogger('TCPPort')
        this.socket = socket
        this.openOptions = options
        this.pendingRead = null
        this.writeOperation = null
        this.data = null

        this.socket.removeAllListeners()
        this.socket.on('data', this.onDataHandler)
        this.socket.on('error', this.onErrorHandler)
        this.socket.on('close', this.onCloseHandler)
        this.socket.on('end', this.onCloseHandler)
        this.socket.on('timeout', this.onTimeoutHandler)
    }

    get isOpen() {
        return this.socket !== null
    }

    onData(data) {
        if (!this.data) this.data = Buffer.alloc(0)
        const buffer = Buffer.from(data)
        this.data = Buffer.concat([this.data, buffer])

        if (this.pendingRead) {
            process.nextTick(this.pendingRead)
            this.pendingRead = null
        }
    }

    onError(err) {
        this.logger.logEvent({ message: 'Port Error', error: err.message })
        if (this.pendingRead) {
            this.pendingRead(err)
            this.socket = null
        }
    }

    onTimeout() {
        this.logger.logEvent({ message: 'Port Timeout' })
        if (this.pendingRead) {
            this.pendingRead(new Error('timeout'))
        }
    }

    onClose() {
        this.close()
    }

    async close() {
        if (!this.isOpen)
            return
        this.data = Buffer.alloc(0)

        const close = async () => {
            return new Promise(done => {
                const socket = this.socket
                socket.on('error', () => { done(false) })
                socket.on('close', () => { socket.removeAllListeners(); done(true) })
                socket.destroy()
            })
        }

        const closed = await close()

        if (closed) {
            this.socket = null
            if (this.pendingRead) {
                this.pendingRead(new CanceledError('port is closed'))
            }
        }
    }

    async read(buffer, offset, length) {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        if (!Buffer.isBuffer(buffer)) {
            throw new TypeError('"buffer" is not a Buffer')
        }
        if (typeof offset !== 'number' || Number.isNaN(offset)) {
            throw new TypeError(`"offset" is not an integer got "${Number.isNaN(offset) ? 'NaN' : typeof offset}"`)
        }
        if (typeof length !== 'number' || Number.isNaN(length)) {
            throw new TypeError(`"length" is not an integer got "${Number.isNaN(length) ? 'NaN' : typeof length}"`)
        }
        if (buffer.length < offset + length) {
            throw new Error('buffer is too small')
        }

        await resolveNextTick()

        if (!this.data || this.data.length === 0) {
            return new Promise((resolve, reject) => {
                this.pendingRead = err => {
                    if (err) {
                        if (err.message === 'timeout') {
                            resolve({ buffer: Buffer.from([]), bytesRead: 0 })
                            return
                        }
                        return reject(err)
                    }
                    this.read(buffer, offset, length).then(resolve, reject)
                }
            })
        }

        const lengthToRead = length === 65536 ? this.data.length : length

        const toCopy = this.data.slice(0, lengthToRead)
        const bytesRead = toCopy.copy(buffer, offset)
        this.data = this.data.slice(lengthToRead)
        this.pendingRead = null

        return ({ buffer, bytesRead })
    }

    write(buffer) {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }

        this.writeOperation = new Promise((resolve) => {
            const run = async () => {
                await resolveNextTick()

                try {
                    this.socket.write(buffer, () => {
                        resolve()
                    })
                }
                catch (err) {
                    this.onError(err)
                }
            }

            run()
        })

        return this.writeOperation
    }

    async update() {
        await resolveNextTick()
    }

    async set() {
        await resolveNextTick()
    }

    async get() {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        await resolveNextTick()
        return {
            cts: true,
            dsr: false,
            dcd: false,
        }
    }

    async getBaudRate() {
        return { baudRate: 9600 }
    }

    async flush() {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        await resolveNextTick()
        this.data = Buffer.alloc(0)
    }

    async drain() {
        if (!this.isOpen) {
            throw new Error('Port is not open')
        }
        await resolveNextTick()
        await this.writeOperation
    }
}

const TCPBinding = {
    /**
     * Provides a list of hosts that have port #PORT opened
     */
    async list(port, excludeList) {
        if (!port)
            return []

        const subnets = getSubnets()
        let hosts = []

        const excludeHosts = excludeList.map(e => e?.includes(':') ? e.split(':')[0] : e)

        await Promise.all(
            subnets.map(sn => scanSubNet(sn, port, excludeHosts).then(found => { hosts.push(...found) }))
        )

        return hosts.map(host => ({
            path: `${host}:${port}`,
            manufacturer: undefined,
            locationId: undefined,
            pnpId: undefined,
            productId: undefined,
            serialNumber: undefined,
            vendorId: undefined
        }))
    },

    /**
     * Opens a connection to the serial port referenced by the path.
     */
    async open(options) {
        const asyncOpen = () => {
            return new Promise((resolve, reject) => {
                let host, port

                if (!options.path)
                    return reject(new TypeError('"path" is not valid'))

                try {
                    const res = options.path.split(':')
                    if (res.length !== 2)
                        return reject(new TypeError('"path" is not valid'))
                    host = res[0]
                    port = Number(res[1])
                    if (Number.isNaN(port))
                        return reject(new TypeError('"path" is not valid'))
                }
                catch {
                    return reject(new TypeError('"path" is not valid'))
                }

                const socket = new net.Socket()
                socket.setTimeout(options.timeout || DEFAULT_TIMEOUT)

                socket.once('timeout', () => { reject(new Error('timeout')) })
                socket.once('error', (err) => { reject(err) })
                socket.once('connect', () => { resolve(socket) })

                socket.connect(port, host)
            })
        }

        // This all can be actually ignored for the TCPBinding, but as they are all required, I need to setup some defaults
        const openOptions = {
            dataBits: 8,
            lock: true,
            stopBits: 1,
            parity: 'none',
            rtscts: false,
            xon: false,
            xoff: false,
            xany: false,
            hupcl: true,
            ...options
        }

        const socket = await asyncOpen()

        return new TCPPortBinding(socket, openOptions)
    }
}

module.exports = { TCPBinding, TCPPortBinding, CanceledError, scanPort, scanSubNet, getSubnets }
