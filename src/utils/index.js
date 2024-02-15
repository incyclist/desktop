const fs = require('fs');
const path = require('path');
const {app} = require('electron');
const {version,name} = require('../../package.json');
const { v4 } = require('uuid');


const gnerateUUID = () => { return v4()};

class AppInfo {

    static _instance
    static getInstance() {
        if (!AppInfo._instance)
            AppInfo._instance = new AppInfo()
        return AppInfo._instance
    }

    getAppName () {
        return name;
    }
    
    getAppDirectory (props={}) {
        let appName = getAppName()
        appName = appName.charAt(0).toUpperCase()+appName.slice(1);
    
        let dir= path.join(app.getPath('appData'),'/'+appName);
        if ( props.create || props.create===undefined) 
            checkDir(dir);
        return dir;
    }
    
    getLogDirectory() {
        let dir= path.join(getAppDirectory(),'/logs');
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir);
        }
        return dir;
    }
    getSourceDir() {
        return process.env.INCYCLIST_WEB_BUNDLE || path.join(__dirname,'..')
    }

    getPlatform () {
        if ( process.platform==='win32') {
            if (process.arch==='ia32')
                return 'win32';
            return 'win64'
        }
        
        return `${process.platform}/${process.arch}`
    }   
    
            
}





function checkDir  (p)  {
    if (p===undefined || p=='' )
        return false;

    try {
        if (!fs.existsSync(p)){
            fs.mkdirSync(p,{recursive:true});
        }
        return true;    
    }
    catch (e) {
        return false
    }
}

function deleteFile (fileName) {
    try {
        if ( fs.existsSync(fileName))
            fs.unlinkSync(fileName);    
    }
    catch (err) {
        // ignore
    }
}

function objFromError (err, filter, space) {
    var plainObject = {};
    Object.getOwnPropertyNames(err).forEach(function(key) {
      plainObject[key] = err[key];
    });
  
    return plainObject;
}

function defineLogEventMethod (logger) {
    if ( logger.logEvent===undefined) {

        logger.logEvent = (event) => {
            const message = event.message;
            delete event.message;
            logger.log( message, event)
        }
    }
    return logger;
    
}


const info = AppInfo.getInstance()

const getAppName = info.getAppName.bind(info)
const getAppDirectory = info.getAppDirectory.bind(info)
const getLogDirectory = info.getLogDirectory.bind(info)
const getSourceDir = info.getSourceDir.bind(info)
const getSourceDirectory= info.getSourceDir.bind(info)
const getPlatform = info.getPlatform.bind(info)

module.exports = {AppInfo, gnerateUUID,checkDir,deleteFile,objFromError,defineLogEventMethod,
    getAppDirectory, getAppName, getLogDirectory, getSourceDir, getSourceDirectory, getPlatform}
        

