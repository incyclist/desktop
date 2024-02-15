const EventEmitter = require('events')

class IpcWriteStream extends EventEmitter {

    static api

    static init(api) {
        IpcWriteStream.api = api;
    }

    constructor(path,options ) {
        super()

        this.initialized = false;
        this.api = IpcWriteStream.api
        this.id = this.api.create(path,options);               
    }

    async write(...args) {
        this.api.write(this.id,...args)

    }

    async end(...args) {
        this.api.end(this.id,...args)
        return this;
    }

    async close() {
        try {
            await this.api.close(this.id)
            this.emit('close')
        }
        catch {}                    
    }

}

module.exports = IpcWriteStream