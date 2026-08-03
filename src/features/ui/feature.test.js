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
