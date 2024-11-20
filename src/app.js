const {EventLogger,ConsoleAdapter,FileAdapter}= require('gd-eventlog')
const { app,globalShortcut,ipcMain,crashReporter,electron,Menu,powerSaveBlocker } =  require('electron');
const EventEmitter = require('events');
const path = require('path')
const axios = require('axios')
const os = require('os');
const RestLogAdapter = require('./modules/RestLogAdapter')
const {checkDir,deleteFile,getLogDirectory,gnerateUUID} = require( './utils')
const AutoUpdate = require('./modules/AutoUpdate')
const {initFeaturesApp} = require('./features'); 
const AppSettings  = require('./features/AppSettings');
const { restLogFilter, fileLogFilter } = require('./utils/logging');

const { version,name} = require('../package.json');
const WindowManager = require('./web/manager');
const APP_NAME = name;
const APP_VERSION = version;

let unhandled

class IncyclistApp
{

    /**
     * Initializes the unhandled library.
     * This must be called before creating the IncyclistApp instance.
     * 
     * This is a workaround for the "Error [ERR_REQUIRE_ESM]: require() of ES Module" when importing unhandled via require() statement
     * This workaround can be removed, when the app is converted to TypeScript
     * @returns {Promise<void>}
     */
    static async init() {
        const UnhandledLib = await import('electron-unhandled'); 
        unhandled = UnhandledLib.default;
    }

    constructor() {
        // initialize minimum required fot single instance check
        // all other initialization can be done in start())
        app.incyclistApp = this
        app.allowRendererProcessReuse=false;  
        if (process.platform==='darwin') {
            Menu.setApplicationMenu(null);
        }

        this.environment  = process.env.ENVIRONMENT || "prod";
        this.session = gnerateUUID();
        this.settings = {}
        this.powerSaveBlockerID = undefined;
        

        this.windowManager = new WindowManager(this)
        this.initBasicLogging();       
    }

    checkSingleInstance() {

        const gotTheLock = app.requestSingleInstanceLock()

        if (!gotTheLock) {
            this.logger.logEvent( {message:'2nd Instance detected - terminating'})
            app.quit()
        } else {
            this.logger.logEvent( {message:'got the instance lock'})

            app.on('second-instance', () => {
                this.logger.logEvent( {message:'2nd Instance launched '})
                // Someone tried to run a second instance, we should focus our window.
                this.windowManager.focusActive()
            })
            return;
        }

    }

    async start() {
        this.state  = {
            ready: false
        }
        this.emitter = new EventEmitter();
        this.initFeatures();
        this.initElectronHandlers()            

        this.settings = AppSettings.getInstance().loadSettings({lazy:true,isInitial:true});
        this.initUser();        
        axios.defaults.headers.common = { "X-uuid":this.settings.uuid,"X-arch":os.arch(), "X-platform":os.platform(), "user-agent": `${name}/${version} (${os.platform()};${os.arch()};${os.release()})`};

        this.initRestLogging()

        try {
            const platform = os.platform();
            const arch = os.arch();
            const release = os.release()
            const mem = Math.round(os.totalmem()/1024/1024/1024)+' GB';
            const type = os.type();
            //const osVersion = os.version()
            //const machine = os.machine();
            this.logger.logEvent( {message:'os info',platform,arch,type,release,mem})
            
            this.setupCrashReporting()

            this.logDirectConnect()

            // the rest of the startup will be triggered once electron fires the ready event, handled by onReady()
            
        }
        catch(err) {
            this.logger.logEvent( {message:'Exception',fn:'app.checkSingleInstance()#os',error:err.message,stack:err.stack})

        }
        this.state.ready = true;    
    }

    initElectronHandlers() {

        // This method will be called when Electron has finished
        // initialization and is ready to create browser windows.
        // Some APIs can only be used after this event occurs.
        app.whenReady().then( ()=> { this.onReady()})

        // Quit when all windows are closed.
        app.on('window-all-closed', ()=> this.onWindowAllClosed())
        app.on('activate', (e,hasVisibleWindows) => this.onActive(hasVisibleWindows));

        app.on('before-quit', (e)=> this.onBeforeQuit(e))
        app.on('will-quit', (e) => this.onWillQuit(e))
        app.on('session-created', (_event,session) => this.onSessionCreated(session) )

        ipcMain.on ('app-broadcast',this.onAppBroadcast.bind(this) )
        ipcMain.on ('errorInWindow',(event,source,err)=>this.onCrash(event,source,err) )

    }

