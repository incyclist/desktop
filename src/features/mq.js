const {ipcMain} = require('electron');
const {EventLogger } = require('gd-eventlog');
const {ipcCall, ipcSendEvent, ipcResponse,isTrue} = require ('./utils/index.js')
const Feature = require('./base.js')
const { getSecret } = require('../modules/secrets.js')
const mqtt = require('mqtt');
const Prom = require('../utils/promises.js');

const MQ_DEBUG = process.env.MQ_DEBUG || false
const CONNECT_RETRY_INTERVAL = 10000;   // 10 seconds
const CONNECT_TIMEOUT = 5000;           // 5 seconds

// singleton pattern
class MessageQueueFeature extends Feature{
    static _instance;


    constructor(props = {}) {
        super(props)
        this.logger = new EventLogger('mq')

        this.connected = false;
        this.connecting = false;
        this.connectIv  = null;
        this.publishIv  = null;
        this.client = null;
        this.subscriptions = [];
        this.messages = []
        this.retryCount = 0;

        this.broker = getSecret('MQ_BROKER');
        this.username = getSecret('MQ_USER');
        this.password = getSecret('MQ_PASSWORD');
    } 

    static getInstance() {
        if (!MessageQueueFeature._instance) {
            MessageQueueFeature._instance = new MessageQueueFeature()
        }
        return MessageQueueFeature._instance
    }

    isConnected() { return this.connected}

    init() {
        this.connect();
        this.keepAlive()       
    }

    keepAlive() {
        if (this.keepAliveIv)
            return;

        this.keepAliveIv = setInterval( async ()=>{ 
            if (this.isConnected())
                return;

            const connected = await this.connect();
            if (connected) {
                this.subscribe();
            }
        },CONNECT_RETRY_INTERVAL)

    }

    async connect() {

        if (this.isConnected())
            return true;

        if ( !Prom.exists('mqtt.doConnect')) {
            Prom.add( 'mqtt.doConnect', this._doConnect())            
        }
        await Prom.exec('mqtt.doConnect')
            
            
    }

    async _doConnect() {
        this.retryCount++;
        if( this.retryCount<=1)
            this.logger.logEvent( {message:`connecting to mqtt broker ${this.broker}`});

        this.connecting = true;
        this.connected = false
        const promise = mqtt.connectAsync(this.broker, {username:this.username, password:this.password});
        
        Prom.add('mqtt.connect', promise)
        try {
            this.client = await Prom.exec('mqtt.connect',CONNECT_TIMEOUT)
            this.connecting = false;
            this.connected = true
            this.retryCount = 0;
            this.logger.logEvent( {message:`connected to mqtt broker ${this.broker}`});   
            this.registerHandlers()
        }
        catch(err) {
            if( this.retryCount<=1)
                this.logger.logEvent( {message:`error connecting to mqtt broker ${this.broker}`, error:err.message, stack:err.stack}); 
            this.connecting = false;
            this.connected = false
        }

    }

    registerHandlers() {
        this.messageHandler = this.onMessage.bind(this);
        this.errorHandler = this.onError.bind(this);
        this.closeHandler = this.onClose.bind(this);
        this.disconnectHandler = this.onDisconnect.bind(this)
        this.offlineHandler = this.onOffline.bind(this)
        this.endHandler = this.onEnd.bind(this)

        this.client.on('message', this.messageHandler);
        this.client.on('error', this.errorHandler);
        this.client.on('close', this.closeHandler)
        this.client.on('disconnect', this.disconnectHandler)
        this.client.on('offline', this.offlineHandler)
        this.client.on('end', this.endHandler)
    }

    unregisterHandlers() {
        this.client.off('message', this.messageHandler);
        this.client.off('error', this.errorHandler);
        this.client.off('close', this.closeHandler)
        this.client.off('disconnect', this.disconnectHandler)
        this.client.off('offline', this.offlineHandler)
        this.client.off('end', this.endHandler)
    }

