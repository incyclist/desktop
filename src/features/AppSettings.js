const { ipcMain, app } = require('electron')
const { getAppDirectory,checkDir,deleteFile, getSourceDir } = require ('../utils/index.js')
const { ipcCall, ipcCallSync, ipcHandleSync, ipcResponse } = require('./utils/index.js')
const { EventLogger } = require( 'gd-eventlog')
const path = require('path')
const os = require('os');
const fs = require('fs')
const { getSecret } = require('../modules/secrets.js')

const SAVE_INTERVAL = 3000;
const DEFAULT_LOG_SERVER_URL = process.env.ENVIRONMENT=='dev' ? 'https://localhost:5000/api/v1/log' :'https://analytics.incyclist.com/api/v1/log';
const DEFAULT_SETTINGS = {
    logRest: {
        url: DEFAULT_LOG_SERVER_URL,
        cacheDir: os.tmpdir()
    }
}


const getAppInfo = () => {
    let res;
    try {
        const version = app.incyclistApp.appVersion
        const name = app.incyclistApp.appName
        const sourceDir = getSourceDir()
        const session = app.incyclistApp.session
        const appDir = getAppDirectory()
        const tempDir = os.tmpdir()
        res = {name,version,session, sourceDir,appDir,tempDir}
    }
    catch {
        console.log('~~~~ ERROR ',err)
    }
    return res

}


class AppSettings {

    static  _instance = undefined;

    static getInstance() {
        if ( !AppSettings._instance ) {
            AppSettings._instance = new AppSettings()
        }
        return AppSettings._instance

    }

    // for testing only
    static _setInstance( instance) {
        AppSettings._instance = instance;
    }


    constructor(props={}) {    
        this.logger = new EventLogger('AppSettings')
        this.environment  = props.environment || (process.env.ENVIRONMENT || "prod");
        this.saveQueue = {}

        this.queue = [];
        this.state = {
            saveJSONBusy: false,
            dirty: false
        }
        this.loadSettings({isInitial:true})
    }

    getOSSync() {
        let res ;

        try {
            const arch = os.arch()
            const platform = os.platform()
            const release = os.release()
        
            res= {platform, arch ,release}       
        }
        catch {}

        return res;
    }

    getOS(event,callId ) {
        const response = this.getOSSync()
    
        if ( event) {
            ipcResponse(event.sender,'appSettings-getOS',callId,response)
        }
    }
    
    
    
    getSecretValue(event,callId, key, defValue ) {
        const value = getSecret(key) || defValue;
        if ( event) {
            ipcResponse(event.sender,'appSettings-getSecret',callId,value)
        }
    }
    
        

    static getValue ( settings, key, defValue ) {
        const clone = (obj) => JSON.parse(JSON.stringify(obj));
        const valid = (v) => v!==undefined && v!==null;
        const retVal = (v) => valid(v) ? clone(v) : v;
        
        const keys = key.split('.');

        if (keys.length<2)
            return settings[key] || defValue
    
        let child = {}
        for (let index=0;index<keys.length;index++) {
            const k = keys[index];
    
            if (index==keys.length-1)
                return  retVal(child[k] || defValue);
            else { 
                child = index===0? settings[k] : child[k]
                if ( child===undefined) {
                    return retVal(defValue)
                    
                }   
            }
        
        }
    }

    static setValue( settings,key, value) {
        if ( key===undefined || key===null || key==='') {
            throw new Error('key must be specified')
        }

        const keys = key.split('.');
        if (keys.length<2) {
            settings[key] =value
            return value;
        }
    
        let child = {}
        for (let index=0;index<keys.length;index++) {
            const k = keys[index];
    
            if (index==keys.length-1) {
                child[k] = value;
                return value;
            }
            else { 
                const prev = index===0? settings : child
                child = index===0? settings[k] : child[k]
                if ( child===undefined) {
                    prev[k] = child = {}
                    
                }   
            }
        
        }


    }

    getUuidFilename() {
        try {
            const baseDir =  this.environment==='dev'  ? path.join(__dirname,'../.settings') : getAppDirectory();
            return   path.join(baseDir,'uuid')
    
        }
        catch (err) {
            this.logger.logEvent({message:'error',fn:'getUuidFilename()',error:err.message||err, stack:err.stack})
        }
        return 'settings.json';
    }