    logDirectConnect() {
        try {
            const {Bonjour} = require('bonjour-service')

            const bonjour = new Bonjour()
            this.logger.logEvent( {message:'scanning for bonjour services'})
            bonjour.find({},(service)=> {
                this.logger.logEvent( {message:'Found a bonjour service',service:JSON.stringify(service)})                
            })
        }
        catch(err) {
            this.logger.logEvent( {message:'Exception',fn:'app.logDirectConnect()',error:err.message,stack:err.stack})
        }
    }



    async onReady() {
        while (!this.state.ready) {
            await sleep(100)
        }

        this.logger.logEvent({message:'app event',event:'ready'})
        initFeaturesApp( {logger:this.logger} )           
        this.windowManager.showLoadingWindow()
        this.checkForUpdates()

    }

    async checkForUpdates() {
        // can only be called once
        if (this.state.updateCheck)
            return;

        this.logger.logEvent( {message:'update check start'})

        const updateChecker = new AutoUpdate(this,{logger:this.logger})

        // Handle callback for user clicking on "Skip Update" in Loading screen
        ipcMain.once ('update-skip',()=> { 
            try {
                updateChecker.skipUpdate(); // inform update checker to skip download
                this.logger.logEvent( {message:'button clicked',button:'Install later',eventSource:'user'})
                this.windowManager.setLoading()
                this.windowManager.createMainWindow()    
            }catch(err) {
                console.log(err)
            }

        })

        this.state.updateCheck = 'active'        
        this.windowManager.setChecking();

        if (process.env.LOADER_DEBUG) {
            this.windowManager.setUpdating()
            const sleep = (ms) => new Promise( done=> setTimeout(done,ms    ))
            await sleep(50000)
        }

        const checkResult = await updateChecker.checkForUpdates()
        if (checkResult.available) {
            this.logger.logEvent( {message:'update check done', available:true})
            this.windowManager.setUpdating()
            updateChecker.once('app-relaunch', ()=>{ this.quit()})
        }
        else {
            this.logger.logEvent( {message:'update check done', available:checkResult.available, isTimeout:checkResult.timeout})
            this.windowManager.setLoading()
            this.windowManager.createMainWindow()
        }

    }


    setupCrashReporting() {
        const submitURL = this.getLoggingUrl().replace('/log','/crash')
        crashReporter.start({ 
            submitURL,
            uploadToServer: true,   
            compress:true                       
        });
        crashReporter.addExtraParameter('uuid',this.settings.uuid)
        crashReporter.addExtraParameter('appVersion',version)
    }



    logUnhandledError(err) {
        // shielding with try/catch to avoid loops due to exceptions in log library
        try {
        
            if (!electron || !electron.incyclistApp || !electron.incyclistApp.logger)
                console.error('+++++++++++++++++++++++++++++++++',err); 
            else     
                this.logger.logEvent( {message: 'unhandled exception', error:err.message, stack: err.stack})
    
        }
        catch { }
    
    }

    onCrash(_event,_source,err) {
        this.logger.logEvent( {message:'crash in main window',event:'error',error:err.message,stack:err.stack})
    }

    initBasicLogging() {
        this.logger = new EventLogger(APP_NAME);
        this.logger.setGlobal({appVersion:version,session:this.session})
        this.appVersion = version;
        this.appName = name;
        this.restLogFilter = restLogFilter;
        this.restAdapter = undefined;

        // Already register console adapter so that we could monitor loadSettings()
        let fileName = path.join(getLogDirectory(),'./logfile.json')
        deleteFile(fileName)

        this.consoleAdapter = new ConsoleAdapter({depth:1})        
        const fileAdapter = new FileAdapter({name: fileName,depth:1})
        EventLogger.registerAdapter(this.consoleAdapter,fileLogFilter);
        EventLogger.registerAdapter(fileAdapter,fileLogFilter);   
        this.EventLogger = EventLogger;

        const logUnhandledError = this.logUnhandledError.bind(this)
        unhandled({  logger: logUnhandledError, showDialog: false});             

    }

