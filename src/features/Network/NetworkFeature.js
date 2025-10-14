
const {ipcMain} = require('electron');
const {EventLogger } = require('gd-eventlog');
const {ipcCall,ipcServe,ipcCallSync,ipcHandleSync,ipcSendEvent, ipcRegisterBroadcast} = require ('../utils')
const Feature = require('../base')
const {scan} = require('./Network')
const IpcSocketBinding = require('./ipc-socket');
const DirectConnectIpcBinding = require('../direct-connect/ipc-binding');
const {Socket} = require('node:net');

// singleton pattern
class NetworkFeature extends Feature{
    static _instance;

    static api
    
    constructor(props = {}) {
        super(props)
        this.logger = new EventLogger('network')
        this.sockets = {}
    } 

    static getInstance() {
        if (!NetworkFeature._instance) {
            NetworkFeature._instance = new NetworkFeature()
        }
        return NetworkFeature._instance
    }

    static init (api) {
        this.api = api
    }

    initSocket(id) {
        const socket = new Socket()
        this.sockets[id] = {socket}

        return id
    }

    connectSocket(id, port,host) {
        const socket = this._getSocket(id)
        if (!socket)
            return null;

        socket.connect(port,host)        

        socket.on('close',(hadError) => {ipcSendEvent('network-socket-event', id, 'close',hadError)})
        socket.on('connect',() => {ipcSendEvent('network-socket-event', id, 'connect')})
        socket.on('data',(data) => {ipcSendEvent('network-socket-event', id, 'data',data.toString('hex'))})
        socket.on('drain',()=>{ipcSendEvent('network-socket-event', id, 'drain')})
        socket.on('end',()=>{ipcSendEvent('network-socket-event', id, 'end')})
        socket.on('error',(error)=>{ipcSendEvent('network-socket-event', id, 'error', error)})
        socket.on('ready',()=>{ipcSendEvent('network-socket-event', id, 'ready')})
        socket.on('timeout',()=>{ipcSendEvent('network-socket-event', id, 'timeout')})


   }

    destroySocket(id) {
        const socket = this._getSocket(id)
        if (!socket)
            return;

        socket.on('close',()=>{
            ipcSendEvent('network-socket-event', id, 'close',false)
            socket.removeAllListeners()

            delete this.sockets[id]
    
        })

        socket.destroy()

    }

    writeSocket(id, data) {
        const socket = this._getSocket(id)
        if (!socket)
            throw new Error('Socket not found')

        const buffer = Buffer.from(data,'hex')
        return socket.write(buffer)
    }

    register(_props) {
        ipcMain.on('network-scan',(channel,callId,port) => { ipcServe( channel,callId,'network-scan', ()=>scan(port))})

        ipcHandleSync('network-init-socket',this.initSocket.bind(this),ipcMain)
        ipcHandleSync('network-connect-socket',this.connectSocket.bind(this),ipcMain)
        ipcHandleSync('network-destroy-socket',this.destroySocket.bind(this),ipcMain)
        ipcHandleSync('network-write-socket',this.writeSocket.bind(this),ipcMain)   

    }

    
    _getSocket(id) {
        const {socket} = this.sockets[id]??{}
        return socket
    }

    registerRenderer( spec, ipcRenderer) {
        spec.network = {}
        spec.network.scan    = ipcCall('network-scan',ipcRenderer)        


        spec.network.initSocket  = ipcCallSync('network-init-socket',ipcRenderer)
        spec.network.connectSocket    = ipcCallSync('network-connect-socket',ipcRenderer)
        spec.network.destroySocket   = ipcCallSync('network-destroy-socket',ipcRenderer)
        spec.network.writeSocket   = ipcCallSync('network-write-socket',ipcRenderer)

        spec.network.createSocket  = ()=>{
            return new IpcSocketBinding(spec.network)
        }

        spec.registerFeatures( [
            'network.scan', 'network.socket'
        ] )
        
        ipcRegisterBroadcast(spec.network,'network-socket-event',ipcRenderer)

        IpcSocketBinding.init(spec.network);
        DirectConnectIpcBinding.initNet(spec.network);
    }


}

module.exports = NetworkFeature