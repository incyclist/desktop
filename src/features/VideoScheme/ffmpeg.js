const AppSettings = require('../AppSettings')
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const os = require('os')
const path = require('path')
const {EventLogger} = require( 'gd-eventlog');
const {getAppDirectory,checkDir} = require('../../utils');

const DEFAULT_UPDATE_SERVER_URL_DEV  = 'http://localhost:4000';
const DEFAULT_UPDATE_SERVER_URL_PROD = 'https://updates.incyclist.com';
const DEFAULT_UPDATE_SERVER_URL = process.env.ENVIRONMENT=='dev' ? DEFAULT_UPDATE_SERVER_URL_DEV : DEFAULT_UPDATE_SERVER_URL_PROD;

const server = DEFAULT_UPDATE_SERVER_URL;
const info = `${server}/ffmpeg/info`

class FFMpegSupport {
    static _instance = null;

    constructor() {
        this.updateBusy = false;
        this.logger = new EventLogger('ffmpeg')
        this.settings = {}
    }

    static getInstance() {
        if ( FFMpegSupport._instance===null)
            FFMpegSupport._instance = new FFMpegSupport();

        return FFMpegSupport._instance;
    }

    setPath() {
        if ( this.settings.path ) {
            ffmpeg.setFfmpegPath(this.settings.path);
        }

    }

  

    init() {
        this.settings  = AppSettings.getValue(AppSettings.getInstance().settings,'ffmpeg',{})       

        this.setPath();        
        const currentVersion = this.settings.version;
        const activity = currentVersion ? 'update' : 'version'
        this.logger.logEvent({message:`checking for ffmpeg ${activity}`})
        axios.get(info)
            .then((response)=>{
                const newVersion = response.data.release;
                
                if ( newVersion && (currentVersion===undefined || (currentVersion!==newVersion && currentVersion<newVersion) ) ){
                    this.download(newVersion)
                }
                else {
                    this.logger.logEvent({message:'no update available'});
                }
                return newVersion;
            })
            .catch((err)=>{
                this.logger.logEvent({message:'checking for ffmpeg error', error:err.message})
            })

    }

    getName(headers) {
        if (!headers || !headers['content-disposition'])
            return undefined;

        let fileName =  headers['content-disposition'].split('filename=')[1];
        fileName = fileName.replace(/\"/g, '')
        return fileName
    }

    download(version) {
        
        this.updateBusy = true;
        this.logger.logEvent({message:'start downloading version',ffmpegVersion:version});

        return new Promise( (resolve,reject) => {
            const platform = os.platform();
            const arch = os.arch();
            const downloadUrl = `${server}/ffmpeg/download/${platform}/${arch}`
            
            const defaultName = platform==='win32' ? 'ffmpeg.exe' : 'ffmpeg';
    
            axios.get( downloadUrl, {responseType: 'stream'}).then( response => {
                
                const name = this.getName(response.headers) || defaultName;          
                const binDir = path.join(getAppDirectory(), `./bin`)
                const fullPath = path.join( binDir, `./${name}`)
                
                checkDir(binDir);

                this.logger.logEvent({message:'download success - saving version',ffmpegVersion:version});
                
                const writer = fs.createWriteStream(fullPath)
                response.data.pipe(writer);
    
                let error = undefined;
    
                writer.on('error', err => {
                    writer.close();
                    reject(err);
                    this.logger.logEvent( {message: 'error', err: err.message,stack: err.stack})
                  });
                  writer.on('close', () => {
                    if (!error) {
                        if ( platform!=='win32')
                            fs.chmodSync(fullPath,'755')
    
                        this.settings.path = fullPath
                        this.settings.version = version;
                        AppSettings.getInstance().updateSettings({ffmpeg:this.settings});
                        this.setPath();        

                        resolve(true);
                        this.logger.logEvent({message:'saving success',ffmpegVersion:version});
                    }

                    else {
                        this.logger.logEvent({message:'saving error',ffmpegVersion:version, error:error.message||error});
                    }
                    //no need to call the reject here, as it will have been called in the
                    //'error' stream;
                  });
            })
            .catch(err => {
                this.logger.logEvent( {message: 'error', err: err.message,stack:err.stack})
                reject(err);
            })
            .finally( ()=> {
                this.updateBusy = false;
            })    
           
        })
    }

    getPath() {
        return this.settings.path;
    }

    isSupported() {
        if (process.env.FFMPEG_PATH)
            return true;
        return this.settings.path!==undefined && this.settings.path!==null;
    }

    async checkFormats() {
        return new Promise( resolve => {

            ffmpeg.getAvailableFormats(function(err, formats) {
                resolve (!err && formats)                
            })
        })
    }
 

    async ready() {

        let hasFormats = await this.checkFormats()
        if (!hasFormats) {

            try {
                await this.download(this.settings.version)
                hasFormats = await this.checkFormats()
            }
            catch(err) {
                hasFormats = false;
            }

            if (!hasFormats) {
                return resolve(false)
            }
        }

        return new Promise( resolve => {


            if ( !this.updateBusy) {
                return resolve(true);
            }

            const iv = setInterval( ()=> {
                if ( !this.updateBusy) {
                    clearInterval(iv)
                    resolve(true)
                }
                
            },100)
        }) 
    }
}


module.exports = FFMpegSupport;