    getLoggingUrl() {
        let logSettings  = {}

        if ( this.settings.logRest!==undefined) 
            logSettings = JSON.parse(JSON.stringify((this.settings.logRest)));

        if (logSettings.url)
            return logSettings.url

        return AppSettings.DEFAULT_SETTINGS.logRest.url;
    }

    initRestLogging() {
        this.logger.logEvent({message:'setting up REST logging',config:this.settings.logRest})
        if ( this.settings.logRest===undefined || this.settings.logRest.enabled===undefined || this.settings.logRest.enabled!==false ) {
            try {
                let settings  = {}
                if ( this.settings.logRest!==undefined) 
                    settings = JSON.parse(JSON.stringify((this.settings.logRest)));
                settings.url = this.getLoggingUrl()
                this.restAdapter = new RestLogAdapter(settings);
                this.logger.logEvent({message:'REST logging initialized',settings})
                EventLogger.registerAdapter(this.restAdapter, restLogFilter)
            }
            catch(error) {
                this.logger.logEvent({message:'error',error:error.message})

                
            }
        }
        else {
            this.logger.log('REST logging disabled')

        }

    }

    getLogger() {
        return this.logger;
    }
    getRestAdapter() {
        return this.restAdapter;
    }

    setAdapterDepth(adapter, depth) {
        if ( adapter && adapter.props)
            adapter.props.depth = depth;
    }


    initUser() {

        const appSettings = AppSettings.getInstance()

        if ( this.settings.uuid===undefined) {

            let uuid = appSettings.getUuidFromFile();
            let recovered, created
            if (!uuid || uuid==='undefined') {

                uuid = gnerateUUID();
                created = Date.now();
                    
            }
            else {
                recovered = Date.now();
            }

            if (uuid) {
                appSettings.updateSettings({uuid,recovered,created})
                appSettings.writeUuidToFile(uuid);
                this.settings.uuid = uuid;
            }
        }
        else {
            let uuid = appSettings.getUuidFromFile();
            if (!uuid)
                appSettings.writeUuidToFile(this.settings.uuid);
        }
        this.logger.setGlobal({uuid:this.settings.uuid})
    }



    emit(event,...args) {
        this.emitter.emit(event,...args)
    }

    verifyDirectory(p) {
        this.logger.logEvent({message:'verifyDirectory',path:p})
        if (p===undefined || p=='')
            return false;
    
        p = p.replace('/','');
        p = p.replace('\\','');
    
        let dir =  path.join(app.getPath('appData'),'/'+this.getName()+'/'+p);
    
        return checkDir(dir)
    }  


    onActive(hasVisibleWindows) {
        this.logger.logEvent({message:'app event',event:'active'})

        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (!hasVisibleWindows)
            this.windowManager.createMainWindow()
    
    }

    onWindowAllClosed() {
        // On macOS it is common for applications and their menu bar
        // to stay active until the user quits explicitly with Cmd + Q
        this.logger.logEvent({message:'app event',event:'window-all-closed'})

        if (this.windowManager.hasMainWindow()){
            this.windowManager.closeMainWindow()
            this.enableScreensaver();
            
        }
        app.quit();
    }


    disableScreensaver() {
        if ( powerSaveBlocker==undefined)
            return;
        this.logger.log("disabling screensaver");
        this.powerSaveBlockerID = powerSaveBlocker.start('prevent-display-sleep')  
    }

    enableScreensaver() {
        if ( powerSaveBlocker!=undefined  &&  this.powerSaveBlockerID!=undefined) {
            this.logger.log("re-enabling screensaver");

        if (powerSaveBlocker.isStarted( this.powerSaveBlockerID))
            powerSaveBlocker.stop( this.powerSaveBlockerID)    
        }
    }

