const FEED = 'https://updates.incyclist.com/download/app/latest/darwin/x64'

describe('mac auto update binding', () => {

    const originalGetSystemVersion = process.getSystemVersion
    let electron
    let updateElectronApp
    let originalSetFeedURL
    let Handler

    // The feed patch is applied once per process, so every test needs a fresh module instance
    const load = (systemVersion) => {
        if (systemVersion === 'throws')
            process.getSystemVersion = () => { throw new Error('not available') }
        else if (systemVersion === undefined)
            delete process.getSystemVersion
        else
            process.getSystemVersion = () => systemVersion

        // jest.config maps both 'electron' and 'update-electron-app' to test/mock/electron.js, so they are
        // one and the same module object here - the parts used by the binding are attached to it
        jest.isolateModules(() => {
            electron = require('electron')
            electron.autoUpdater = { setFeedURL: jest.fn() }
            electron.UpdateSourceType = { StaticStorage: 1 }
            // same URL handling as the real library for static storage on macOS
            electron.updateElectronApp = jest.fn((config) => {
                electron.autoUpdater.setFeedURL({
                    url: config.updateSource.baseUrl + '/RELEASES.json',
                    headers: { 'User-Agent': 'update-electron-app/test' },
                    serverType: 'json'
                })
                return { stopUpdates: jest.fn() }
            })
            updateElectronApp = electron.updateElectronApp
            originalSetFeedURL = electron.autoUpdater.setFeedURL
            Handler = require('./mac')
        })
    }

    const create = (logger) => {
        const h = new Handler(undefined, logger)
        h.feedURL = FEED
        return h
    }

    afterEach(() => {
        if (originalGetSystemVersion)
            process.getSystemVersion = originalGetSystemVersion
        else
            delete process.getSystemVersion
    })

    test('adds the macOS version to the feed url, other options stay untouched', async () => {
        load('12.7.6')
        await create().checkForUpdates()

        expect(originalSetFeedURL).toHaveBeenCalledTimes(1)
        expect(originalSetFeedURL).toHaveBeenCalledWith({
            url: `${FEED}/RELEASES.json?macos=12.7.6`,
            headers: { 'User-Agent': 'update-electron-app/test' },
            serverType: 'json'
        })
    })

    test('still passes the base url to update-electron-app unchanged', async () => {
        load('26.0.1')
        await create().checkForUpdates()

        expect(updateElectronApp).toHaveBeenCalledTimes(1)
        expect(updateElectronApp.mock.calls[0][0].updateSource.baseUrl).toBe(FEED)
    })

    test('adds the parameter only once when the check runs repeatedly', async () => {
        load('13.5')
        const h = create()
        await h.checkForUpdates()
        await h.checkForUpdates()
        await create().checkForUpdates()

        expect(originalSetFeedURL).toHaveBeenCalledTimes(3)
        originalSetFeedURL.mock.calls.forEach(([options]) => {
            expect(options.url).toBe(`${FEED}/RELEASES.json?macos=13.5`)
        })
    })

    test('appends with & if the url already has a query', async () => {
        load('14.2.1')
        await create().checkForUpdates()
        // call the patched function the way the library would, with a url that already has a query
        electron.autoUpdater.setFeedURL({ url: `${FEED}/RELEASES.json?a=1`, serverType: 'json' })

        expect(originalSetFeedURL).toHaveBeenLastCalledWith({ url: `${FEED}/RELEASES.json?a=1&macos=14.2.1`, serverType: 'json' })
    })

    test('does not add the parameter twice', async () => {
        load('12.7.6')
        await create().checkForUpdates()
        electron.autoUpdater.setFeedURL({ url: `${FEED}/RELEASES.json?macos=12.7.6`, serverType: 'json' })

        expect(originalSetFeedURL).toHaveBeenLastCalledWith({ url: `${FEED}/RELEASES.json?macos=12.7.6`, serverType: 'json' })
    })

    test('supports setFeedURL being called with a plain url', async () => {
        load('12.7.6')
        await create().checkForUpdates()
        electron.autoUpdater.setFeedURL(`${FEED}/RELEASES.json`)

        expect(originalSetFeedURL).toHaveBeenLastCalledWith(`${FEED}/RELEASES.json?macos=12.7.6`)
    })

    test.each([
        ['getSystemVersion is not available', undefined],
        ['getSystemVersion throws', 'throws'],
        ['the version is not numeric', 'unknown']
    ])('leaves the url as is if %s', async (_title, version) => {
        load(version)
        await create().checkForUpdates()

        expect(originalSetFeedURL).toHaveBeenCalledWith({
            url: `${FEED}/RELEASES.json`,
            headers: { 'User-Agent': 'update-electron-app/test' },
            serverType: 'json'
        })
    })

    test('the update check still runs, with the plain url, if setFeedURL cannot be replaced', async () => {
        load('12.7.6')
        const logger = { logEvent: jest.fn() }
        const fn = electron.autoUpdater.setFeedURL
        Object.defineProperty(electron.autoUpdater, 'setFeedURL', {
            get: () => fn,
            set: () => { throw new Error('read only') }
        })

        await expect(create(logger).checkForUpdates()).resolves.toEqual({ stopUpdates: expect.any(Function) })
        expect(fn).toHaveBeenCalledWith(expect.objectContaining({ url: `${FEED}/RELEASES.json` }))
        expect(logger.logEvent).toHaveBeenCalledWith({ message: 'AutoUpdate feed url patch failed', error: 'read only' })
    })

    test('an ignored assignment is not remembered as patched', async () => {
        load('12.7.6')
        const fn = electron.autoUpdater.setFeedURL
        Object.defineProperty(electron.autoUpdater, 'setFeedURL', { get: () => fn, set: () => {} })

        await create().checkForUpdates()
        await create().checkForUpdates()

        expect(fn).toHaveBeenCalledTimes(2)
        fn.mock.calls.forEach(([options]) => expect(options.url).toBe(`${FEED}/RELEASES.json`))
    })

    test('logs the final feed url', async () => {
        load('12.7.6')
        const logger = { logEvent: jest.fn() }
        await create(logger).checkForUpdates()

        expect(logger.logEvent).toHaveBeenCalledWith({
            message: 'AutoUpdate feed url',
            url: `${FEED}/RELEASES.json?macos=12.7.6`
        })
    })

    test('a failing update check resolves to null', async () => {
        load('12.7.6')
        updateElectronApp.mockImplementation(() => { throw new Error('boom') })

        await expect(create().checkForUpdates()).resolves.toBeNull()
    })
})
