const request = require( 'request')
const fs = require ( 'fs');
const {promises} = require ( 'fs');
const promiseFs = promises
const path = require('path')
const Feature = require('../base');
const {checkDir} = require('../../utils')
const {ipcMain,app} = require('electron');
const {ipcCall, ipcSendEvent, ipcCallSync, ipcCallNoResponse, ipcRegisterBroadcast, ipcHandle, ipcHandleSync, ipcHandleNoResponse} = require ('../utils');
const EventEmitter = require('events');
const IpcWriteStream = require('./write-stream');




class FileSystemSupport extends Feature{

    static _instance;

    constructor() {
        super()
        this.requests = [];
        this.writeStreams = [];        
    }

    static getInstance() {
        if (!FileSystemSupport._instance)
            FileSystemSupport._instance = new FileSystemSupport()
        return FileSystemSupport._instance;
    }

    // -----------------------------------------------------
    // Ipc Server side (main process)
    // -----------------------------------------------------

    createWriteStream(path, options) {
        try {
            const id = Date.now()

        
            const stream = fs.createWriteStream(path,options)       
            const events = ['error','close','drain','finish','cork']
            events.forEach( e=> {
                stream.on(e, (...args) => {this.emitWriteStreamEvent(id,e,...args)})
            } )
            //TODO: pipe,unpipe
            
            this.writeStreams.push( {id,stream})
            return id;
    
        }
        catch(err) {
            console.log('~~~ ERROR',err)
            return null;
        }

    }

    getStream( id) {
        return this.writeStreams.find( ws => ws.id===id)
    }

    delete(id) {
        const idx = this.writeStreams.findIndex( ws => ws.id===id)
        this.writeStreams.splice(idx,1)
    }

    writeStreamWrite(id, ...args) {
        //console.log('~~~writeStreamWrite',id, this.getStream(id)!==undefined, ...args)
        const ws = this.getStream(id);
        if (!ws) { 
            //console.log('~~~ return false',ws )
            return false;
        }

        return ws.stream.write(...args)
    }

    writeStreamEnd(id, ...args) {
        const ws = this.getStream(id);
        if (!ws) return;
        ws.stream.end(...args)
    }

    writeStreamClose(id, ...args) {
        const ws = this.getStream(id);
        if (!ws) return false;

        this.delete(id)
        return ws.stream.close(...args)
    }
    writeStreamDestroy(id, ...args) {
        const ws = this.getStream(id);
        if (!ws) return false;

        this.delete(id)

        return ws.stream.destroy(...args)
    }
    emitWriteStreamEvent(id,event, ...args) {
        ipcSendEvent( 'fs-ws-message',id,event,...args);
    }

    register( props) {
        ipcHandle('fs-write-file',promiseFs.writeFile,ipcMain)
        ipcHandle('fs-read-file',promiseFs.readFile,ipcMain)
        ipcHandle('fs-append-file',fs.appendFile,ipcMain)
        ipcHandleSync('fs-existsSync',fs.existsSync,ipcMain)
        ipcHandleSync('fs-checkDir',checkDir,ipcMain)
        ipcHandle('fs-unlink',promiseFs.unlink,ipcMain)

        ipcHandleSync('fs-createWriteStream', this.createWriteStream.bind(this), ipcMain )
        ipcHandleNoResponse('fs-ws-write', this.writeStreamWrite.bind(this), ipcMain)
        ipcHandleNoResponse('fs-ws-end', this.writeStreamEnd.bind(this), ipcMain)
        ipcHandle('fs-ws-close', this.writeStreamClose.bind(this), ipcMain)
        ipcHandle('fs-ws-destroy', this.writeStreamDestroy.bind(this), ipcMain)

        ipcHandleSync('fs-path-parse',path.parse,ipcMain)
        ipcHandleSync('fs-path-join',path.join,ipcMain)
    }


    // -----------------------------------------------------
    // Ipc client side (renderer process)
    // -----------------------------------------------------

    createIpcStream(path,options) {
        const ipc = new IpcWriteStream(path,options)
        const id = ipc.id
        this.writeStreams.push( {id,ipc});

        return ipc;
    }

    onWriteStreamEvent(id,event,...args) {
        const ws = this.getStream(id);
        if (!ws || !ws.ipc) return 
        ws.ipc.emit(event,...args)
    }


    registerRenderer( spec, ipcRenderer) {
        spec.fs = {}

        spec.fs.writeFile               = ipcCall('fs-write-file',ipcRenderer) 
        spec.fs.readFile                = ipcCall('fs-read-file',ipcRenderer) 
        spec.fs.appendFile              = ipcCall('fs-append-file',ipcRenderer) 
        spec.fs.existsSync              = ipcCallSync('fs-existsSync',ipcRenderer) 
        spec.fs.checkDir                = ipcCallSync('fs-checkDir',ipcRenderer) 
        spec.fs.unlink                  = ipcCall('fs-unlink',ipcRenderer)        

        spec.fs.createWriteStream       = this.createIpcStream.bind(this)

        spec.fs.writeStream = {}
        spec.fs.writeStream.create      = ipcCallSync('fs-createWriteStream',ipcRenderer)        
        spec.fs.writeStream.write       = ipcCallNoResponse('fs-ws-write',ipcRenderer)        
        spec.fs.writeStream.end         = ipcCallNoResponse('fs-ws-end',ipcRenderer)        
        spec.fs.writeStream.close       = ipcCall('fs-ws-close',ipcRenderer)        
        spec.fs.writeStream.destroy     = ipcCall('fs-ws-destroy',ipcRenderer)               

        ipcRegisterBroadcast(spec.fs.writeStream,'fs-ws-message',ipcRenderer)
        spec.fs.writeStream.onMessage( this.onWriteStreamEvent.bind(this) )

        IpcWriteStream.init(spec.fs.writeStream)
        

        spec.path = {}
        spec.path.parse               = ipcCallSync('fs-path-parse',ipcRenderer) 
        spec.path.join                = ipcCallSync('fs-path-join',ipcRenderer) 
        spec.registerFeatures( [
            'fileSystem','fileSystem.stream','fileSystem.unlink'
        ] )

    }

}






module.exports = FileSystemSupport

