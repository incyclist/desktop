const { EventLogger } = require("gd-eventlog");
const axios = require('axios')
const {ipcMain} =  require('electron');
const {ZipData} = require ('../zip');
const AppSettings = require('../../features/AppSettings');
const path=require('path')
const os = require('os');
const fs = require('fs');
const {rm,rename} = require('fs/promises')
const { sleep } = require("incyclist-devices/lib/utils/utils");
const EventEmitter = require("events");
const UpdaterFactory = require("./binding/factory");
const { AppInfo, checkDir } = require("../../utils");


const TIMEOUT_WEB_CHECK = 1500
const TIMEOUT_WEB_DOWNLOAD = 5000
const TIMEOUT_APP_CHECK = 3000


const DEFAULT_UPDATE_SERVER_URL_DEV  = 'http://localhost:4000';
const DEFAULT_UPDATE_SERVER_URL_PROD = 'https://updates.incyclist.com';
const DEFAULT_UPDATE_SERVER_URL = process.env.UPDATE_SERVER_URL || (process.env.ENVIRONMENT=='dev' ? DEFAULT_UPDATE_SERVER_URL_DEV : DEFAULT_UPDATE_SERVER_URL_PROD);

class AutoUpdate extends EventEmitter {

    constructor( app, props={}) {
        super();

        this.logger = props.logger || new EventLogger('AutoUpdate')

        this.app = app;
        this.settings = app.settings;
        this.loadingWindow = props.loadingWindow
        this.skipRequested = false;
        const server = this.settings.updateServerUrl || DEFAULT_UPDATE_SERVER_URL;
        this.autoUpdater = UpdaterFactory.create(server,this.logger)

    }


    async checkForUpdates() {


        const res = await Promise.allSettled( [ this.checkForAppUpdates(), this.checkForWebUpdatesNew()])

        console.log(res)
        return res[0].value


    }

    getAppTimeout() {
        return TIMEOUT_APP_CHECK
    }

    async performAppUpdateCheck() {

        try {
            if (!this.autoUpdater) {
                this.logger.logEvent ({message:'autoupdate functionality not available'})
                return { available:false }
            }

            const promise = new Promise (done=> {
                this.autoUpdater.once('app-check-done', done )
                this.autoUpdater.once('app-check-start', ()=>{} )
                this.autoUpdater.checkForUpdates().then( check => {
                    
                    if (check===null)
                        done({available:false})
    
                })
    
            })

            const timeout = sleep(this.getAppTimeout()).then( ()=>{ return { timeout:true, promise} })
        
            const res = await Promise.race( [promise, timeout])                  
            
            return res;

        }
        catch(err) {
            this.logger.logEvent( {message:'Error',fn:'performAppUpdateCheck()',error:err.message,stack:err.stack})
        }

    }

    async checkForAppUpdates() {
        this.logger.logEvent ({message:'check for app updates'})

        const res = await this.performAppUpdateCheck()
        if (res.timeout) {
            this.logger.logEvent ({message:'check for app updates result', result:'timeout'})

            if (res.promise) {
                res.promise.then(final=> {
                    if (final.available) {
                        this.updateAppForNextLaunch()
                    }    
                })
            }
        }
        else {
            this.logger.logEvent ({message:'check for app updates result', available:res.available})
            if (res.available)
                await this.updateAppForCurrentLaunch()
        }
        return res;

    }

    onAppUpdateDownloaded() {
        this.logger.logEvent( {message:'download app update finished'})

        if (this.skipRequested)        
            return;

        this.logger.logEvent( {message:'installing update'})
        this.autoUpdater.quitAndInstall()
        
    }

    skipUpdate() {
        this.skipRequested = true;
    }



    updateAppForNextLaunch() {
        this.logger.logEvent ({message:'download app update for next launch' })

        if (this.autoUpdater) {
            this.skipUpdate()
            this.autoUpdater.once('app-downloaded', ()=>{this.onAppUpdateDownloaded()})            
        }
    }