    async subscribeTopic(topic) {

        if(!this.isConnected() || !this.client)
            return;

        const topicInfo = this.subscriptions.find( (t)=> t.topic === topic);
        if (!topicInfo)
            return;

        const {event,callId,subscribed} = topicInfo;

        if (subscribed)
            return;

        if (MQ_DEBUG)
            this.logger.logEvent({message:'subscribing to',topic});
        
        this.client.subscribe(topic, (err)=>{
            if (!err)  {                    

                if (topicInfo) {
                    if (MQ_DEBUG)
                        this.logger.logEvent({message:'subscribed to',topic});
                    topicInfo.subscribed = true;

                    ipcResponse(event.sender,'mq-subscribe',callId, true);
                    this.sendEvent('mq-subscribed',topic);
                }
                return;
            }
            this.logger.logEvent({message:`error subscribing topic ${topic} to mqtt broker`, error:err.message}) 
        });
    }

    unsubscribeTopic(topic) {

        return new Promise ( (resolve) => {
            if(!this.connected || !this.client)
                return resolve(true)

            const topicInfo = this.subscriptions.find( (t)=> t.topic === topic);
            if (!topicInfo)
                return resolve(true)

            const {event,callId,subscribed} = topicInfo;
            if (!subscribed) {
                this.subscriptions = this.subscriptions.filter( (t)=> t.topic !== topic);
                this.sendEvent('mq-unsubscribed',topic);
                return resolve(true)
            }

            this.client.unsubscribe(topic, (err)=>{
                if (!err)  {                    
                    if (MQ_DEBUG)
                        this.logger.logEvent({message:'unsubscribed from',topic});
                    this.subscriptions = this.subscriptions.filter( (t)=> t.topic !== topic);

                    this.sendEvent('mq-unsubscribed',topic);
                    return resolve(true)

                }
                this.logger.logEvent({message:`error unsubscribing topic ${topic} from mqtt broker`, error:err.message}) 
                return resolve(false)
            })

        })
    }

    sendEvent( event, ...args) {
        ipcSendEvent( 'mq-event',event,...args);
    }

    async subscribe() {
        if (!this.isConnected())
            await this.connect();

        if (this.isConnected()) {
            this.subscriptions.forEach( (t)=>{
                this.subscribeTopic(t.topic)
            })    
        }
    }


    addSubscription(event, callId, topic) {
        this.logger.logEvent({message:'add subscription',topic});
        

        const topicInfo = this.subscriptions.find( (t)=> t.topic === topic);
        if (topicInfo && topicInfo.subscribed) {
            ipcResponse(event.sender,'mq-subscribe',callId, true);
            this.sendEvent('mq-subscribed',topic);
            return;
        }

        if (!topicInfo) 
            this.subscriptions.push( {topic,event,callId,subscribed:false} );

        this.subscribe();
    }
    
    removeSubscription(event, callId, topic) {
        this.logger.logEvent({message:'remove subscription',topic});

        const topicInfo = this.subscriptions.find( (t)=> t.topic === topic);

        if (!topicInfo || !this.connected || !this.client) {
            ipcResponse(event.sender,'mq-unsubscribe',callId, true);
            this.sendEvent('mq-unsubscribed',topic);
            return;
        }

        this.unsubscribeTopic(topic).then( success => {
            ipcResponse(event.sender,'mq-unsubscribe',callId, success);
        });
    }

    doPublish(event, callId, topic,message) {
        this.client.publish(topic, message, (err)=>{
            if (err) {
                this.logger.logEvent({message:`error publishing message to topic ${topic}`, error:err.message, level:'error'});
                ipcResponse(event.sender,'mq-publish',callId, false);
            }
            else {
                ipcResponse(event.sender,'mq-publish',callId, true);
            }
        });        
    }

