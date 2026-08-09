const MainWindow = require('./main');

describe('MainWindow', () => {

    /**
     * Builds a MainWindow-like instance without invoking the real constructor
     * (which would require a full Electron BrowserWindow). `win` is shaped like
     * a real Electron BrowserWindow: it exposes `webContents.send`/`isDestroyed`
     * but has NO top-level `.send()` method - matching the real Electron API,
     * so a regression to `this.win.send(...)` would be caught by these tests.
     */
    function createInstance() {
        const instance = Object.create(MainWindow.prototype);
        instance.logger = { logEvent: jest.fn() };
        instance.app = { onAppQuit: jest.fn() };
        instance.win = {
            webContents: {
                send: jest.fn(),
                isDestroyed: () => false
            }
        };
        return instance;
    }

    describe('onClose', () => {
        // TEMPORARY DIAGNOSTIC (2026-08-09): preventDefault() removed from onClose()
        // to test whether win.destroy()/skipping beforeunload is the trigger for a
        // macOS BLE-binding shutdown deadlock - see onClose()'s comment in main.js.
        // Revert this assertion alongside that change once the hypothesis is confirmed.
        it('notifies the renderer via webContents.send without preventing the default close', () => {
            const mw = createInstance();
            const event = { preventDefault: jest.fn() };

            mw.onClose(event);

            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(mw.win.webContents.send).toHaveBeenCalledWith('app-event', {component:'app',closing:true});
        });

        it('does not throw even if win has no top-level send method', () => {
            const mw = createInstance();
            expect(typeof mw.win.send).toBe('undefined');

            const event = { preventDefault: jest.fn() };
            expect(() => mw.onClose(event)).not.toThrow();
        });
    });

    describe('onClosed', () => {
        it('clears win and notifies the app that it should quit', () => {
            const mw = createInstance();

            mw.onClosed();

            expect(mw.win).toBeUndefined();
            expect(mw.app.onAppQuit).toHaveBeenCalled();
        });
    });

});
