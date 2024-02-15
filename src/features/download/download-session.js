const EventEmitter = require('events');
const { EventLogger } = require('gd-eventlog');
const http = require('http')
const https = require('https')
const fs = require('fs');
const { ipcSendEvent } = require('../utils');
const { timeStamp } = require('console');

class DownloadSession extends EventEmitter {
       
    constructor(id,url,fileName, props={}){
        super();
        this.id = id;
        this.url = url;
        this.fileName = props.isStream ? undefined: fileName
        this.writeStream = props.isStream ? fileName: undefined
        this.totalSize = props.size
        this.logger = props.logger || new EventLogger('DownloadSession')
        this.logger.set( {id:this.id, url: this.url})

        this.isStopped = false;
        this.props=props;

    }

    async start() {
        try {
            let tsPrev = Date.now();
            let tsPrevProgressEmit = undefined
            let bytes = 0;
            let speed = undefined
            let writeStream = null;;

            
            const client = this.url.startsWith('https://') ? https : http

            const fetch = async (url) => new Promise ( done=> {
                this.request = client.get(url, res=> { 
                    //console.log( '~~~ status Code',res.statusCode)
                    //console.log( '~~~ headers',res.headers)
                        done(res) 
                })
            })

            // = client.get(this.url, res=> {
            const res = await fetch(this.url)

            try {
                
                const total = res.headers['content-length'] || this.totalSize

                let received = 0;

                if (res.statusCode===200) {
                    this.emit('started',this.id)  
                    writeStream = this.props.isStream ? this.writeStream :  fs.createWriteStream(this.fileName);
                    writeStream.on('close',()=>{
                        this.isStopped = true;
                        this.emit('done')
                    })
                    this.logger.logEvent({message:'create write stream', fileName:this.fileName})                    
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

                if (!writeStream) {
                    this.emit('error', new Error('Could not save video' ))
                    return;
                }

                res.on('data',(chunk)=>{
                    if (writeStream) {
                        const buffer = Buffer.from(chunk)
                        process.nextTick( ()=> {
                            writeStream.write(buffer)
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
                    try {

                        if (writeStream) {
                            writeStream.end();
                            try {
                                writeStream.close();
                            }
                            catch(err) {}
                        }     
                        writeStream = null;                 
                    }
                    catch(err) {
                        this.logger.logEvent({message:'error',fn:`start().on('end')`,error:err.message, stack:err.stack })
                        this.emit('error',err)
                    }
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
        if (this.request)
            this.request.destroy();
    }

    emit(event,...args) {
        if (!this.props.noIPC)
            ipcSendEvent( 'dl-mgr-session-event',this.id,event,...args);
        super.emit(event,...args)
    }


}

module.exports = DownloadSession