    updateAppForCurrentLaunch() {
        this.logger.logEvent ({message:'download app update' })
        if (this.autoUpdater) {
            this.autoUpdater.once('app-downloaded', ()=>{this.onAppUpdateDownloaded()})
            this.autoUpdater.once('app-quit-required', ()=>{ this.emit('app-relaunch')})
            this.autoUpdater.once('error', ( err)=>{ 
                this.logger.logEvent( {message:'app update error',error:err.message})
                this.skipUpdate()
            })
        }

    }


    getWebTimeout() {
        return TIMEOUT_WEB_CHECK
    }


    async performWebUpdateCheck() {
        if ( this.settings.pageUrl!==undefined )  
            return { available:false }

        let updateServerUrl = this.settings.updateServerUrl || DEFAULT_UPDATE_SERVER_URL;
        let url = `${updateServerUrl}/api/v1/apps/${this.app.getName()}/${this.app.getVersion()}?uuid=${this.settings.uuid}`
        this.logger.logEvent({message:'react update request',url});



        const promise = axios.get(url)
                            .then( (response) => {      
                                this.logger.logEvent({message:'react update response',data:response.data})

                                return {available:true, data:response.data } 
                            })
                            .catch(err => {
                                let message = 'react update response: error';
                                if ( err.response !==undefined) {
                                    this.logger.logEvent( {message,status:err.response.status,statusText:err.response.statusText})
                                }
                                else {
                                    this.logger.logEvent( {message,errno:err.errno,code:err.code,errmsg:err.message})
                                }
                                return {available:false}
                            })
        const timeout = sleep(this.getWebTimeout()).then( ()=>{ return { timeout:true, promise} })
        
        return Promise.race( [promise, timeout])            
    }

    async checkForWebUpdatesNew() {
        const res = await this.performWebUpdateCheck()
        if (res.timeout) {
            if (res.promise) {
                res.promise.then(final=> {
                    if (final.available) {
                        this.updateWebForNextLaunch(final.data)
                    }    
                })
            }
        }
        else {
            if (res.available)
                await this.updateWebForCurrentLaunch(res.data)
        }

        return res;
    }

    async updateWebForNextLaunch(data, props={}) {
        if ( data?.reactVersion===undefined) {
            return; 
        }


        this.logger.logEvent ({message:'install web bundle for next launch',version:data.reactVersion})

        let success = false;

        try {        
            this.processSettingsUpdate(data)

            const version = data.reactVersion
            
            const tmpPath= props.tmpPath|| this.createTempDir(version)
            const bundle = props.bundle || await this.downloadWebBundle(data)

            await this.unzip(bundle,tmpPath)           
            success = (fs.existsSync(path.join(tmpPath,'index.html')))
            if (success) {
                AppSettings.getInstance().updateSettings({pageDir:tmpPath})
                this.logger.logEvent ({message:'install web bundle for next launch completed',version:data.reactVersion, pageDir:tmpPath})
            }

        }
        catch ( err) {
            try {
                if (fs.existsSync(tmpPath))
                    await rm( tmpPath, { recursive: true, maxRetries:3, force: true })
            }
            catch {}

            this.logger.logEvent ({message:'web bundle install failed',reason:err.message, stack:err.stack})
        }        
    }

