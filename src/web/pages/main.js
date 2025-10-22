const { BrowserWindow,globalShortcut} =  require('electron');
const path = require('path')
const {EventLogger }= require('gd-eventlog');
const { getSourceDir } = require('../../utils');

class MainWindow {

    constructor( app, opts) {
        const props = opts || {}
        this.app = app;
        this.win = undefined;
        this.loaded = false;
        this.loadError = false;
        this.oldWin  = props.old; 


        //this.pageUrl = 'http://localhost:4000'; 
        this.pageUrl = 'file://'+path.join(getSourceDir() ,'../build/index.html'+"#ride"); 
        if ( this.app.settings.pageDir!==undefined) 
            this.pageUrl = 'file://'+path.join( this.app.settings.pageDir ,'index.html'+"#ride"); 
        if ( this.app.settings.pageUrl!==undefined) {
            if (this.pageUrl.endsWith('/start') || this.pageUrl.startsWith('file:'))
                this.pageUrl = this.app.settings.pageUrl;
            else 
                this.pageUrl = `${this.app.settings.pageUrl}/start`;
        }

        this.iconUrl = path.join(getSourceDir() ,"./public/favicon.ico");
        this.preloadUrl = path.join(getSourceDir() ,"./web/mainPreload.js");

        this.logger = new EventLogger('MainWin')
        this.logger.set({'event-type':'lifecycle'})

        this.requestLogger = new EventLogger('Requests')

        this.create();
    }

    setUrl(url) {
        this.url = url;
    }


    create() {
        this.logger.logEvent({message:'create',url:this.pageUrl})

        this.loaded = false;
        this.loadError = false;

        this.win = new BrowserWindow({ 
            show:false,
            fullscreen: false, 
            title:this.app.getName(),
            icon: this.iconUrl, 
            minWidth:800,
            minHeight:600,
            useContentSize :true,
            allowRunningInsecureContent :true,
            enableRemoteModule:false,
            resizable:true,
            webPreferences: {
                webSecurity:false, 
                contextIsolation: false,
                nodeIntegration: true,
                preload: this.preloadUrl
            } 
        })
        this.win.removeMenu();
        if (process.env.DEBUG) {
            this.win.webContents.openDevTools();
                    
        }
        this.win.on('close',this.onClose.bind(this));
        this.win.on('closed',this.onClosed.bind(this));
        //this.win.once('ready-to-show',this.onReady.bind(this));

        this.win.on('session-end', ()=>{console.log('~~~ session-end')})
        this.win.on('unresponsive', ()=>{ console.log('~~~ unresponsive')})
        this.win.on('responsive', ()=>{console.log('~~~ responsive')})

        this.win.webContents.on('did-finish-load', ()=>{
            this.logger.logEvent({message:'did-finish-load'})
            this.onReady();
        })
        this.win.webContents.once ('did-fail-load',(event) => {this.onLoadError(event)});
        this.win.webContents.session.webRequest.onCompleted( (details) => {
            this.requestLogger.log("Loaded: "+ details.url+"["+(details.fromCache? "from cache":"downloaded") +"]");
        })
        this.win.webContents.session.webRequest.onErrorOccurred( (details)=> {
            this.requestLogger.log("Error loading: "+ details.url+":"+details.error);
        })
        if ( this.oldWin)
            this.oldWin.win.hide();

        this.win.loadURL(this.pageUrl)        
    }

    reload() {
        this.logger.logEvent({message:'reloading ...'})
        if (!this.win)
            return;

        this.win.webContents.once ('did-fail-load',(event) => {this.onLoadError(event)});
        this.win.webContents.once ('dom-ready',(event) => {
            if (!this.loadError)
                this.onReady()
        });

        this.loaded = false;
        this.loadError = false;
        this.win.loadURL(this.pageUrl)        
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

    send(event,args) {
        this.logger.logEvent({message:'send',win:this.win!==undefined,wc:( this.win!==undefined && this.win.webContents!==undefined) })
        if ( this.win!==undefined && this.win.webContents!==undefined && !this.win.webContents.isDestroyed())
            this.win.webContents.send(event,args)
    }

    onReady() {
        let success = (this.loadError===false);

        if (this.isReady)
            return;

        this.win.maximize();

        this.logger.logEvent({message:'ready',success,win:this.win})
        if ( success) {
            this.loaded = true;
            let win = this.win;
            this.app.onAppLoaded();

            win.removeMenu();
            // Register a 'CommandOrControl+Y' shortcut listener.

            if (process.platform==='darwin') {
                globalShortcut.register('CommandOrControl+Alt+I', () => {
                    win.webContents.openDevTools();
                })
                globalShortcut.register('CommandOrControl+Alt+F', () => {
                    win.setFullScreen(!win.isFullScreen());
                })
    
            }
            else {
                globalShortcut.register('CommandOrControl+Shift+Alt+I', () => {
                    win.webContents.openDevTools();
                })    
                globalShortcut.register('CommandOrControl+Alt+F', () => {
                    win.setFullScreen(!win.isFullScreen());
                })
            }
            this.isReady = true;
        }
        else {
            this.app.onAppLoadFailed()
        }

    }
    onLoadError(event) {
        this.logger.logEvent({message:"load error :",url:event.sender?.history||this.pageUrl,event});

        setTimeout( ()=>this.reload(),3000 )
        if (!this.loaded)
            this.loadError = true;        
    }
  
    onClosed() {
        this.logger.logEvent({message:'closed'})
        this.win = undefined;

        this.app.onAppQuit();
    }

    onClose(e) {
        this.win.send( 'app-event',{component:'app',closing:true })
    }


}

module.exports = MainWindow;