const IpcDownloadSession = require('./ipc-download-session')
const DownloadSession = require('./download-session')
const Feature = require('../base');
const {ipcMain} = require('electron');
const {ipcCallSync, ipcCallNoResponse, ipcRegisterBroadcast, ipcHandleSync, ipcHandleNoResponse} = require ('../utils')

class DownloadManager extends Feature{

    static _instance;

    constructor() {
        super()
        
        // no need to have two different objects (server vs. client side), as the whole class will have two different instances (1x main process, 1x renderer)
        this.sessions = [];
        
    }

    static getInstance() {
        if (!DownloadManager._instance)
            DownloadManager._instance = new DownloadManager()
        return DownloadManager._instance;
    }

    // -----------------------------------------------------
    // Ipc Server side (main process)
    // -----------------------------------------------------

    createServerSession(id,url,fileName,props) {
        const dl = new DownloadSession(id,url,fileName,props)
        
        this.sessions.push( {id,dl});

        return id;
    }

    sessionStart(id) {
        const si = this.sessions.find( si => si.id===id)
        if (!si || !si.dl )
            return;
        
        const session = si.dl;
        session.start();

    }

    sessionStop(id) {
        const idx = this.sessions.findIndex( si => si.id===id)
        const si = idx!==-1 ? this.sessions[idx] : undefined;

        if (!si || !si.dl )
            return;
        
        const session = si.dl;
        session.stop();

        this.sessions.splice(idx,1)
    }


    register( props) {
        ipcHandleSync('dl-mgr-create', this.createServerSession.bind(this), ipcMain)
        ipcHandleNoResponse('dl-mgr-start', this.sessionStart.bind(this), ipcMain)
        ipcHandleNoResponse('dl-mgr-stop', this.sessionStop.bind(this), ipcMain)
    }


    // -----------------------------------------------------
    // Ipc client side (renderer process)
    // -----------------------------------------------------

    createSession(id,url,fileName,props) {
        const ipc = new IpcDownloadSession(id,url,fileName,props)
        this.sessions.push( {id,ipc});

        return ipc;
    }

    onSessionEvent(id,event,...args) {
        const ds = this.sessions.find( si => si.id===id)
        if (!ds || !ds.ipc) return 
        ds.ipc.emit(event,...args)
    }


    registerRenderer( spec, ipcRenderer) {
        spec.downloadManager = {}       
        spec.downloadManager.createSession = this.createSession.bind(this)

        spec.downloadManager.session = {}
        spec.downloadManager.session.create = ipcCallSync('dl-mgr-create',ipcRenderer)        
        spec.downloadManager.session.start = ipcCallNoResponse('dl-mgr-start',ipcRenderer)        
        spec.downloadManager.session.stop = ipcCallNoResponse('dl-mgr-stop',ipcRenderer)        

        ipcRegisterBroadcast(spec.downloadManager.session,'dl-mgr-session-event',ipcRenderer)
        spec.downloadManager.session.onMessage( this.onSessionEvent.bind(this) )

        IpcDownloadSession.init(spec.downloadManager.session)  

    }


}


module.exports = DownloadManager