    getUuidFromFile() {
        try {
            const fileName = this.getUuidFilename();

            if (!fs.existsSync(fileName)) 
                return undefined;

            const data = fs.readFileSync(fileName)
            const uuid = data ? data.toString() : undefined
            return uuid || undefined;

        }
        catch (err) {
            this.logger.logEvent({message:'error',fn:'getUuidFromFile()',error:err.message||err, stack:err.stack})

        }
        return undefined;
        
    }

    writeUuidToFile(uuid) {
        try {
            const fileName = this.getUuidFilename();           
            fs.writeFileSync(fileName,uuid,{encoding:'utf8',flag:'w'})
        }
        catch (err) {
            this.logger.logEvent({message:'error',fn:'writeUuidToFile()',error:err.message||err, stack:err.stack})

        }
        return;

    }
    
    getSettingsFileName() {
        try {
            const baseDir =  this.environment==='dev'  ? path.join(__dirname,'../.settings') : getAppDirectory();
            return   path.join(baseDir,'settings.json')
    
        }
        catch (err) {
            this.logger.logEvent({message:'getSettingsFileName Exception',error:err.message, stack:err.stack})
        }
        return 'settings.json';
    }

    loadSettings( props={}) {
        const {passErrors,forceOverwrite,isInitial,lazy} = props;

        if (this.settings && (lazy || !forceOverwrite)) {
            return this.settings;
        }

        const fName =   this.getSettingsFileName();
        const bakName = fName+'.backup';
        let   fromBackup = false;


        this.settingsFileName = fName;

        try {
            let {json,jsonError} = this.loadFile(fName)

            if (!json||jsonError) {
                const backup = this.loadFile(bakName)
                if (!backup.json || backup.jsonError) {
                    this.settings = {}
                    this.logger.logEvent({message:'Could not load settings',settings:this.settings})
                    return this.settings;
                }
                else {
                    json = backup.json
                    fromBackup = true;
                }
            }

            this.settings = json;
            
            this.logger.logEvent({message:'settings loaded',settings:this.settings})

            if (isInitial && !fromBackup) {
                try {
                    if (fs.existsSync(bakName))
                        fs.unlinkSync(bakName)
                    fs.copyFileSync(fName,bakName)

                } catch (err) {
                    console.log('~~ERROR',err)
                }
            }
            else if (isInitial && fromBackup) {
                try {
                    if (fs.existsSync(fName))
                        fs.unlinkSync(fName)
                    fs.copyFileSync(bakName,fName)

                } catch (err) {
                    console.log('~~ERROR',err)
                }

            }


            return this.settings
    
        }
        catch (err) {
            this.settings = {}
            this.logger.logEvent({message:'load settings Exception',error:err.message||err, stack:err.stack,settings:this.settings})

        }
    }


    loadFile(fileName) {
        try {
            if (fs.existsSync(fileName)) {
                let data = fs.readFileSync(fileName)
                let str = data ? data.toString() : undefined
                if (!str) 
                    return {}


                let json = {}
                let jsonError = false;
    
                if (str.length>0) {                        
                    try {
                        json =  JSON.parse(str)
                    }
                    catch (err) {
                        this.logger.logEvent({message:'Could not load settings - parsing error',error:err.message})
                        jsonError = true;
                    }
                }
    

                return {json,jsonError};
            }
            else {
                this.logger.logEvent({message:'Could not load settings',error:'file does not exist'})
                return {}
            }
            
        }
        catch (error) {
            this.logger.logEvent({message:'Could not load settings',error:error.message})
            return{}
        }

    }



    loadJSON(fileName,defValue,props = {}) {
        if ( process.env.DEBUG) this.logger.log('loadJSON',fileName)

        const {passErrors} = props;
        let res = defValue!==undefined? defValue : {};
        
        try {
            const  {json,jsonError} = this.loadFile(fileName);
            if (!json || jsonError)
                return res;


            try {
                if ( defValue!==undefined)
                    this.merge(defValue,json)
                return json
            }
            catch(err) {
                
                if (passErrors) {
                    this.logger.logEvent({message:'JSON load error',error:err.message,str })
                    return {jsonError:err}
                }
                throw error;
            }

            return res
        }
        catch (error) {
            this.logger.logEvent({message:'JSON load error',error:error.message})
            return res
        }
    }

