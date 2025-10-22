const EventEmitter = require('node:events');
const { EventLogger } = require('gd-eventlog');
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs');
const { ipcSendEvent } = require('../utils');

class DownloadSession extends EventEmitter {
       
    constructor(id,url,fileNameOrStream, props={}){
        super();
        this.id = id;
        this.url = url;
        this.fileName = props.isStream ? undefined: fileNameOrStream
        this.writeStream = props.isStream ? fileNameOrStream: undefined
        this.totalSize = props.size
        this.logger = props.logger || new EventLogger('DownloadSession')
        this.logger.set( {id:this.id, url: this.url})

        this.isStopped = false;
        this.isStopRequested = false
        this.props=props;
        this.onWriteStreamClosedHandler = this.onWriteStreamClosed.bind(this)
        this.onWriteStreamErrorHandler = this.onWriteStreamError.bind(this)

    }

    onWriteStreamClosed() {
        this.isStopped = true;
        if (this.isStopRequested) {
            this.isStopRequested = false
            return
        }
        this.emit('done')
    }
    onWriteStreamError() {
        this.isStopped = true;
        this.emit('error', new Error('Could not save video - error writing to file' ))
    }



    async start() {
        try {
            let tsPrev = Date.now();
            let tsPrevProgressEmit = undefined
            let bytes = 0;
            let speed = undefined
            let received = 0;

            
            const client = this.url.startsWith('https://') ? https : http

            const fetch = async (url) => new Promise ( done=> {
                this.request = client.get(url, res=> { 
                    done(res) 
                })
            })

            // = client.get(this.url, res=> {
            const res = await fetch(this.url)

            try {
                
                const total = res.headers['content-length'] || this.totalSize


                if (res.statusCode===200) {
                    this.emit('started',this.id)  
                    if (this.props.isStream && this.writeStream) {
                        this.writeStream.off('close',this.onWriteStreamClosedHandler)
                        this.writeStream.off('error',this.onWriteStreamErrorHandler)
                        this.logger.logEvent({message:'using existing write stream'})                    
                    }
                    else {
                        if (this.fileName) {
                            this.writeStream = fs.createWriteStream(this.fileName);                        
                            this.logger.logEvent({message:'create write stream', fileName:this.fileName})                    
                        }
                        else {
                            if (!this.writeStream) {
                                this.logger.logEvent({message:'no write stream exists'})                    
                                this.emit('error',new Error('Failed to create writing stream' ))
                                return
                            }
                        }
                    }

                    this.writeStream.on('close',this.onWriteStreamClosedHandler)
                    this.writeStream.on('error',this.onWriteStreamErrorHandler)

                }
                else if (res.statusCode===301) { 
                    try {
                        const newUrl = res.headers['location']
                        this.url = newUrl
                        return this.start()
                        
                    }
                    catch(err) {
                        console.log(err)
                    }


                }
                else {
                    this.emit('error', new Error('Could not download video' ))
                    this.logger.logEvent({message:'error response from server',statusCode:res.statusCode, statusMessage: res.statusMessage,body:res.body})
                    return;
                }

                if (!this.writeStream) {
                    this.emit('error', new Error('Could not save video' ))
                    return;
                }

                res.on('data',(chunk)=>{

                    if (this.isStopped)
                        return

                    if (this.writeStream) {
                        const buffer = Buffer.from(chunk)
                        process.nextTick( ()=> {
                            this.writeStream.write(buffer)
                        })
                        
                    }

                    received += chunk.length;
                    bytes += chunk.length;

                    let pct;
                    if (total) {
                        pct = (received/total*100).toFixed(0);
                    }

                    const ts = Date.now()
                    if (ts-tsPrev>1000) {
                        const t = (ts-tsPrev)/1000;
                        const MB = bytes/1024/1024;
                        speed = MB/t;
                        tsPrev = ts;
                        bytes = 0;
                        this.speed = speed? `${speed.toFixed(1)} MB/s`:undefined
                    }

                    if ( !tsPrevProgressEmit || ts-tsPrevProgressEmit>200) {
                        this.emit('progress',pct >99 ? 99 : pct, this.speed,received ? `${(received/1024/1024).toFixed(1)} MB` : undefined, received )
                        tsPrevProgressEmit = ts;
                    }

                })

                res.on('abort',()=>{
                    if (!this.isStopped)
                        this.emit('error',new Error('aborted'))
                })
                res.on('close',()=>{
                    if (!this.isStopped)
                        this.emit('error',new Error('connection lossed'))
                })
                res.on('timeout',()=>{
                    if (!this.isStopped)
                        this.emit('error',new Error('connection timeout'))
                })

                res.on('end', async () => {
                    this.isStopped = true;
                    this.closeStream()
                })

            }
            catch(err) {
                console.log(err)
            }

//            }) 

        }
        catch(err) {
            this.logger.logEvent({message:'error',fn:'start()',error:err.message, stack:err.stack })
            this.emit('error',err)
        }

    }

    stop() {
        this.isStopped = true;
        this.isStopRequested = true;
        process.nextTick( () => {
            this.closeStream()
            if (this.request)
                this.request.destroy();
    
        })
    }

    emit(event,...args) {
        if (!this.props.noIPC)
            ipcSendEvent( 'dl-mgr-session-event',this.id,event,...args);
        super.emit(event,...args)
    }

    closeStream() {
        if (!this.writeStream)
            return

        try {
            this.writeStream.end();
            this.writeStream.close();
        }
        catch(err) {
            this.logger.logEvent({message:'error',fn:`start().on('end')`,error:err.message, stack:err.stack })
            this.emit('error',err)
        }

        this.writeStream = null;                 

    }


}

module.exports = DownloadSession