const { protocol,ipcMain,app } = require('electron')
const { defineLogEventMethod } = require ('../../utils')
const { getFileInfo,serveFile,isTrue,ipcResponse,getCpuInfo, ipcHandle,ipcCall,ipcSendEvent  } = require('../utils')
const { EventLogger } = require('gd-eventlog')
const fs = require('fs');
const {  PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const Mp4Frag = require('mp4frag');
const FfmpegSupport = require('./ffmpeg')
const VideoSchemeClient = require('./VideoSchemeClient')
const path = require('path')
const os = require('os')
const EventEmitter = require('events');
const Feature = require('../base');
const { ObserverHandler,ipcHandleObserver,ipcCallObserver } = require('../utils/observer');


const SCHEME = 'video';
const LOGGER_NAME = 'VideoScheme';

const debug  = process.env.DEBUG;

const DEFAULT_PRESET = 'veryfast'
const DEFAULT_CRF = 25;


class ConversionEmitter extends EventEmitter {

    static cnt = 0;

    constructor(id)  {
        super();
        if (id)
            this.id = `video-offline-message:${id}`
        else {
            ConversionEmitter.cnt = (ConversionEmitter.cnt+1) % 1000     
            const _id = `${Date.now()}-${ConversionEmitter.cnt}`
            this.id = `video-offline-message:${_id}`
        }        
        ObserverHandler.getInstance().add(this.id,this)
    }

    getMessageKey() {
        return this.id
    }

    emit(event,...data) {
        if (this.isStopped)
            return;
        super.emit(event,...data)
        ipcSendEvent(this.id, event, ...data)        
    }

    on (event,...args) { 
        super.on(event,...args); 
        return this 
    }

    off (event,...args) { 
        super.off(event,...args); 
        return this 
    }
    once (event,...args) { 
        super.once(event,...args); 
        return this 
    }

    done() {
        ObserverHandler.getInstance().remove(this.id)
    }

    stop() {
        this.isStopped = true;
        super.emit('stop')
        this.done()
    }

}


class VideoScheme  extends Feature {
    static instance = undefined

    static getInstance(props) {
        if (!VideoScheme.instance) {
            VideoScheme.instance = new VideoScheme(props);
        }
        return VideoScheme.instance;        
    }

    constructor(props={}) {
        super();
        this.logger = new EventLogger(LOGGER_NAME);
        this.proc = {};
        this.progress = {}
        this.segments = {}
    }

    initFFMeg() {
        this.ffmpegSupport = FfmpegSupport.getInstance();   
        this.ffmpegSupport.init();
    }

    initConvertSession(key,ipc, props={}) {  
        return  (...args) => {
            const id = Date.now();
            const client = new VideoSchemeClient(id,ipc,props);
            
            if (isTrue(props.debug)) 
                console.log(`ipcCall: ${key} (${id})`,...args)
            
            return new Promise( (resolve,reject) => {
        
                ipc.send(key,id,...args);        
              
                ipc.once(`${key}:response:${id}` , (event,result) => {
                    if (isTrue(props.debug)) 
                        console.log(`ipcCall response: ${key} (${id})`,result)
    
                    if ( result.success) {
                        return resolve(client);  
                    }          
                    else {
                        return reject(result.error);
                    }
                })       
                
                client.registerEventCallback('error');
                client.registerEventCallback('progress');
                client.registerEventCallback('segment');
                client.registerEventCallback('started');
                client.registerEventCallback('done');
            })
        }
    }
    
    
    getNiceValue (performance)  {
        if (performance===undefined) {
            return 0;
        }
        let val = performance;
        val = val>100 ? 100: performance;
        val = val<0 ? 0: val;
        return (val-50)/100*-40;
    }


    isConverted(event,callId,url) {
        /* istanbul ignore next */
        if (isTrue(props.debug))
            this.logger.logEvent( {message:'is converted', callId,  url})

        const {filename,ext} = getFileInfo(url,SCHEME)
        const outFile = filename.replace(`.${ext}`,'.mp4')

        if ( fs.existsSync(outFile)) {
            return true;
        }
    }

    stopAll() {
        Object.keys(this.proc).forEach( (id) => {
            this.stop(undefined,undefined,id)
        })

    }

    getUrlFileInfo(url) {
        let fileInfo = {}

        const scheme = url.includes(':') ? url.split(':')[0] : undefined
        fileInfo=  getFileInfo(url,scheme)
        fileInfo.scheme = scheme
        return fileInfo
    }

    async screenshot(url,props={}) {

        const {filename,ext,name} = this.getUrlFileInfo(url)

        await this.ffmpegSupport.ready()
    
        const extRegex = new RegExp(`.${ext}$`)

        const {outDir,position=0,size} = props

        const pngDir = outDir || (url.startsWith('http') ? os.tmpdir() : undefined)
        const outFile = pngDir ? path.join(pngDir,name.replace(extRegex,'_preview.png')) : filename.replace(extRegex,'_preview.png')
        const outUrl = 'file:///'+outFile 
        const ffmpegProps = {filename:outFile,count:1,timemarks:[position]}
        if (props.size)
            ffmpegProps.size = props.size
        if (outFile.startsWith('/'))
            ffmpegProps.folder = '/' 
        
        return new Promise( (resolve,reject) => {

            const cmd = ffmpeg(filename)
                .addOutputOptions('-frames:v 1')
                .addOption(`-ss ${position}`)
                .addOption(`-s ${size}`)
                .output(outFile)
                .on('error', (err)=>{reject(this.parseError(err))})
                .on('end',()=>{resolve(outUrl)})                                           
            cmd.run(ffmpegProps)
        })  
    }

    parseError(err) {
        const parts = err.message.split(':')
        const error = (parts.length<2) ? err.message : parts[parts.length-1].trim()

        if (error!=='No such file or directory') {
            this.logger.logEvent({message:'error creating preview', error:err.message})
        }
        return new Error(error)
    }

    run(cmd,stream) {
        const outStream = stream || new PassThrough();

        let error = undefined
        let out
        let to

        return new Promise( (resolve,reject)=> {
            cmd.on('error', (err)=>{
                resolve({error,out})
            })
            cmd.on('end',()=>{ 
                resolve( {error,out})
            })
            out = cmd.pipe(outStream)
        })


    }

    async getCodec(url) {
        const {filename,ext: format,name} = this.getUrlFileInfo(url)

        await this.ffmpegSupport.ready()

        let codec;
        const cmd = ffmpeg(filename)
            .on('codecData', (data) => {
                codec = data?.video? data.video.split(" ")[0] : undefined
            })
            .on('stderr',(line) => { 
                if (line.includes('Video:')) {
                    cmd.kill()
                }
            })
            .native()
            .duration(0.01)
            .noAudio()
            .videoCodec('copy')
            .format(format)

        await this.run(cmd)
        return codec

    }

    createConvertOutName( fileInfo, props={}) {
        const {filename,ext,name,scheme,dir} = fileInfo
        const extRegex = new RegExp(`.${ext}$`)

        const {outDir} = props

        const mp4Dir = outDir || (scheme.startsWith('http') ? os.tmpdir() : undefined)
        const outFile = mp4Dir ? path.join(mp4Dir,name.replace(extRegex,'.mp4')) : filename.replace(extRegex,'.mp4')
        return outFile

    }

    async save(emitter,cmd,outFile) {
        
        const outUrl = 'file:///'+outFile 
        let duration;

        const parseTime = (time) => {
            const parts = time.split(':')
            const seconds = Number(parts[2])+Number(parts[1])*60+Number(parts[0])*3600
            return seconds
        }

        const emitProgress = (info)=>{
            info.target  = parseTime(duration)
            info.current = parseTime(info.timemark)
            info.completed = info.current/info.target*100
            emitter.emit('conversion.progress',info)
        }
        const sessionId = `${outFile}-${Date.now()}`

        cmd.on('codecData', (data)=>{duration= data.duration})
        cmd.on('error',(err)=>{
            emitter.emit('conversion.error',err)
            delete this.proc[sessionId];
        })
        cmd.on('end', ()=>{
            emitter.emit('conversion.done',outUrl)
            delete this.proc[sessionId];
        })
        cmd.on('progress', emitProgress)            
        //cmd.on('stderr',console.log)

        emitter.once('stop', ()=>{ cmd.kill()})


        this.proc[sessionId] = cmd
        cmd.saveToFile(outFile)
        
    }


    async convertSlow(emitter, url,props={}) {
        const fileInfo = this.getUrlFileInfo(url)
        const {filename} = fileInfo

        await this.ffmpegSupport.ready()

        const outFile = this.createConvertOutName(fileInfo,props)

        try {
            const cmd = ffmpeg(filename)

                //.addOutputOptions('-movflags +frag_keyframe+empty_moov+default_base_moof')
                .addOutputOptions('-movflags +faststart')
                .videoCodec('libx264')   //libx264
                .format('mp4')
                .noAudio()
                .outputOptions('-crf', 25)
                .outputOptions('-preset', 'veryfast')
                
                this.save(emitter,cmd,outFile)                
        }
        catch(err) {
            emitter.emit('conversion.error',err)
        }

    }

    async convertFast(emitter,url,props={}) {
        const fileInfo = this.getUrlFileInfo(url)
        const {filename} = fileInfo

        await this.ffmpegSupport.ready()

        const outFile = this.createConvertOutName(fileInfo,props)

        try {
            const cmd = ffmpeg(filename)
                .addOutputOptions('-movflags +faststart')
                //.addOutputOptions('-movflags +frag_keyframe+empty_moov+default_base_moof')
                .format('mp4')
                .videoCodec('copy')
                .audioCodec('copy')

            this.save(emitter,cmd,outFile)                
        }
        catch(err) {
            emitter.emit('conversion.error',err)
        }
    }

    convertToFile(url,props={}) {

        let codec;

        const emitter = new ConversionEmitter()
        const {enforceSlow=false} = props

        const convert = async ()=> {
            if (!enforceSlow)  {
                try {
                    codec = await this.getCodec(url)
                }
                catch (err) {
                    console.log('~~~ ERROR',err)
                }
            }    
            
    
            if (codec==='h264' && !enforceSlow)
                this.convertFast(emitter,url,props)
            else 
                this.convertSlow(emitter,url,props)        
    
        }

        convert();
        return emitter
    }

    

    /** 
     *  process request to start a video conversion to MP4
     * 
     *  The renderer process will send a request to the main process to start a video conversion.
     *  The main process will start the conversion and send a client object to the renderer process,
     *  which can be used to control and monitor the conversion.
     * 
     *  @param {object} event - ipc event
     *  @param {number} callId - unique call id
     *  @param {string} url - url of the video to convert ( video://... )
     * 
     *  @fires video-convert:response  ( {VideoSchemeClient} client)
     */

    convertRequest( event,callId,url, props={}) {
        if (isTrue(props.debug))
            this.logger.logEvent( {message:'convert', callId,  url,info:getFileInfo(url,SCHEME),props})

        const sendResponse = (...args) => { ipcResponse(event.sender,'video-convert',callId, ...args)  }
        const sendEvent = ( eventKey, ...args) => { 
            if (process.env.DEBUG)
                console.log(`ipcCall response: video-convert:${eventKey}:${callId}`,...args)
            event.sender.send(`video-convert:${eventKey}:${callId}` ,...args)  
        }
    
        if ( !url) {
            return sendResponse({ success:false, error:`no URL specified`})
        }
    
        const {filename,ext} = getFileInfo(url,SCHEME)

        if (!filename || !ext) {
            return sendResponse({ success:false, error:`could not convert ${url}`})
        }

        if ( ext.toLowerCase() === 'mp4') {
            return sendResponse({ success:false, error:`file type not supported: ${ext}`})

        }

        if (!fs.existsSync(filename)) {
            this.logger.logEvent( {message:'convert start error',error:`file not found: ${filename}`})
            return sendResponse( { success:false, error:`file not found: ${filename}`})
        }

        if ( !this.ffmpegSupport.isSupported() ){
            return sendResponse( { success:false, error:`ffmpeg not supported`})
        }
    

        try {
            const outFile = filename.replace(`.${ext}`,'.mp4')
            const inStream = fs.createReadStream(filename);
            const convertStream = new PassThrough();
            const mp4frag = new Mp4Frag();

            const progress = {
                iv: undefined, 
                info: undefined
            }

            if (this.proc[callId])
                this.stop( event,callId);

            let preset = DEFAULT_PRESET;
            let crf = DEFAULT_CRF;

            if (props.file) {
                crf = props.crf || 25;
            }
            else {
                crf = props.crf || 28;
                preset = 'superfast'
            }
            this.ffmpegSupport.ready().then( ()=> {
                const cmd = ffmpeg(inStream )
                .addOutputOptions('-movflags +frag_keyframe+empty_moov+default_base_moof')
                .videoCodec('libx264')   //libx264
                .format('mp4')
                .noAudio()
                .outputOptions('-crf', crf)
                .outputOptions('-preset', preset)
                .on('progress', (info) => {
                    const priority = this.progress[callId] && this.progress[callId].info? this.progress[callId].info.priority : undefined;
                    progress.info = info;
                    progress.info.cpu = getCpuInfo();
                    if (priority!==undefined) {
                        progress.info.priority = priority;
                    }

                  })
                .on('end', () => {
                    sendEvent('done')
                    if (progress.iv) {
                        clearInterval(progress.iv)
                        progress.iv = undefined
                    }
                  })
                .on('error', (err) => {
                    if (!this.proc[callId])
                        return;
                    sendEvent('error',err)
                });

            if ( props.startPos) {
                cmd.outputOptions('-ss', props.startPos)
            }
            if ( props.duration) {
                cmd.outputOptions('-t', props.duration)
            }


            this.proc[callId] = cmd;
            this.progress[callId] = progress;
            if ( props.progressInterval ) {
                progress.iv = setInterval(() => {
                    if ( progress.info)
                        sendEvent('progress',progress.info)
                }, props.progressInterval*1000) 
            }
            const out = cmd.pipe(convertStream);
            
            if (props.stream || !props.file) {

                mp4frag.on('initialized',(_info)=>{
                    this.segments[callId] = { progress: 0, segments:[]};
    
                    const segInfo = this.segments[callId];
                    const info = { start:0, size: mp4frag.initialization.length, data:mp4frag.initialization};
                    segInfo.segments.push(info);
                    segInfo.progress += info.size;
                    sendEvent('started')
                    
                })
                mp4frag.on('error',(err)=>{
                    if (process.env.DEBUG)
                        this.logger.logEvent({ message:'mp4frag.error',error:err.message})
                })
                mp4frag.on('segment',(segment)=>{
                    
                    const segInfo = this.segments[callId];
                    if (!segInfo)
                        return;

                    const {sequence, duration, timestamp, keyframe} = segment;
                    const info = { start: segInfo.progress, size: segment.segment.length,sequence, duration, timestamp, keyframe,data:segment.segment};
    
                    segInfo.segments.push(info);
                    segInfo.progress += info.size;
                    //sendEvent('segment',segment.segment)
                    //console.log('segment',segInfo.progress, info,segment, segment.length)
                })
    
                out.pipe(mp4frag,{end:true});

            }

            if (props.file) {
                const outStream = fs.createWriteStream(outFile)
                out.pipe(outStream, {end:true});
            }
                
            
            this.logger.logEvent( {message:'convert start done'})
            return sendResponse( {success:true, data:{id: callId}});

            })


        }
        catch(err) {
            this.logger.logEvent( {message:'convert start error',error:err.message})
            return sendResponse( { success:false, error:err})
        }

    }

    /** 
     *  process request to stop current conversion
     * 
     *  @param {object} event
     *  @param {number} callId
     *  @param {number} sessionid
     * 
     *  @fires video-convert-stop:response  (true)
     */

     stop(event,callId,sessionid) {
        const sendResponse = (...args) => { ipcResponse(event.sender,'video-convert-stop',callId, ...args)  }

        if (this.proc[sessionid]) {
            const cmd = this.proc[sessionid];
            this.proc[sessionid] = undefined;
       
            cmd.kill('SIGINT');
            this.segments[sessionid] = undefined;
        }

        if ( this.progress[sessionid] ) {
            if( this.progress[sessionid].iv ) {
                clearInterval(this.progress[sessionid].iv)
            }
            this.progress[sessionid] = undefined
        }

        // no event specified: This request was made from the main process (during cleanup via video.stopAll() )
        if ( event===undefined) {
            return true;            
        }
        sendResponse( true );
    }


    /** 
     *  process request to set process priority of current conversion 
     * 
     *  The process priority of the current conversion can be set to a value between 0 (lowest priority) and 100 (highest priority).
     *  Default process priority is 50.
     * 
     *  @param {number} priority process priority 
     */

     setPriority(event,callId,sessionid,priority) {
        const found = this.proc[sessionid]!==undefined;
        if (found) {
            const cmd = this.proc[sessionid];
            const nice = VideoScheme.getNiceValue(priority);
            cmd.renice(nice)

            const progress = this.progress[sessionid];
            if (progress && progress.info) {
                progress.info.priority = priority;
            }
        }
        
        return found
    }

    /** 
     *  process request to deliver next chunk of converted video.
     * 
     *  @param {number} sessionid
     * 
     */
    next(sessionid) {
        const segInfo = this.segments[sessionid];
        if (!segInfo)
            return; // TODO: proper error handling

        const {segments} = segInfo;
     

        return new Promise( done => {

            const send = () =>{
                const segment = segments.shift();
                done(segment.data.toString('hex'))

            }

            if (segments.length === 0) {
                const iv = setInterval(() => {
                    if ( segments.length > 0) {
                        clearInterval(iv)
                        return send()
                    }
                    // already killed or finished
                    if ( !this.proc[sessionid]) {
                        clearInterval(iv)
                        return done ((new Uint8Array(0)).toString('hex'))
                    }
                }, 100)                
            }
            else {
                send()
            }
    
    
        })
        
    }



    register( props={}) {
        const requestLogger = defineLogEventMethod(props.requestLogger || console);


        protocol.registerFileProtocol (SCHEME,(request,callback) => {
            const {outFile} = getFileInfo(request.url,SCHEME)
            requestLogger.logEvent({message:'serve file', scheme:SCHEME, filename:outFile, info:getFileInfo(outFile,SCHEME) });
            serveFile(outFile,request,callback)
        }) 

        ipcMain.on('video-convert',this.convertRequest.bind(this));
        ipcMain.on('video-convert-stop',(event,callId,sessionid) => this.stop(event,callId,sessionid));       

        ipcHandle('video-convert-set-priority', this.setPriority.bind(this),ipcMain)
        ipcHandle('video-screenshot',this.screenshot.bind(this),ipcMain )
        ipcHandle('video-convert-next',this.next.bind(this),ipcMain )
        ipcHandleObserver('video-convert-offline',this.convertToFile.bind(this),ipcMain )
        
        // we need to stop active sessions on app exit, otherwise the main process would still try to send events to the renderer process
        app.on('before-quit', ()=> this.stopAll());

        this.initFFMeg()
    }

    registerRenderer( spec, ipcRenderer) {
        spec.registerFeatures( [
            'video','video.convert','video.screenshot','video.convertOffline'
        ] )

        spec.video = {}
        spec.video.convert    = this.initConvertSession('video-convert',ipcRenderer,{debug})
        spec.video.screenshot = ipcCall('video-screenshot',ipcRenderer)
        spec.video.convertOffline  = ipcCallObserver('video-convert-offline',ipcRenderer)
        

        spec.video.session = {}
        spec.video.session.setPriority = ipcCall('video-convert-set-priority',ipcRenderer)
        spec.video.session.next = ipcCall('video-convert-next',ipcRenderer)

       

        VideoSchemeClient.init(spec.video.session)

    }
    

}

module.exports = VideoScheme