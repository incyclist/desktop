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

    describe('onWindowAllClosed', () => {

        beforeEach(() => {
            incyclistApp.windowManager = { hasMainWindow: jest.fn(() => false), closeMainWindow: jest.fn() }
        })

        test('routes through quit() instead of calling app.quit() directly', () => {
            incyclistApp.quit = jest.fn()

            incyclistApp.onWindowAllClosed()

            expect(incyclistApp.quit).toHaveBeenCalled()
            expect(app.quit).not.toHaveBeenCalled()
        })

        test('is a safe no-op when a quit is already in progress (does not bypass the watchdog-protected quit())', async () => {
            incyclistApp.state.isQuitting = true

            incyclistApp.onWindowAllClosed()
            await Promise.resolve()

            // real quit() runs, but its own re-entrancy guard makes it a no-op
            expect(app.quit).not.toHaveBeenCalled()
        })

        test('closes the main window and re-enables the screensaver if still present', () => {
            incyclistApp.windowManager.hasMainWindow = jest.fn(() => true)
            incyclistApp.quit = jest.fn()

            incyclistApp.onWindowAllClosed()

            expect(incyclistApp.windowManager.closeMainWindow).toHaveBeenCalled()
            expect(incyclistApp.enableScreensaver).toHaveBeenCalled()
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

        describe('watchdog (fires if quit hangs)', () => {

            const withPlatform = (platform) => Object.defineProperty(process, 'platform', { value: platform })

            let originalPlatform
            let killSpy

            beforeEach(() => {
                originalPlatform = process.platform
                killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {})
                // make the flush hang forever so the try-block never reaches app.quit()
                incyclistApp.restAdapter.flush = jest.fn(() => new Promise(() => {}))
            })

            afterEach(() => {
                withPlatform(originalPlatform)
                killSpy.mockRestore()
            })

            test('on macOS: sends a real SIGKILL to itself, not app.exit() - works around a confirmed native BLE-binding deadlock in Node\'s own exit cleanup that both app.quit() and app.exit() funnel into', async () => {
                withPlatform('darwin')

                incyclistApp.quit()
                await Promise.resolve()
                jest.advanceTimersByTime(2000)

                expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGKILL')
                expect(app.exit).not.toHaveBeenCalled()
            })

            test('on other platforms: still uses app.exit(), not SIGKILL - this deadlock is not known to occur there', async () => {
                withPlatform('win32')

                incyclistApp.quit()
                await Promise.resolve()
                jest.advanceTimersByTime(2000)

                expect(app.exit).toHaveBeenCalled()
                expect(killSpy).not.toHaveBeenCalled()
            })
        })
    })
})
