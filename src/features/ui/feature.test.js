const NativeUISupport = require('./feature')
const { app } = require('electron')

describe('NativeUISupport.quitRequest', () => {

    let instance

    beforeEach(() => {
        instance = NativeUISupport.getInstance()
        app.incyclistApp = {
            getMainWindow: jest.fn(),
            quit: jest.fn()
        }
    })

    test('routes through the same app-event/closing handshake as the window close (X) button when a main window exists', () => {
        const mainWindow = { send: jest.fn() }
        app.incyclistApp.getMainWindow.mockReturnValue(mainWindow)

        instance.quitRequest()

        expect(mainWindow.send).toHaveBeenCalledWith('app-event', {component:'app', closing:true})
        expect(app.incyclistApp.quit).not.toHaveBeenCalled()
    })

    test('falls back to quitting directly when there is no main window', () => {
        app.incyclistApp.getMainWindow.mockReturnValue(undefined)

        instance.quitRequest()

        expect(app.incyclistApp.quit).toHaveBeenCalled()
    })

})

describe('NativeUISupport.confirmExit', () => {

    let instance

    beforeEach(() => {
        instance = NativeUISupport.getInstance()
        app.incyclistApp = {
            getMainWindow: jest.fn()
        }
    })

    // Was win.destroy() via getWindowManager().getActiveWindow() - confirmed via a real
    // macOS repro that force-destroying the window skips the renderer's beforeunload
    // (which releases native device handles), leaving a native BLE binding in a state
    // that later deadlocks the whole process on exit. confirmClose() instead lets the
    // window close normally, now that the renderer has confirmed via the handshake.
    test('calls confirmClose() on the main window instead of destroying it directly', () => {
        const mainWindow = { confirmClose: jest.fn() }
        app.incyclistApp.getMainWindow.mockReturnValue(mainWindow)

        instance.confirmExit()

        expect(mainWindow.confirmClose).toHaveBeenCalled()
    })

    test('does not throw when there is no main window', () => {
        app.incyclistApp.getMainWindow.mockReturnValue(undefined)

        expect(() => instance.confirmExit()).not.toThrow()
    })

})