    async fileSync() {
        if ( this.settings && this.state.dirty ) {
            let fName =   this.getSettingsFileName();
            try {
                const success = await this.saveJSON(this.settings,fName)
                if (success)
                    this.state.dirty = false;
            }
            catch {}
        }
    }

    initFileSync() {
        if ( this.state.iv)
            return;
        this.state.iv = setInterval( ()=>{
            this.fileSync()
        }, SAVE_INTERVAL)
    }

    stopFileSync() {
        // stop interval
        if ( this.state.iv) {
            clearInterval(this.state.iv)
            this.state.iv = undefined;
        }
        // write for a final time
        this.fileSync();
    }

    async saveJSON(data,fileName) {        

        if (!this.saveQueue[fileName]) {
            this.saveQueue[fileName] = []
            this.saveQueue[fileName].push(data)
        }
        else if (this.saveQueue[fileName] && this.saveQueue[fileName].length===0) {
            this.saveQueue[fileName].push(data)
        }
        else { 
            if ( this.state.saveJSONBusy)
                this.saveQueue[fileName].push(data)
            else {
                const len = this.saveQueue[fileName].length;
                this.saveQueue[fileName][len-1] = data
            }
        }

        do {
            const d = this.saveQueue[fileName][0]
            this.saveQueue[fileName].splice(0,1);
            try {
                await this.doSaveJSON(d,fileName)
            }
            catch(err) {
                this.logger.logEvent({message:'error',fn:'saveJSON',errror:err.message||err})
            }
        }
        while (this.saveQueue[fileName].length>0)

        return true;

    }

    doSaveJSON(data,fileName) {
        if (!data)
            return;


        let dataStr;
        
            try {
                dataStr = JSON.stringify(data)
                if (this.prevDataStr && this.prevDataStr === dataStr)
                    return true;
                
            }
            catch(err) {
                return false
            }
        


        if ( process.env.DEBUG) {            
            this.logger.log('saveJSON',fileName,data)
        }


        return new Promise((resolve,reject)=>{

            if ( this.state.saveJSONBusy) {
                // TODO: queue commands
                if ( process.env.DEBUG) this.logger.log('saveJSON busy',fileName)
                return resolve(false);
            }
    
            try {
                this.state.saveJSONBusy = true;
    
                checkDir( path.dirname(fileName))
    
                let str = JSON.stringify(data,null,2)
                if ( str==='' || str=='{}')
                    return;
    
                const bakFile = fileName+'.tmp';
                if (fs.existsSync(fileName)) {
                    fs.copyFileSync(fileName,bakFile);
                }
                fs.writeFile(fileName,str,{encoding:'utf8',flag:'w'},(error)=>{
                    
                    if (error) { 
                        this.logger.logEvent({message:'JSON save error',error:error.message})
    
                        deleteFile(fileName);
                        
                        try {
                            if ( fs.existsSync(bakFile))
                                fs.copyFileSync(bakFile,fileName);
                        }
                        catch( err) {
                            this.logger.logEvent({message:'JSON save Exception',error:err.message,stack:err.stack})
                        }
                    }
                    else {
                        if ( fs.existsSync(bakFile))
                            fs.unlinkSync(bakFile);
                    }
                    this.prevDataStr = dataStr
                    this.state.saveJSONBusy = false;
                    if ( process.env.DEBUG) this.logger.log('saveJSON done',fileName)
                    resolve(true);
    
                })
            }
            catch ( err) {
                this.logger.logEvent({message:'JSON save error',error:err.message,stack:err.stack})
                this.state.saveJSONBusy = false;
                resolve(false);
            }
    
        })


    }


    merge(base,data,depth=0) {
        //this.logger.logEvent( {message:'merge()', args:{base,data,depth}})
        if (!base)
            return;
        
        try {
            for (let key in data) {
                if (typeof(data[key])==='object' && depth<4) {
                    if (base[key]!==undefined)
                        this.merge(base[key],data[key])
                    else {
                        if (data[key]===null)
                            delete base[key]
                        else 
                            base[key]= data[key]    
                    }
                }
                else {
                    if (data[key]=== null)
                        delete base[key]
                    else 
                        base[key]= data[key]
                }
            }
    
        }
        catch(error) {
            this.logger.logEvent( {message:'error',fn:'merge', args:{base,data,depth}, error})
        }
    }

