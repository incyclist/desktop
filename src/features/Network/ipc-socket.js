const EventEmitter = require('events');


class MessageHandler extends EventEmitter{

    static getInstance(api) {
        if (!MessageHandler._instance) {
            MessageHandler._instance = new MessageHandler(api)
        }
        return MessageHandler._instance
    }

    constructor(api) {
        super()
        this.api = api 

        this.api.onMessage( (id,event,...args) => { 
            this.emit(`${id}-event`,event,...args)
        })
    }

}
 

class IpcSocketBinding extends EventEmitter {

    static socketCount = 0
    

    constructor(api) {


        super()

        this.api = api
        this.id  = IpcSocketBinding.socketCount++

        this.eventHandler = this.onEvent.bind(this)

        this.emitter = MessageHandler.getInstance(api)
        this.emitter.on(`${this.id}-event`,this.eventHandler)

        this.api.initSocket(this.id)



    }

    onEvent(event,...args) {
        if (event==='data') {
            const data = Buffer.from(args[0],'hex')

            this.emit('data',data)    
            return
        }
        this.emit(event,...args)
    }

    connect(port,host) { 
        this.api.connectSocket(this.id, port,host)
        return this
    }
    
    destroy() {
        return new Promise( (resolve,reject) => {
            this.on('error',reject)
            this.on('close',()=>{
                this.emitter.off(`${this.id}-event`,this.eventHandler)
                delete this.emitter
                resolve(this)
        
            })
    
            this.api.destroySocket(this.id)                
        })
    }
    
    write(data) { 
        const hex = Buffer.from(data).toString('hex')
        return this.api.writeSocket(this.id,hex)
    }

}

module.exports = IpcSocketBinding