    async onBeforeQuit(e) {
        
        this.logger.logEvent({message:'app event',event:'before-quit'})
        this.willQuit = true;        
        e.preventDefault();
        try {
            await RestLogAdapter.getInstance().flush();
        } catch  {}
        this.quit();

    }

    onWillQuit(e) {
        
        this.logger.logEvent({message:'app event',event:'will-quit'})
        e.preventDefault();
        this.quit();
            
    }

    async quit() {

        if (this.state.isQuitting)
            return;

        this.logger.logEvent({message:'quitting app'})

        this.state.isQuitting=true;
        setTimeout( ()=>{process.exit(); },2000)

        try {
            if ( process.env.DEBUG) this.logger.logEvent({message:'flushing adapters'})
            if ( this.restAdapter!==undefined)
                await this.restAdapter.flush();

            // Unregister all shortcuts.
            if ( process.env.DEBUG) this.logger.logEvent({message:'unregistering shortuts'})
            globalShortcut.unregisterAll()

            if ( process.env.DEBUG) this.logger.logEvent({message:'re-enabling screensaver'})
            this.enableScreensaver();

            if ( process.env.DEBUG) this.logger.logEvent({message:'app.quit'})
            app.quit();

            if ( process.env.DEBUG) this.logger.logEvent({message:'teminate process'})
            process.exit();

        }
        catch(err) {
            this.logger.logEvent({message:'quit Exception',eror:err.message,stack:err.stack}) 
        }

    }

    onSessionCreated(session) {
        this.logger.logEvent({message:'app event',event:'session-created',session})
        this.logger.setGlobal({session:this.session})
    }

    onAppLoaded() {
        this.logger.logEvent({message:'incyclist event',event:'app-loaded',debug:process.env.DEBUG_BUILD});
        this.windowManager.showMainWindow()
    }

    onAppLoadFailed() {
        this.logger.logEvent({message:'incyclist event',event:'app-load-failed'});
        // TODO
    }

    onAppReload() {
        this.logger.logEvent({message:'incyclist event',event:'app-reloaded'});
        this.windowManager.showLoadingWindow()
    }

    onAppQuit() {
        this.logger.logEvent({message:'incyclist event',event:'app-quit'});
        this.quit();
    }

    onAppBroadcast(event,args) {
        this.logger.logEvent({message:'incyclist app event',event,args});
        if ( args!==undefined) {
            this.sendBroadcast(args);
        }
    }

    sendBroadcast(event) {
        this.logger.logEvent({message:'sending Broadcast',event, ready:(this.getMainWindow()!==undefined)});
        this.windowManager.sendMainWindowEvent('app-event',event)
    }

    showAuthWindow(provider) {
        this.windowManager.createAuthWindow(provider)
       
    }

    onOAuthLoaded(provider) {
        this.logger.logEvent({message:'incyclist event',event:'outh-loaded',provider});
        this.windowManager.showAuthWindow(provider)
    }

    onOAuthLoadFailed(provider) {
        this.logger.logEvent({message:'incyclist event',event:'outh-load-failed',provider});
        this.windowManager.closeAuthWindow(provider)
    }

    onOAuthQuit(provider, sendBroadcast=true) {
        this.logger.logEvent({message:'incyclist event',event:'outh-quit',provider});
        this.windowManager.closeAuthWindow(provider)
        if (sendBroadcast)
            this.sendBroadcast({auth_window_closed:true})
    }

    getName() {
        return APP_NAME;
    }

    getVersion() {
        return APP_VERSION
    }

    getSession() {
        return this.session;
    }

    getSettings() {
        return this.settings;
    }



    getWindowManager() {
        return this.windowManager;
    }

    getMainWindow() {
        return this.windowManager.getMainWindow()
    }


    /* 
        whenever we introduce a new feature in the app, the react apps can verify that the feature is supported by the app
        This allows the react app to disable certain functionality if running in an older app whihc does not support a certain feature
     */
    initFeatures() {
        this.features = {
            localFileRender: true,
            getShell: true,
            getPath: true
//            selectDirectory: true,
//            gotoFile: true,
        }
    }
    
    supportsFeature( featureName) {
        return this.features[featureName];
    }
} 


module.exports = IncyclistApp;