    updateSettings(data) {        
        if (data!=undefined)
            this.merge(this.settings,data);

        this.save()
    }


    save() {
        this.state.dirty = true;
        this.initFileSync() 
    }

    saveRequest(event,callId,data) {
        if (event && data!=undefined)
            //this.settings = data
            this.merge(this.settings,data);
        this.save();
        if ( event) {
            ipcResponse(event.sender,'appSettings-save',callId,true)
        }
    }

    overwriteRequest(event,callId,data) {
        if (event && data!=undefined)
            this.settings = data            
        this.save();
        if ( event) {
            ipcResponse(event.sender,'appSettings-overwrite',callId,true)
        }
    }


    get(event,callId, key,  defValue) {
        if ( process.env.DEBUG) this.logger.log('appSettings-get',key||'undefined',callId,defValue||'undefined' )
        if ( !key) {
            return ipcResponse(event.sender,'appSettings-get',callId, this.settings) 
        }

        const value = AppSettings.getValue(this.settings,key,defValue)       
        ipcResponse(event.sender,'appSettings-get',callId,value)
        
    }

    set( key,value) {
        if ( !key)
            return ;

        try {
            AppSettings.setValue(this.settings,key,value)

            if ( process.env.DEBUG) this.logger.log('setValue',key,JSON.stringify(value), JSON.stringify( AppSettings.getValue(this.settings,key)) )
            this.save()
            

        }
        catch (err) {
            this.logger.logEvent({message:'set Exception',error:err.message, stack:err.stack})
        }
        
    }


   
    static register( _props) {
        
        const settings = AppSettings.getInstance();

        ipcMain.on('appSettings-get',(event,callId,key,defValue) => settings.get(event,callId,key,defValue));
        ipcMain.on('appSettings-set',(_event,_callId,key,value) => settings.set( key,value));
        ipcMain.on('appSettings-update',(_event,_callId,data) => settings.updateSettings(data));
        ipcMain.on('appSettings-save',(event,callId,values) => settings.saveRequest(event,callId,values));
        ipcMain.on('appSettings-overwrite',(event,callId,values) => settings.overwriteRequest(event,callId,values));
        ipcMain.on('appSettings-getOS',(event,callId) => settings.getOS(event,callId));
        ipcMain.on('appSettings-getSecret',(event,callId,key,defValue) => settings.getSecretValue(event,callId,key,defValue));

        ipcHandleSync('appSettings-getOSSync',()=>settings.getOSSync(),ipcMain)
        ipcHandleSync('appSettings-getAppInfo',getAppInfo,ipcMain)

   
    }

    static registerRenderer( spec, ipcRenderer) {
        const debug = process.env.DEBUG;
        spec.appSettings = {}
        spec.appSettings.get         = ipcCall('appSettings-get',ipcRenderer,{debug})
        spec.appSettings.set         = ipcCall('appSettings-set',ipcRenderer,{debug},{noResponse:true})
        spec.appSettings.update      = ipcCall('appSettings-update',ipcRenderer,{debug},{noResponse:true})
        spec.appSettings.save        = ipcCall('appSettings-save',ipcRenderer,{debug})
        spec.appSettings.overwrite   = ipcCall('appSettings-overwrite',ipcRenderer,{debug})
        spec.appSettings.getOS       = ipcCall('appSettings-getOS',ipcRenderer,{debug})
        spec.appSettings.getSecret   = ipcCall('appSettings-getSecret',ipcRenderer,{debug})

        spec.appSettings.getOSSync   = ipcCallSync('appSettings-getOSSync',ipcRenderer,{debug})
        spec.appSettings.getAppInfo  = ipcCallSync('appSettings-getAppInfo',ipcRenderer,{debug})

        spec.registerFeatures( [
            'appSettings' , 'appSettings.secret' , 'appSettings.os', 'appSettings.os.v2', 'appSettings.secret.v2', 'appSettings.appInfo', 'appSettings.overwrite',
        ] )
    }
   
        
}

AppSettings.DEFAULT_SETTINGS = DEFAULT_SETTINGS;


module.exports = AppSettings