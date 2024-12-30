const DirectConnectIpcBinding = require('./ipc-binding')
const {ipcMain,app} = require('electron');
const {EventLogger } = require('gd-eventlog');
const {ipcSendEvent, ipcCallSync, ipcRegisterBroadcast, ipcHandleSync} = require ('../utils')
const Feature = require('../base')
const { Bonjour } = require('bonjour-service')
const net = require('net');


class DirectConnectSupport extends Feature{

    static _instance;

    constructor() {
        super()
        this.requests = [];
        this.writeStreams = [];      
        this.logger = new EventLogger('DirectConnect')  
        this.bonjour = undefined   
    }

    static getInstance() {
        if (!DirectConnectSupport._instance)
            DirectConnectSupport._instance = new DirectConnectSupport()
        return DirectConnectSupport._instance;
    }

    connect() {
        if (!this.bonjour) {
            this.bonjour = new Bonjour()
        
            this.logger.logEvent( {message:'Connect to bonjour '})
        }
        return true;
    }

    disconnect() {
        if (this.bonjour) {
            this.logger.logEvent( {message:'Disconnect from bonjour '})
            this.bonjour.destroy()
            this.bonjour = null
        }
        return true;
    }
    find(opts ) {
        this.bonjour.find(opts, (s)=>{ 
            this.handleAnnouncement(s) 
        })
        return true
    }       

    handleAnnouncement(service) {
        const {name,txt,port,referer,protocol,type,} = service
        const announcement = {
            type,
            name,address:referer?.address,protocol,port,
            serialNo:txt?.['serial-number'], 
            serviceUUIDs:txt?.['ble-service-uuids']?.split(',')
        }
        ipcSendEvent('mdns-message', announcement)
        
    }

    register( props) { 
        DirectConnectSupport.getInstance();

        ipcHandleSync('direct-connect-connect',this.connect.bind(this),ipcMain)
        ipcHandleSync('direct-connect-disconnect',this.disconnect.bind(this),ipcMain)
        ipcHandleSync('direct-connect-find',this.find.bind(this),ipcMain)
    }

    getBinding() {
        //return AntDevice
        return DirectConnectIpcBinding.getInstance()
    }


    registerRenderer( spec, ipcRenderer) {
        spec.dc = {}

        spec.dc.getBinding         = this.getBinding.bind(this)

        spec.dc.connect            = ipcCallSync('direct-connect-connect',ipcRenderer) 
        spec.dc.disconnect         = ipcCallSync('direct-connect-disconnect',ipcRenderer) 
        spec.dc.find               = ipcCallSync('direct-connect-find',ipcRenderer) 

        spec.registerFeatures( [
            'dc'
        ] )
        ipcRegisterBroadcast(spec.dc,'mdns-message',ipcRenderer)

        DirectConnectIpcBinding.initApi(spec.dc);
        
    }

}

module.exports = DirectConnectSupport
