const net = require('node:net')
const { TCPBinding } = require('./tcp-binding')

const TEST_PORT = 12345
const TEST_PATH = `localhost:${TEST_PORT}`

const sleep = (ms) => new Promise(done => setTimeout(done, ms))

describe('TCPBinding', () => {

    let server, serverSocket
    const fnReceive = jest.fn()
    const bindings = []

    beforeEach(async () => {
        fnReceive.mockClear()

        server = net.createServer((socket) => {
            serverSocket = socket
            serverSocket.on('data', (data) => {
                fnReceive(data)
                serverSocket.write(Buffer.from(data.toString() + ' world'))
            })
        })

        await new Promise(resolve => server.listen(TEST_PORT, 'localhost', resolve))
    })

    afterEach(async () => {
        for (const b of bindings) {
            try { await b.close() } catch {}
        }
        bindings.length = 0

        if (serverSocket) {
            serverSocket.removeAllListeners()
            serverSocket.destroy()
        }
        await new Promise(resolve => server.close(resolve))
    })

    test('open - valid path connects', async () => {
        const binding = await TCPBinding.open({ path: TEST_PATH })
        bindings.push(binding)
        expect(binding.isOpen).toBe(true)
    })

    test('open - missing path rejects', async () => {
        await expect(TCPBinding.open({})).rejects.toThrow('"path" is not valid')
    })

    test('open - malformed path rejects', async () => {
        await expect(TCPBinding.open({ path: 'localhost' })).rejects.toThrow('"path" is not valid')
    })

    test('open - unreachable port rejects', async () => {
        await expect(TCPBinding.open({ path: 'localhost:65535', timeout: 200 })).rejects.toThrow()
    })

    test('write - server receives data', async () => {
        const binding = await TCPBinding.open({ path: TEST_PATH })
        bindings.push(binding)

        await binding.write(Buffer.from('Hello'))
        await sleep(50)

        expect(fnReceive).toHaveBeenCalledWith(Buffer.from('Hello'))
    })

    test('read - resolves with echoed data', async () => {
        const binding = await TCPBinding.open({ path: TEST_PATH })
        bindings.push(binding)

        await binding.write(Buffer.from('Hello'))
        await sleep(50)

        const buffer = Buffer.alloc(11)
        const { bytesRead } = await binding.read(buffer, 0, 11)

        expect(bytesRead).toBe(11)
        expect(buffer.toString()).toBe('Hello world')
    })

    test('close - marks binding as closed', async () => {
        const binding = await TCPBinding.open({ path: TEST_PATH })
        bindings.push(binding)

        await binding.close()
        expect(binding.isOpen).toBe(false)
    })
})