    async updateWebForCurrentLaunch(data) {
        if ( data?.reactVersion===undefined) {
            return; 
        }


        let reactPath;
        let success = false;
        const currentReactPath = this.settings.pageDir 

        try {
            this.processSettingsUpdate(data)

            const version = data.reactVersion

            const tmpPath= this.createTempDir(version)
           
            let download = this.downloadWebBundle(data)
            const dlResult = await Promise.race( [
                sleep(TIMEOUT_WEB_DOWNLOAD ).then( ()=> {return {timeout:true,download} }),
                download.then( res => ({bundle:res})).catch(err=> ({error:err}))
                
            ])

            if (dlResult.timeout) {
                download.then(res => {
                    const {bundle} = res;
                    this.updateWebForNextLaunch(data,{bundle,tmpPath})
                    return
                })
                return;
            }
            else if (dlResult.error) {
                try {
                    if (fs.existsSync(tmpPath))
                        await rm( tmpPath, { recursive: true, maxRetries:3, force: true })
                } catch {}

                reactPath = currentReactPath
                return;
            }
            else {
                await this.unzip(dlResult.bundle,tmpPath)           
                const targetPath = await this.createCleanTargetPath()
                this.logger.logEvent ({message:'rename directory',tmp:tmpPath, dir:targetPath})                        

                if (targetPath) { // we have a clean Directory
                    try {
                        await rename(tmpPath,targetPath)
                        reactPath = targetPath
                    }
                    catch(err) {
                        this.logger.logEvent ({message:'could not rename directory',reason:err.message, stack:err.stack})                        
                        reactPath = tmpPath
                        
                    }
                }
                else {
                    reactPath = tmpPath
                }
    
                success = (fs.existsSync(path.join(reactPath,'index.html')))
    
            }
                    

        }
        catch ( err) {
            this.logger.logEvent ({message:'web bundle install failed',reason:err.message, stack:err.stack})
            success = false;
            return;
        }        

        const pageDir = success ? reactPath : null;       
        this.logger.logEvent( {message:'setting pageDir',pageDir })
        AppSettings.getInstance().updateSettings({pageDir})

        if (currentReactPath && currentReactPath!==pageDir)  {
            try {
                if (fs.existsSync(currentReactPath))
                    await rm( currentReactPath, { recursive: true, maxRetries:3, force: true })
            }
            catch(err) {
                this.logger.logEvent( {message:'could not cleanup old pageDir',reason:err.message })
                
            }
        }


    }

    createTempDir(version) {
        const appDir = AppInfo.getInstance().getAppDirectory()

        try {
            let tmpPath = path.join(appDir,`./incyclist-${version}`)
            if (fs.existsSync(tmpPath))
                tmpPath = path.join(appDir,`./incyclist-${version}-${Date.now()}`)
            checkDir(tmpPath)
            return tmpPath;
        }
        catch(err) {
            return os.tmpdir()
        }

    }

    async createCleanTargetPath() {
        try {      
            const appDir = AppInfo.getInstance().getAppDirectory()
                
            const reactPath = path.join(appDir,'./react')
            if (fs.existsSync(reactPath))
                await rm( reactPath, { recursive: true, maxRetries:3, force: true })
            return reactPath
        }
        catch(err) {
            return
        }
        

    }

    async downloadWebBundle(data) {
      

        let targetVersion = data.reactVersion;
        let updateServerUrl = this.settings.updateServerUrl || DEFAULT_UPDATE_SERVER_URL;
        let url = `${updateServerUrl}/download/react/${this.app.getName()}-${targetVersion}.zip`
        this.logger.logEvent({message:'react download request',url})
        
        try {
            const response = await axios.get(url,{headers:this.axiosHeaders, responseType: 'arraybuffer'})            
            this.logger.logEvent({message:'react download response',data:response.data.length,headers:response.headers})
            return response.data
        }
        catch(err) {
            this.logger.logEvent({message:'react download error',error:err.message})           
            throw(err)
        }

    }

    async unzip(bundle,dir) {
        this.logger.logEvent({message:'unzip request',dir})
        try {
            let zip = new ZipData(bundle);
            let status = await zip.extract(dir);
            this.logger.logEvent({message:'unzip done',status,dir})
        }
        catch(err) {
            this.logger.logEvent({message:'unzip failed',error:err.message})
            throw(err)
        }

    }


    processSettingsUpdate(data) {
        if ( data?.setting!==undefined) {
            AppSettings.getInstance().updateSettings(data.setting)
        }


    }

}

module.exports = AutoUpdate