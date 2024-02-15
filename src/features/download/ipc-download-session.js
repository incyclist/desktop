const EventEmitter = require('events');


class IpcDownloadSession extends EventEmitter {

    static api

    static init(api) {
        IpcDownloadSession.api = api;
    }

    constructor(id,url,fileName,props) {
        super()

        this.url = url;
        this.fileName = fileName;
        
        this.api = IpcDownloadSession.api
        this.id = this.api.create(id,url,fileName,props);               
    }

    async start(...args) {
        this.api.start(this.id,...args)
    }

    async stop(...args) {
        this.api.stop(this.id,...args)
        return this;
    }

    emit(event, ...args) {
        super.emit(event, ...args)
    }


}

module.exports = IpcDownloadSession