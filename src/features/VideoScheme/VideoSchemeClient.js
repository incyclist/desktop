const { ipcCall,isTrue } = require('../utils')
const EventEmitter = require('events');
const debug  = process.env.DEBUG;

class VideoSchemeClient extends EventEmitter {
    static instances = {};

    
    static api

    static init(api) {
        VideoSchemeClient.api = api;
    }

    constructor(sessionId,ipc,props={}) {
        super();
        this.sessionId = sessionId;
        this.ipc = ipc;
        this.props = props;
        this.api = VideoSchemeClient.api

        VideoSchemeClient.instances[sessionId] = this;

    }
    
    static getInstance(id) {
        return VideoSchemeClient.instances[id];
    }

    async next() {

        const b =  await this.api.next(this.sessionId)
        return Buffer.from(b,'hex');
        
    }

    stop() {
        return ipcCall('video-convert-stop',this.ipc,{debug:this.props.debug||isTrue(debug)})(this.sessionId)
    }  

    async setPriority(performance) {
        return await this.api.setPriority(this.sessionId, performance)
    }

    registerEventCallback = (event) => {
        this.ipc.on(`video-convert:${event}:${this.sessionId}` , ( _ev, ...evArgs) =>  {
            
            if (isTrue(debug) || this.props.debug) 
                console.log(`ipcCall event "${event}": video-convert(${this.sessionId}) `,...evArgs)
            this.emit(event,...evArgs) 
        })
    }  
}

module.exports = VideoSchemeClient