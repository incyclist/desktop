const { BrowserWindow} =  require('electron');
const path = require('path')
const {EventLogger }= require('gd-eventlog');
const { getSourceDir } = require('../../utils');

const LOADING_WIN_WIDTH = 600;
const LOADING_WIN_HEIGHT = 450;

class LoadingWindow {

    
    constructor( app) {
        this.app = app;
        this.win = undefined;
        this.logger = new EventLogger('LoadingWin',this.app.logger)
        this.logger.set({'event-type':'lifecycle'})
        this.preloadUrl = path.join(getSourceDir() ,"./web/preload.js");
        this.create();
    }

    create() {
        this.logger.logEvent({message:'create loading screen'})
        this.win = new BrowserWindow({ 
            show:false, 
            frame:false, 
            webPreferences: {
                nodeIntegration: true,
                contextIsolation:  false,
                preload:this.preloadUrl

            },
            width:LOADING_WIN_WIDTH , 
            height:LOADING_WIN_HEIGHT, backgroundColor:"#cccccc"
        })
        this.win.webContents.executeJavaScript( `document.getElementById("versionText").innerHTML = "${this.app.appName} ${this.app.appVersion}" `)
        this.win.on('closed',this.onClosed.bind(this));
        if (process.env.LOADER_DEBUG) {
            this.win.webContents.openDevTools();
                    
        }

        try {

            let url = 'file://'+path.join(getSourceDir() ,'./public/loading.html');
            this.win.loadURL(url)
        }
        catch(err) {
            console.log(err)
        }
    }

    setChecking() {
        this.win.webContents.executeJavaScript( `document.getElementById("loadingText").innerHTML = "Checking for updates ..." `)
        this.win.webContents.executeJavaScript( `document.getElementById("skipBtn").hidden = true; `)

    }

    setUpdating() {
        if ( this.win==undefined)
            return;
        this.win.webContents.executeJavaScript( `document.getElementById("loadingText").innerHTML = "updating ..." `)
        this.win.webContents.executeJavaScript( `document.getElementById("skipBtn").hidden = false; `)
    }

    setLoading() {
        if ( this.win==undefined)
            return;
        this.win.webContents.executeJavaScript( `document.getElementById("loadingText").innerHTML = "loading ..." `)
        this.win.webContents.executeJavaScript( `document.getElementById("skipBtn").hidden = true; `)
    }

    show() {
        this.logger.logEvent({message:'show'})
        if ( this.win==undefined)
            this.create();
        this.win.show();
    }

    hide() {
        this.logger.logEvent({message:'hide'})
        if ( this.win==undefined)
            return;

        this.win.hide();
        this.win.close();

    }

    onClosed() {
        this.logger.logEvent({message:'closed'})
        this.win = undefined;
    }


}

module.exports = LoadingWindow;