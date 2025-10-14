const EventEmitter = require('node:events');

class MDNSBinding {
    
    constructor(api) {
        this.api = api
        this.emitter = new EventEmitter();
        this.api.onMessage( (announcement) => { 
            this.emitter.emit('announcement', announcement) 
        })
    }
    connect() {
        return this.api.connect()  
        
    }

    disconnect() {
        return this.api.disconnect()  
    }

    find(opts , callback) {

        this.api.find(opts)        
        this.emitter.on('announcement', callback)
        
    }       

}
class DirectConnectIpcBinding {
    static _instance

    static api
    static net

    static getInstance() {
        if (!DirectConnectIpcBinding._instance)
            DirectConnectIpcBinding._instance = new DirectConnectIpcBinding()
        return DirectConnectIpcBinding._instance
    }

    static initApi ( api) {
        DirectConnectIpcBinding.api = api;

        this.getInstance().mdns = new MDNSBinding(api)  
        this.getInstance().net = DirectConnectIpcBinding.net

        
    }
    static initNet ( net) {
        DirectConnectIpcBinding.net = net;

        this.getInstance().mdns = DirectConnectIpcBinding.api
        this.getInstance().net = net
    }


    constructor() { 
        this.mdns = undefined
    }

}



module.exports = DirectConnectIpcBinding