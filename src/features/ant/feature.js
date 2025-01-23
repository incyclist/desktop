const {ipcMain,app} = require('electron');
const {EventLogger } = require('gd-eventlog');
const {ipcCall, ipcSendEvent, ipcCallSync, ipcCallNoResponse, ipcRegisterBroadcast, ipcHandle, ipcHandleSync, ipcHandleNoResponse} = require ('../utils')
const Feature = require('../base')
const AntIpcBinding = require('./ipc-binding')
const {AntDevice,AntServerBinding} = require('incyclist-ant-plus/lib/bindings')
//const {} = require('incyclist-ant-plus/lib/ant-device')
const os = require('os')
const path = require('path')
const fs = require('fs')

class AntFeature extends Feature{
    static _instance;


    constructor(props = {}) {
        super(props)
        this.logger = new EventLogger('ANt+')
    } 

    static getInstance() {
        if (!AntFeature._instance) {
            AntFeature._instance = new AntFeature()
        }
        return AntFeature._instance
    }

    getBinding() {
        //return AntDevice
        return AntIpcBinding
    }

    getInstanceRequest(props={}) {

        const {deviceNo,debug,loggerName, startupTimeout} = props
        const logger = new EventLogger(loggerName)

        let antServerPath

        if (os.platform()==='win32') {

            const incyclistBinaryPath = app.getPath('exe');
            const parts = path.parse(incyclistBinaryPath);
    
            if (parts.name.toLowerCase()==='incyclist') { // production binary            
                antServerPath = path.join( parts.dir, './AntServer.bin')
                this.logger.logEvent({message:'checking if Ant+Server is pre-bundled',appPath: antServerPath})                
                if ( fs.existsSync(antServerPath) ) {
                    this.logger.logEvent({message:'Ant+Server is pre-bundled'})                
                }        
                else antServerPath = undefined
            }

            if (!antServerPath && parts.name.toLowerCase()==='electron') { // dev build    
                antServerPath = process.env.ANT_SERVER || './bin/win32/AntServer.bin'
                if ( fs.existsSync(antServerPath) ) {
                    this.logger.logEvent({message:'Using Ant+Server from incyclist-ant-plus'})                
                }            
                else {
                    antServerPath = undefined
                }                
            }

            if (antServerPath) {
                this.ant = new AntServerBinding({binaryPath:antServerPath,deviceNo, debug,logger, startupTimeout})            
                return true;
            }
            this.logger.logEvent({message:'Using default binding (requiring Zadig)'})                

        }

        this.ant = new AntDevice({deviceNo,debug,logger, startupTimeout})
        return true;
    }

    async openRequest() {
        if (!this.ant) {
            return false;
        }
        const opened = await this.ant.open()
        return opened;
    }

    async closeRequest() {
        if (!this.ant) {
            return false;
        }
        const opened = await this.ant.close()
        return opened;
    }

    getMaxChannelsRequest() {
        return this.ant ? this.ant.getMaxChannels() : undefined
    }

    getChannelRequest() {
        let channelNo = null;
        if (this.ant) {
            const channel = this.ant.getChannel()
            if (channel===undefined || channel==null) {
                return;
            } 
            channelNo = channel.getChannelNo()

            // message needs to be forwarded to renderer
            channel.onMessageOriginal = channel.onMessage;
            channel.onMessage = (data) => {

                channel.onMessageOriginal(data)
                ipcSendEvent('ant-message', channelNo, data.toString('hex'))
            }
        }
        return channelNo
    }

    freeChannelRequest(channelNo) {
       const channel = this.ant.channels[channelNo]
        if (this.ant) {
            this.ant.freeChannel(channel)            
        }
        return true;   // this method actually returns a void 
    }

    getDeviceNumberRequest() {
        let res = undefined
        if (this.ant) {
            res = this.ant.getDeviceNumber();
        }
        return res;
    }

    writeRequest(hexstr) {
        const data = Buffer.from(hexstr,'hex')
        if (this.ant) {
            this.ant.write(data)
        }
    }

    register(_props) {

        ipcHandleSync( 'ant-getInstance', this.getInstanceRequest.bind(this),ipcMain)
        ipcHandle('ant-open',this.openRequest.bind(this),ipcMain)
        ipcHandle('ant-close',this.closeRequest.bind(this),ipcMain)
        ipcHandleSync('ant-getMaxChannels',this.getMaxChannelsRequest.bind(this),ipcMain )
        ipcHandleSync('ant-getChannel',this.getChannelRequest.bind(this),ipcMain)
        ipcHandleSync('ant-freeChannel',this.freeChannelRequest.bind(this),ipcMain)
        ipcHandleSync('ant-getDeviceNumber',this.getDeviceNumberRequest.bind(this),ipcMain)
        ipcHandleNoResponse('ant-write',this.writeRequest.bind(this),ipcMain)
    }

    registerRenderer( spec, ipcRenderer) {
        spec.ant = {}

        // methods that can be served by renderer
        spec.ant.getBinding         = this.getBinding.bind(this)

        // methods that have to be served by the main process
        spec.ant.getInstance        = ipcCallSync('ant-getInstance',ipcRenderer)   
        spec.ant.open               = ipcCall('ant-open',ipcRenderer)  
        spec.ant.close              = ipcCall('ant-close',ipcRenderer)  
        spec.ant.getMaxChannels     = ipcCallSync('ant-getMaxChannels',ipcRenderer) 
        spec.ant.getChannel         = ipcCallSync('ant-getChannel',ipcRenderer) 
        spec.ant.freeChannel        = ipcCallSync('ant-freeChannel',ipcRenderer)   
        spec.ant.getDeviceNumber    = ipcCallSync('ant-getDeviceNumber',ipcRenderer) 
        spec.ant.write              = ipcCallNoResponse('ant-write',ipcRenderer)  

        // register events that are sent by the handlers from main process to renderer usin ipcSendEvent(<key>,...args)
        // renderer can handle them in <api>.onMessage(<key>,....args)
        ipcRegisterBroadcast(spec.ant,'ant-message',ipcRenderer)

        // The IPC binding will make use of this apo, so we need to register it there
        AntIpcBinding.init(spec.ant);


        spec.registerFeatures( [
            'ant', 'ant-flush'
        ] )
    }


}

module.exports = AntFeature