    publishMessage(event, callId, topic,message) { 

        if ( this.isConnected()) {
            this.doPublish(event, callId, topic,message);
        }

        else {
            this.messages.push( {event,callId, topic,message} );

            // wait for connection and publish queued events
            if ( !this.publishIv ) {
                this.publishIv = setInterval( ()=>{
                    if (this.isConnected()) {
                        clearInterval(this.publishIv);
                        this.publishIv = null;

                        this.messages.forEach( (messageInfo)=>{ 
                            this.doPublish(messageInfo.event, messageInfo.callId, messageInfo.topic,messageInfo.message);
                        })
                        this.messages = [];
                    }        
                    
                }, 100)
            }
        }
    }
    

    onMessage(topic,message) { 
        let msg= message;
        if ( message instanceof Buffer) {
            msg = message.toString();
        }
        else if (  message instanceof Uint8Array) {  
            msg= Buffer.from(message.buffer).toString();
        }
        else if (typeof message === 'object') { 
            msg = JSON.stringify(message);
        }

        if (isTrue(process.env.MQ_DEBUG) )  {
            console.log(`mq event: `, topic, msg )
        }

        this.sendEvent('mq-message',topic,msg);
    }

    onError(err)  { 
        if (this.isConnected()) {
            this.logger.logEvent( {message:`error received from  mqtt broker ${this.broker}`, error:err.message, level:'error'}); 
        }
        else 
            this.logger.logEvent( {message:`error connecting to mqtt broker ${this.broker}`, error:err.message, level:'error'}); 
    }

    onClose() {
        this.connected = false;
        this.logger.logEvent( {message:'mqtt connection closed', level:'debug'})

        this.client.removeAllListeners()
        this.client.on('error',()=>{})
    }

    onDisconnect(packet)  {
        this.connected = false;
        this.logger.logEvent( {message:'mqtt connection disconnect request',packet, level:'debug'})
        this.disconnect() // keep Alive will trigger reconnect
    }

    onOffline() {
        this.logger.logEvent( {message:'mqtt connection offline', level:'debug'})
    }

    onEnd() { 
        this.logger.logEvent( {message:'mqtt connection ended', level:'debug'})
    }

    async disconnect() {
        if (!this.isConnected())
            return;

        if (!Prom.exists('mqtt.disconnect'))
            Prom.add('mqtt.disconnect',this.client.endAsync())        

        await Prom.exec('mqtt.disconnect')

        this.unregisterHandlers()
        this.connected = false;
    }

    isDisconnecting() {
        return Prom.exists('mqtt.disconnect')
    }




    register(props) {
        const mq = MessageQueueFeature.getInstance();

        // trigger connection to mqtt broker
        mq.init();

        ipcMain.on('mq-subscribe',(event, callId, topic) => mq.addSubscription(event, callId, topic));
        ipcMain.on('mq-unsubscribe',(event, callId, topic) => mq.removeSubscription(event, callId, topic));
        ipcMain.on('mq-publish',(event, callId, topic,message) => mq.publishMessage(event, callId, topic,message));
    }


    registerRenderer(spec,ipcRenderer) {
        spec.mq = {}
        spec.mq.subscribe    = ipcCall('mq-subscribe',ipcRenderer)        
        spec.mq.unsubscribe  = ipcCall('mq-unsubscribe',ipcRenderer)        
        spec.mq.publish      = ipcCall('mq-publish',ipcRenderer)        
        spec.mq.on = (ipcEvent, callback) => {
            ipcRenderer.on( ipcEvent, (_ipcEventInfo, event, topic,message) => {
                if (isTrue(process.env.IPC_DEBUG) ) 
                    console.log(`ipcEvent: ${ipcEvent}`,event, topic, message)

                if (callback)
                    callback(event, topic,message)
            
                
            })
        }

        spec.registerFeatures( [
            'mq','mq.unsubscribe-fix'
        ] )  

    }


}

module.exports = MessageQueueFeature;