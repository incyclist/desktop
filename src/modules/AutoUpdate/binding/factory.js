const os = require('os');

const WindowsBinding = require('./windows')
const LinuxBinding = require('./linux');

class UpdaterFactory {

    static create(serverUrl, logger) {

        const autoUpdater = UpdaterFactory.getBinding(serverUrl, logger)

        if (autoUpdater) {
            UpdaterFactory.initCallbacks(autoUpdater)
        }


        return autoUpdater
        
    }

    static getBinding(serverUrl, logger) {
        if (os.platform()==='win32')
            return  new WindowsBinding( serverUrl,logger)
        else if (os.platform()==='linux' && process.env.APPIMAGE ) 
            return new LinuxBinding(serverUrl,logger)

    }

    static initCallbacks(autoUpdater) {

        autoUpdater.impl().on('error', (err)=> {autoUpdater.emit('app-check-done',{available:false,error:err}) })
        autoUpdater.impl().on('update-downloaded', ()=>{autoUpdater.emit('app-downloaded')} )
        autoUpdater.impl().on('checking-for-update', ()=>{autoUpdater.emit('app-check-start')})
        autoUpdater.impl().on('update-available',()=> {
            
            autoUpdater.emit('app-check-done',{available:true}) 
        } )
        autoUpdater.impl().on('update-not-available', ()=> {autoUpdater.emit('app-check-done',{available:false}) })
        autoUpdater.impl().on('before-quit-for-update', ()=>{autoUpdater.emit('app-quit-required')} )
    }


}

module.exports = UpdaterFactory