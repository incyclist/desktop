const { ipcMain } = require("electron");
const EventEmitter = require('events');
const { ipcHandleNoResponse, ipcCallNoResponse,isTrue, ipcResponse } = require(".");

let cnt =0;

function ipcHandleObserver(key,fn, ipcMain) {

    ipcMain.on(key, (event,...args)=> {
        try {
            const observer = fn(...args)
            event.returnValue = observer?.getMessageKey();
        }
        catch (err) {
            console.log( `ERROR in IPC Handler ${key}`,err)
            event.returnValue = null;
        }
        
    } )  


}

function ipcCallObserver(key,ipcRenderer, props={}) {

    return  (...args)=> {        
        if (isTrue(props.debug) || isTrue(process.env.IPC_DEBUG) ) 
            console.log(`ipcCall: ${key} (<sync>)`)
        
        const observerKey = ipcRenderer.sendSync(key,...args);        

        if (isTrue(props.debug) || isTrue(process.env.IPC_DEBUG) ) 
            console.log(`ipcCall response: ${key} (<sync>)`, observerKey)
            const observer = new Observer(observerKey,ipcRenderer)
            return observer
      }
}

class ObserverHandler {
    static instance = undefined

    
    static getInstance(props) {
        if (!ObserverHandler.instance) {
            ObserverHandler.instance = new ObserverHandler(props);
        }
        return ObserverHandler.instance;           

    }

    constructor() {
        this.observers = {}
    }

    add(key,observer) {
        this.observers[key] = observer
        
    }
    remove(key,observer) {
        delete this.observers[key] 
    }

    stop(key) {
        const observer = this.observers[key]
        if(observer)   
            observer.stop()
    }

    register() {
        ipcHandleNoResponse('incyclist-observer-stop',this.stop.bind(this),ipcMain)
    }


}

class Observer extends EventEmitter {

    constructor(key,ipcRenderer) {
        super()
        this.key  = key;
        this.renderer = ipcRenderer
        this.onMessageHandler = this.onMessage.bind(this)

        ipcRenderer.on( key, this.onMessageHandler )
    }

    onMessage(_ipcEvent, event,...data) {
        this.emit(event,...data)
    }

    on (event,cb) { 
        super.on(event,cb); 
        return this 
    }

    off (event,cb) { 
        super.off(event,cb); 
        return this 
    }

    once (event,cb) { 
        super.once(event,cb); 
        return this 
    }

    stop () {         
        ipcCallNoResponse('incyclist-observer-stop', this.renderer)(this.key)        
    }

}




module.exports = {ObserverHandler,Observer, ipcCallObserver,ipcHandleObserver}
