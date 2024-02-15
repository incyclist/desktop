const {ipcMain} = require('electron');
const {TCPBinding} = require('incyclist-devices')
const { autoDetect } = require('@serialport/bindings-cpp')
const {IpcBinding,SerialIpcBinding,TCPIpcBinding} = require('./ipc-binding')
const Feature = require("../base");
const { EventLogger } = require('gd-eventlog');
const {ipcCall, ipcCallSync, ipcRegisterBroadcast, ipcHandle, ipcHandleSync} = require ('../utils')

class SerialFeature extends Feature{
    static _instance;


    constructor(props = {}) {
        super(props)
        this.logger = new EventLogger('Serial')

        this.isInitialized = false;
        this.bindings =  [
            {ifName: 'tcpip', native:TCPBinding, ipc: undefined},
            {ifName: 'serial', native:autoDetect(), ipc: undefined}
        ]
        this.ports = []
        
    } 

    static getInstance() {
        if (!SerialFeature._instance) {
            SerialFeature._instance = new SerialFeature()
        }
        return SerialFeature._instance
    }

    getBinding(ifName) {     
        switch (ifName) {
            case 'serial': return SerialIpcBinding
            case 'tcpip': return TCPIpcBinding
            default: return null;
        }        
    }

    getNativeBinding(ifName) {
        return this.bindings.find(i=>i.ifName===ifName)?.native
    }

    init() {  // init on main process
        if (this.isInitialized)
            return;
    }


    async list (ifName,port, excludes) {
        const binding = this.getNativeBinding(ifName)
        if (binding) {
            const ports = await binding.list(port,excludes)
            return ports;
        }
        return []            
    }
    
    async open(ifName, options) { 
        const binding = this.getNativeBinding(ifName)
        if (binding) {
            
            const port = await binding.open(options)


            const id = Date.now()
            this.ports.push( {ifName,path:options.path,port,id,isOpen:true})            
            return id
        }
        else {
            this.logger.logEvent({message:'error',fn:'open', error:'binding not found', ifName})
            
        }
        return null
    }

    isOpen(id) {
        const portInfo = this.ports.find( pi => pi.id===id )
        return portInfo?.isOpen
    }

    getPort(id) {
        const portInfo = this.ports.find( pi => pi.id===id )
        return portInfo?.port
    }



    async close(id) {
        const res = await this.getPort(id)?.close()        

        const portInfo = this.ports.find( pi => pi.id===id )
        if (portInfo)
            portInfo.isOpen = false
        return res;
    }


    async read(id,b, offset, length) {
        const buffer = Buffer.from(b)
        
        const res = await this.getPort(id)?.read(buffer,offset,length)
        return res;
    }

    async write(id,buffer) {        
        let b = buffer;
        let bufferStr;

        if (!Buffer.isBuffer(buffer)) {
            try {
                if (typeof buffer==='object')
                    bufferStr = JSON.stringify(buffer)
                else 
                    bufferStr = buffer.toString()
                b = Buffer.from(buffer)
            }
            catch(err) {}


            //this.logger.logEvent( {message:'write: buffer is not a Buffer',buffer:bufferStr,hex:b.toString('hex'), type:typeof buffer})
        }


        try {
            const res = await this.getPort(id)?.write(b)
            return res;
        }
        catch(err) {
            this.logger.logEvent( {message:'Write Failed', error:err.message, buffer:bufferStr,hex:b.toString('hex'), type:typeof buffer})
            throw err;
        }
    }

    async update(id,options) {
        const res =  this.getPort(id)?.update(options)
        return res;
    }

    async set(id,options) {
        const res =  this.getPort(id)?.set(options)
        return res;
    }

    async get(id) {
        const res =  this.getPort(id)?.get()
        return res;
    } 

    async getBaudRate(id) {
        const res =  this.getPort(id)?.getBaudRate()
        return res;

    } 
    async flush(id) {
        const res =  this.getPort(id)?.flush()
        return res;

    }

    async drain(id) {
        const res =  this.getPort(id)?.drain()
        return res;
    }



    register() {

        ipcHandle('serial-list',this.list.bind(this),ipcMain)
        ipcHandle('serial-open',this.open.bind(this),ipcMain)
        ipcHandleSync('serial-isopen', this.isOpen.bind(this),ipcMain)
        ipcHandle('serial-close',this.close.bind(this),ipcMain)
        ipcHandle('serial-read',this.read.bind(this),ipcMain)
        ipcHandle('serial-write',this.write.bind(this),ipcMain)

        ipcHandle('serial-update',this.update.bind(this),ipcMain)
        ipcHandle('serial-set',this.set.bind(this),ipcMain)
        ipcHandle('serial-get',this.get.bind(this),ipcMain)
        ipcHandle('serial-get-baudrate',this.getBaudRate.bind(this),ipcMain)
        ipcHandle('serial-flush',this.flush.bind(this),ipcMain)
        ipcHandle('serial-drain',this.drain.bind(this),ipcMain)

    }
    
    registerRenderer( spec, ipcRenderer) {
        try {
            spec.serial={}
            spec.serial.getBinding = (ifName) =>  SerialFeature.getInstance().getBinding(ifName)
        
            IpcBinding.setApi(spec.serial)
    
            spec.serial.list    = ipcCall('serial-list',ipcRenderer)
            spec.serial.open    = ipcCall('serial-open',ipcRenderer)
            spec.serial.isOpen  = ipcCallSync('serial-isopen',ipcRenderer)
            spec.serial.close   = ipcCall('serial-close',ipcRenderer)
            spec.serial.read    = ipcCall('serial-read',ipcRenderer)
            spec.serial.write   = ipcCall('serial-write',ipcRenderer)

            spec.serial.update   = ipcCall('serial-update',ipcRenderer)
            spec.serial.set     = ipcCall('serial-set',ipcRenderer)
            spec.serial.get     = ipcCall('serial-get',ipcRenderer)
            spec.serial.getBaudRate   = ipcCall('serial-get-baudrate',ipcRenderer)
            spec.serial.flush   = ipcCall('serial-flush',ipcRenderer)
            spec.serial.drain   = ipcCall('serial-drain',ipcRenderer)

            // register events that are sent by the handlers from main process to renderer usin ipcSendEvent(<key>,...args)
            // renderer can handle them in <api>.onMessage(<key>,....args)
            ipcRegisterBroadcast(spec.serial,'serial-message',ipcRenderer)

            spec.registerFeatures( [
                'serial'
            ] )
    
        }
        catch(err)  {
            console.log('~~~ ERROR',err)
        }
    }
    
}

module.exports = SerialFeature