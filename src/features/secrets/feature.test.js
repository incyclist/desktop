jest.mock('electron', () => ({
    ipcMain: { on: jest.fn() },
    app: {
        getVersion: jest.fn(() => '1.2.3'),
        getPath: jest.fn(() => '/tmp/userData'),
    },
    powerMonitor: { on: jest.fn() },
    net: { isOnline: jest.fn(() => true) },
    safeStorage: {
        isEncryptionAvailable: jest.fn(() => true),
        getSelectedStorageBackend: jest.fn(() => 'gnome_libsecret'),
        encryptString: jest.fn((s) => Buffer.from(s)),
        decryptString: jest.fn((b) => b.toString()),
    },
}))

jest.mock('../AppSettings', () => ({
    getInstance: jest.fn(() => ({ settings: { uuid: 'test-uuid' } })),
}))

const { safeStorage, net } = require('electron')
const AppSettings = require('../AppSettings')
const SecretsFeature = require('./feature')

describe('SecretsFeature', () => {
    let feature

    beforeEach(() => {
        jest.clearAllMocks()
        AppSettings.getInstance.mockReturnValue({ settings: { uuid: 'test-uuid' } })
        safeStorage.isEncryptionAvailable.mockReturnValue(true)
        safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
        net.isOnline.mockReturnValue(true)
        process.env.ENVIRONMENT = 'prod'

        feature = new SecretsFeature()
        feature._readCache = jest.fn(() => null)
        feature._writeCache = jest.fn()
        feature._fetchWithTimeout = jest.fn()
    })

    afterEach(() => {
        delete process.env.ENVIRONMENT
    })

    describe('performInit - safeStorage unavailable (fallback path)', () => {
        beforeEach(() => {
            safeStorage.isEncryptionAvailable.mockReturnValue(false)
            safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text')
        })

        test('still fetches secrets over the network via provisioning, without touching the cache', async () => {
            feature._fetchWithTimeout = jest.fn(async () => ({
                ok: true,
                status: 200,
                data: { secrets: { MQ_BROKER: 'broker.example.com' }, expiresAt: '2099-01-01T00:00:00.000Z' },
            }))

            const status = await feature.performInit()

            expect(status).toBe('ok')
            expect(feature.getSecret('MQ_BROKER')).toBe('broker.example.com')
            expect(feature._readCache).not.toHaveBeenCalled()
            expect(feature._writeCache).not.toHaveBeenCalled()
        })

        test('logs the selected storage backend alongside the safeStorage-unavailable event', async () => {
            const logSpy = jest.spyOn(feature.logger, 'logEvent')
            feature._fetchWithTimeout = jest.fn(async () => ({ ok: true, status: 200, data: { secrets: {}, expiresAt: null } }))

            await feature.performInit()

            expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
                message: 'safeStorage not available',
                selectedStorageBackend: 'basic_text',
            }))
        })

        test('provisioning failure -> status missing, cache still never touched', async () => {
            feature._fetchWithTimeout = jest.fn(async () => ({ ok: false, status: 500, data: null }))

            const status = await feature.performInit()

            expect(status).toBe('missing')
            expect(feature._readCache).not.toHaveBeenCalled()
            expect(feature._writeCache).not.toHaveBeenCalled()
        })

        test('offline -> status missing without any network or cache calls', async () => {
            net.isOnline.mockReturnValue(false)

            const status = await feature.performInit()

            expect(status).toBe('missing')
            expect(feature._readCache).not.toHaveBeenCalled()
            expect(feature._writeCache).not.toHaveBeenCalled()
            expect(feature._fetchWithTimeout).not.toHaveBeenCalled()
        })
    })

    describe('performInit - safeStorage available (existing behaviour unchanged)', () => {
        test('no cache -> provisions and writes cache', async () => {
            feature._fetchWithTimeout = jest.fn(async () => ({
                ok: true,
                status: 200,
                data: { secrets: { MQ_BROKER: 'broker.example.com' }, expiresAt: '2099-01-01T00:00:00.000Z' },
            }))

            const status = await feature.performInit()

            expect(status).toBe('ok')
            expect(feature._readCache).toHaveBeenCalled()
            expect(feature._writeCache).toHaveBeenCalledWith({ secrets: { MQ_BROKER: 'broker.example.com' }, expiresAt: '2099-01-01T00:00:00.000Z' })
        })
    })

    describe('getSecret', () => {
        test('non-prod -> reads from process.env', () => {
            process.env.ENVIRONMENT = 'dev'
            process.env.MY_KEY = 'from-env'
            const result = feature.getSecret('MY_KEY')
            expect(result).toBe('from-env')
            delete process.env.MY_KEY
        })

        test('prod, no secrets loaded -> empty string', () => {
            expect(feature.getSecret('MQ_BROKER')).toBe('')
        })
    })
})
