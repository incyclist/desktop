jest.mock('electron', () => ({ ipcMain: { handle: jest.fn(), on: jest.fn() }, app: {} }))
jest.mock('../utils', () => ({
    ipcCall: jest.fn(), ipcCallSync: jest.fn(), ipcCallNoResponse: jest.fn(), ipcRegisterBroadcast: jest.fn(),
    ipcHandle: jest.fn(), ipcHandleSync: jest.fn(), ipcHandleNoResponse: jest.fn(), ipcSendEvent: jest.fn()
}))
jest.mock('node:fs/promises')

const promiseFs = require('node:fs/promises')
const FileSystemSupport = require('./feature')

describe('FileSystemSupport.stat', () => {
    let feature

    beforeEach(() => {
        jest.resetAllMocks()
        feature = new FileSystemSupport()
    })

    test('returns the file size only', async () => {
        promiseFs.stat.mockResolvedValue({ size: 1234, mtime: new Date(), mode: 0o644 })

        const res = await feature.stat('/videos/a.mp4')

        expect(promiseFs.stat).toHaveBeenCalledWith('/videos/a.mp4')
        expect(res).toEqual({ size: 1234 })
    })

    test('rejects when the file does not exist', async () => {
        promiseFs.stat.mockRejectedValue(new Error('ENOENT'))

        await expect(feature.stat('/missing')).rejects.toThrow('ENOENT')
    })
})
