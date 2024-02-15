
const {ipcMain} = require('electron');
const {EventLogger } = require('gd-eventlog');
const {ipcCall,ipcServe} = require ('../utils')
const Feature = require('../base')
const {scan} = require('./Network')


// singleton pattern
class NetworkFeature extends Feature{
    static _instance;


    constructor(props = {}) {
        super(props)
        this.logger = new EventLogger('network')
    } 

    static getInstance() {
        if (!NetworkFeature._instance) {
            NetworkFeature._instance = new NetworkFeature()
        }
        return NetworkFeature._instance
    }


    register(_props) {
        ipcMain.on('network-scan',(channel,callId,port) => { ipcServe( channel,callId,'network-scan', ()=>scan(port))})
    }

    registerRenderer( spec, ipcRenderer) {
        spec.network = {}
        spec.network.scan    = ipcCall('network-scan',ipcRenderer)        

        spec.registerFeatures( [
            'network.scan' 
        ] )
    }


}

module.exports = NetworkFeature