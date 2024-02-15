const { BrowserWindow,globalShortcut} =  require('electron');
const path = require('path')
const {EventLogger }= require('gd-eventlog');
const EventEmitter = require('events');
const { getSourceDir } = require('../../utils');

const MAIN_WIN_WIDTH = 400;
const MAIN_WIN_HEIGHT = 300;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36'
const OAUTH_SERVER =  'https://auth.incyclist.com/'

function trimTrailingChars(s, charToTrim) {
    let c = charToTrim;
    if ( charToTrim===undefined) {
        c = s.charAt(s.length-1)
    }
    var regExp = new RegExp(c + "+$");
    var result = s.replace(regExp, "");
  
    return result;
}

class OAuthWindow extends EventEmitter{

    constructor( app, opts={}) {
        super()

        this.app = app;
        this.win = undefined;
        this.loaded = false;
        this.loadError = false;
        this.id = Date.now()

        const {provider = 'strava', legacyApi = true} = opts;

        this.provider = provider;
        this.legacyApi = legacyApi;

        this.pageUrl = this.app.settings.oauthUrl || OAUTH_SERVER;        
        if (legacyApi)
            this.pageUrl = trimTrailingChars(this.pageUrl,'/') + `/${provider}`
        else 
            this.pageUrl = trimTrailingChars(this.pageUrl,'/') + `/${provider}?sid=${this.id}`

        this.iconUrl = path.join(getSourceDir() ,"./public/favicon.ico");
        this.preloadUrl = path.join(getSourceDir() ,"./web/preload.js");

        this.logger = new EventLogger('OAuthWin')
        this.requestLogger = new EventLogger('Requests')

        this.create();
    }

    getId() {
        return this.id
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
            minWidth:1024,
            minHeight:768,
            useContentSize :true,
            allowRunningInsecureContent :true,
            resizable:true,
            webPreferences: {
                webSecurity:true, 
                contextIsolation: false,
                nodeIntegration: true,
                preload: this.preloadUrl
            } 
        })


        this.win.on('closed',this.onClosed.bind(this));
        this.win.once('ready-to-show',this.onReady.bind(this));


        this.win.webContents.once ('did-fail-load',(event) => {this.onLoadError(event)});
        this.win.webContents.session.webRequest.onCompleted( (details) => {
            this.requestLogger.log("Loaded: "+ details.url+"["+(details.fromCache? "from cache":"downloaded") +"]");
        })
        this.win.webContents.session.webRequest.onErrorOccurred( (details) =>{
            this.requestLogger.log("Error loading: "+ details.url+":"+details.error);
        })


        this.win.loadURL(this.pageUrl, {userAgent:USER_AGENT})        
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

    onReady() {
        let success = (this.loadError==false);
        this.logger.logEvent({message:'ready',success,win:this.win})
        if ( success) {
            this.loaded = true;
            
            this.app.onOAuthLoaded(this.provider)
            this.emit('loaded')
            if (this.win)
                this.win.removeMenu();
            this.show();
        }
        else {
            this.app.onOAuthLoadFailed(this.provider)
            this.emit('failed',{reason:'window could not be loaded'})
        }
    }
    onLoadError(event) {
        this.logger.logEvent({message:"load error :",url:event.sender.history,event});

        if (!this.loaded) {
            this.loadError = true;        
            this.emit('failed',{reason:'load error'})
        }
    }
  
    onClosed() {
        this.logger.logEvent({message:'closed'})
        this.win = undefined;
        this.emit('closed',{provider:this.provider, reason:'window could not be loaded'})

        this.app.onOAuthQuit(this.provider,this.legacyApi);
    }


}

module.exports = OAuthWindow;