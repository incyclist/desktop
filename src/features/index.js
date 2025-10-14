const FormPost = require('./form-post').getInstance();
const FileSelection = require('./FileSelection')
const IncyclistScheme = require('./IncyclistScheme')
const VideoScheme = require('./VideoScheme').getInstance();
const NativeUI = require('./ui').getInstance()
const AppSettings = require('./AppSettings');
const SerialFeature = require('./serial/feature').getInstance();
const DownloadManager = require('./download').getInstance();
const Network = require('./Network').getInstance()
const MessageQueue = require('./mq').getInstance();
const Ble = require('./ble').getInstance()
const Ant = require('./ant').getInstance();
const Fs = require('./fs').getInstance();
const OAuth = require('./oauth').getInstance()
const Logging = require('./logging').getInstance()
const DirectConnect = require('./direct-connect').getInstance()
const Crypto = require('./crypto').getInstance()
const {ObserverHandler} = require('./utils/observer')

function initFeaturesApp( props ) {
    
    ObserverHandler.getInstance().register()

    FileSelection.register(props);
    IncyclistScheme.register(props);
    VideoScheme.register(props);
    NativeUI.register(props);
    FormPost.register(props);
    AppSettings.register(props);
    Network.register(props);
    MessageQueue.register(props);
    Ble.register(props);
    Ant.register(props);
    SerialFeature.register(props);
    Fs.register(props);
    OAuth.register(props);
    DownloadManager.register(props);
    Logging.register(props);
    DirectConnect.register(props);
    Crypto.register(props);

}


function initFeaturesWeb( electron,ipcRenderer) {

    electron.hasFeature =  (name)=>  electron[name]!==undefined || electron._features.find( f=>f.name===name)!==undefined
    electron.registerFeature = (f) => { 
        console.log('registering feature:',f); 
        electron._features.push( {name:f, supported:true})
    }
    electron.registerFeatures = (arr) => {
        if (!arr || !Array.isArray(arr))
            throw Error('Illegal Arguments: arr must be an array')
        arr.forEach ( f => electron.registerFeature(f))
    }

    electron.registerFeature('ipc-samems-fix')

    // New API
    FileSelection.registerRenderer(electron,ipcRenderer)
    IncyclistScheme.registerRenderer(electron,ipcRenderer)
    FormPost.registerRenderer(electron,ipcRenderer);
    NativeUI.registerRenderer(electron,ipcRenderer);
    VideoScheme.registerRenderer(electron,ipcRenderer);
    AppSettings.registerRenderer(electron,ipcRenderer);
    Network.registerRenderer(electron,ipcRenderer);
    MessageQueue.registerRenderer(electron,ipcRenderer);
    Ble.registerRenderer(electron,ipcRenderer);
    Ant.registerRenderer(electron,ipcRenderer);
    SerialFeature.registerRenderer(electron,ipcRenderer);
    Fs.registerRenderer(electron,ipcRenderer);
    OAuth.registerRenderer(electron,ipcRenderer);
    DownloadManager.registerRenderer(electron,ipcRenderer);
    Crypto.registerRenderer(electron,ipcRenderer);
    Logging.registerRenderer(electron,ipcRenderer);
    DirectConnect.registerRenderer(electron,ipcRenderer);


    electron.skipInstallUpdate = ()=> {
        ipcRenderer.send('update-skip')
    }

    window.appMode = true;
    window.hasElectronFeature = electron.hasFeature;
    window.electron =  electron
    window.appVersion = { major:0, minor:2, patch:2 };

    
}

module.exports = {initFeaturesWeb, initFeaturesApp}