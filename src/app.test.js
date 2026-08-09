// features/index.js transitively requires src/features/serial/ipc-binding.js, which uses
// `interface` (a reserved word in strict mode) as a parameter name and fails to parse under
// Jest/Babel. That is a pre-existing, unrelated issue - mock the module out so requiring
// app.js for these unit tests doesn't pull that file in.
jest.mock('./features', () => ({ initFeaturesApp: jest.fn(), initFeaturesWeb: jest.fn() }))

jest.mock('electron', () => ({
    ipcMain: { on: jest.fn(), once: jest.fn() },
    ipcRenderer: { on: jest.fn() },
    app: { quit: jest.fn(), exit: jest.fn(), getPath: jest.fn(() => './test/out') },
    globalShortcut: { unregisterAll: jest.fn() },
}))

const { app, globalShortcut } = require('electron')
const IncyclistApp = require('./app.js')

describe('IncyclistApp - quit sequence', () => {

    let incyclistApp
    let logger

    beforeEach(() => {
        jest.useFakeTimers()
        jest.clearAllMocks()

        logger = { logEvent: jest.fn() }

        app.quit = jest.fn()
        app.exit = jest.fn()
        globalShortcut.unregisterAll = jest.fn()

        incyclistApp = Object.create(IncyclistApp.prototype)
        incyclistApp.logger = logger
        incyclistApp.state = { isQuitting: false }
        incyclistApp.restAdapter = { flush: jest.fn().mockResolvedValue() }
        incyclistApp.enableScreensaver = jest.fn()
    })

    afterEach(() => {
        jest.useRealTimers()
    })

    describe('onBeforeQuit', () => {

        test('first trigger (isQuitting=false): prevents default, flushes, and re-triggers quit()', async () => {
            incyclistApp.quit = jest.fn()
            const e = { preventDefault: jest.fn() }

            await incyclistApp.onBeforeQuit(e)

            expect(e.preventDefault).toHaveBeenCalled()
            expect(incyclistApp.restAdapter.flush).toHaveBeenCalled()
            expect(incyclistApp.quit).toHaveBeenCalled()
        })

        test('already quitting (isQuitting=true): does not prevent default, does not flush or requit', async () => {
            incyclistApp.state.isQuitting = true
            incyclistApp.quit = jest.fn()
            const e = { preventDefault: jest.fn() }

            await incyclistApp.onBeforeQuit(e)

            expect(e.preventDefault).not.toHaveBeenCalled()
            expect(incyclistApp.restAdapter.flush).not.toHaveBeenCalled()
            expect(incyclistApp.quit).not.toHaveBeenCalled()
        })

        test('swallows flush errors and still requits when not already quitting', async () => {
            incyclistApp.restAdapter.flush = jest.fn().mockRejectedValue(new Error('boom'))
            incyclistApp.quit = jest.fn()
            const e = { preventDefault: jest.fn() }

            await expect(incyclistApp.onBeforeQuit(e)).resolves.not.toThrow()
            expect(incyclistApp.quit).toHaveBeenCalled()
        })
    })

    describe('onWillQuit', () => {

        test('does not prevent default and does not call quit() again', () => {
            incyclistApp.quit = jest.fn()
            const e = { preventDefault: jest.fn() }

            incyclistApp.onWillQuit(e)

            expect(e.preventDefault).not.toHaveBeenCalled()
            expect(incyclistApp.quit).not.toHaveBeenCalled()
        })
    })

    describe('quit', () => {

        test('is a no-op on re-entry when isQuitting is already true', async () => {
            incyclistApp.state.isQuitting = true

            await incyclistApp.quit()

            expect(app.quit).not.toHaveBeenCalled()
            expect(app.exit).not.toHaveBeenCalled()
        })

        test('flushes, unregisters shortcuts, re-enables screensaver, and calls app.quit() - without forcing an immediate app.exit()', async () => {
            await incyclistApp.quit()

            expect(incyclistApp.state.isQuitting).toBe(true)
            expect(incyclistApp.restAdapter.flush).toHaveBeenCalled()
            expect(globalShortcut.unregisterAll).toHaveBeenCalled()
            expect(incyclistApp.enableScreensaver).toHaveBeenCalled()
            expect(app.quit).toHaveBeenCalled()
            // app.exit() must NOT be called right after app.quit() - doing so races/cuts off
            // app.quit()'s own graceful native termination (the macOS Dock-deregistration bug
            // this fix addresses). Only the watchdog timer (tested below) may force-exit.
            expect(app.exit).not.toHaveBeenCalled()
        })

        test('watchdog calls app.exit() (not process.exit()) if quit hangs', async () => {
            const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {})

            // make the flush hang forever so the try-block never reaches app.quit()/app.exit()
            incyclistApp.restAdapter.flush = jest.fn(() => new Promise(() => {}))

            incyclistApp.quit()
            // allow the quit() async function to start and register the watchdog timer
            await Promise.resolve()

            jest.advanceTimersByTime(2000)

            expect(app.exit).toHaveBeenCalled()
            expect(processExitSpy).not.toHaveBeenCalled()

            processExitSpy.mockRestore()
        })
    })
})
