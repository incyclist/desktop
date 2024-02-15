const LoadingWindow = require('./pages/loading');
const MainWindow = require('./pages/main');
const OAuthWindow = require('./pages/oauth');

class WindowManager {

    constructor(app) {
        this.mainWindow = undefined;
        this.loadingWindow = undefined;
        this.authWindows = {}
        this.app = app;

    }

    getMainWindow() {
        return this.mainWindow
    }

    setChecking() {
        if ( this.loadingWindow)
            this.loadingWindow.setChecking();
    }

    setLoading() {        
        if ( this.loadingWindow)
            this.loadingWindow.setLoading();
    }

    setUpdating() {         
        if ( this.loadingWindow)
            this.loadingWindow.setUpdating();
    }

    getActiveWindow() {
        if (this.mainWindow!==undefined)
            return this.mainWindow.win;
        if (this.loadingWindow!==undefined)
            return this.mainWindow.win;
    }

    showLoadingWindow() {
        if (!this.loadingWindow)
            this.loadingWindow = new LoadingWindow(this.app);
        this.loadingWindow.show();

    }

    createMainWindow() {
        this.mainWindow = new MainWindow(this.app);        
    }

    hasMainWindow() {
        return this.mainWindow!==undefined && this.mainWindow!==null
    }

    showMainWindow() {
        if ( this.loadingWindow!==undefined && this.mainWindow!==undefined) {
            this.loadingWindow.hide();
            this.mainWindow.show()
        }
        this.closeAuthWindow()
    }

    sendMainWindowEvent(key,event) {
        if ( this.mainWindow!==undefined)
            this.mainWindow.send( key,event)
    }

    closeMainWindow() {
        let win = this.mainWindow

        if ( win.webContents!==undefined) {
            const storage =win.webContents.session;
            if ( storage!==undefined) 
                storage.flushStorageData();
        
            const cookies = win.webContents.session.cookies;
            if ( cookies!==undefined)
                cookies.flushStore( function() {});        
        }

    }

    createAuthWindow(provider) {
        let window = this.authWindows[provider]
        if (!window) {
            window = new OAuthWindow(this.app,provider);
            this.authWindows[provider] = window;
        }
    }
    
    showAuthWindow(provider) { 
        let window = this.authWindows[provider]
        if (window) 
            window.show()

    }


    closeAuthWindow(provider) {
        let window = this.authWindows[provider]
        if (window) 
            window.hide()

    }

    focusActive() {
        if (this.getActiveWindow()) {
            const win = this.getActiveWindow();
            if (win.isMinimized()) 
                win.restore()
            win.focus()
        }

    }


}

module.exports = WindowManager