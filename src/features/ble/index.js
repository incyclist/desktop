const Feature = require("../base");
const BleServerBinding = require('./bleserver-binding')
const IpcBinding = require('./ipc-binding')
const {ipcCall, ipcSendEvent, ipcResponse,isTrue, ipcCallNoResponse,ipcHandle,ipcHandleNoResponse} = require ('../utils')
const os = require('node:os');
const { getAppDirectory } = require("../../utils");
const { EventLogger } = require('gd-eventlog');
const EventEmitter = require("events");
const { ipcMain } = require("electron");
const Peripheral = require("@stoprocent/noble/lib/peripheral");
const Characteristic = require("@stoprocent/noble/lib/characteristic");
const Service = require("@stoprocent/noble/lib/service");
const Noble = require('@stoprocent/noble/lib/noble');


const clone = (obj) => { 
    try {
        if (obj instanceof Peripheral) {
            const {id, uuid, address, addressType,connectable,advertisement,rssi, services, mtu, state} = obj;
            return { id, uuid, address, addressType,connectable,advertisement,rssi, services:services? services.map(clone):undefined, mtu, state}
        }
        if (obj instanceof Service) {
            const {_peripheralId, uuid,name,type,includedServiceUuids,characteristics} = obj;
            return { _peripheralId, uuid,name,type,includedServiceUuids,characteristics:characteristics?characteristics.map(c=>clone(c)):undefined}
        }

        if (obj instanceof Characteristic) {
            const {_peripheralId, _serviceUuid, uuid, name,type,properties,descriptors} = obj;
            return {_peripheralId, _serviceUuid, uuid, name,type,properties,descriptors}
        }


        return JSON.parse(JSON.stringify(obj));
    }
    catch (err) { 
        console.log('error cloning',err, obj)
        return null;
    }

}

class BLEFeature extends Feature {
    static _instance;

    constructor(props = {}) {
        super(props)
        this.logger = new EventLogger('BLE')
        this.emitter = new EventEmitter();

        this.onDiscoverFn = this.onDiscover.bind(this);
        this.peripherals = [];
        this.ipcBinding = undefined  // lazy init, so that we don't create the binding unless/until the feature is used
        this.isInitialized = false;
    }

    static getInstance() {
        if ( !BLEFeature._instance  ) {
            BLEFeature._instance = new BLEFeature();
        }
        return BLEFeature._instance;
    }

    getBindings() {
                 
        if (!this.ipcBinding) {
            this.ipcBinding = IpcBinding.getInstance() // new Noble(RendererBindings.getInstance())
        }
        return this.ipcBinding;
    }

    init() {  // init on main process
        if (this.isInitialized)
            return;

        
        const props = {}


        props.bleServerDebug = process.env.BLE_DEBUG;

        this.logger.logEvent({message:'init BLE feature'})
        const platform = os.platform();

        try {            
            if ( platform==='win32') {                        
                this.ble = new Noble(BleServerBinding.getInstance( getAppDirectory(),props ))
                
            }
            else if (platform==='linux') {
                this.ble = null;
            }
            else {
                const defaultBinding = require('@stoprocent/noble/lib/resolve-bindings')();
                this.ble = new Noble(defaultBinding);
            }
            
            const nop = ()=>{}
            if (this.ble) {
                this.ble.setServerDebug = this.ble._bindings.setServerDebug || nop;
                this.ble.pauseLogging = this.ble._bindings.pauseLogging || nop;
                this.ble.resumeLogging = this.ble._bindings.resumeLogging || nop;
            }

        }
        catch(err) {
            this.logger.logEvent({message:'Error',fn:'BLEFeature.init()',error:err.message,stack:err.stack})
        }

        if (this.ble) {
            this.ble.on('stateChange', (state) => {
                this.logger.logEvent({message:'stateChange',state})
                this.state = state;
                this.emit('stateChange', state);
            })

            this.ble.write = async (...args) => {
                return this.ble._bindings.write(...args);
            }
            this.isInitialized = true;
        }
        else {
            this.isInitialized = false
        }
    }

    async initRequest(event, callId) { 
        ipcResponse(event.sender,'ble-init',callId, this.state);
    }

    onDiscover(peripheral) { 
        
        const p = clone(peripheral)
        if ( !this.peripherals.find( p => p.id===peripheral.id) ) {
            peripheral.on ('connect', (error) => {
                this.emit('peripheral-event','connect', peripheral.id,error)
            })
            //peripheral.on ('rssiUpdate', (error,rssi) => {this.emit('peripheral-event','rssiUpdate', peripheral.id,error,rssi)})
            this.peripherals.push(peripheral);
        }

        this.emitter.emit('discover-peripheral', p)        
    }

    async startScanningRequest(event, callId,  serviceUUIDs, allowDuplicates) {
        this.ble.removeAllListeners('discover')
        this.emitter.removeAllListeners('discover-peripheral')        
        this.ble.on('discover', this.onDiscoverFn)
        this.ble.startScanning(serviceUUIDs, allowDuplicates, (err) => {
            ipcResponse(event.sender,'ble-startScanning',callId, err);
        });
    }

    async stopScanningRequest(event, callId  ) {
        this.ble.removeAllListeners('discover')
        this.emitter.removeAllListeners('discover-peripheral')        
        
        this.ble.stopScanning(() => {
            ipcResponse(event.sender,'ble-stopScanning',callId);
        });

    }

    async onEventRequest(event, callId, eventName) { 

        if (eventName==='discover') {
            this.emitter.on('discover-peripheral',(peripheral) => {
                this.emit(eventName, peripheral)    
            })                
        }
        else {
            this.ble.on( eventName, (...args) =>{
                    const res = args.map(clone)
                    this.emit(eventName, ...res)    
                }
            )
        }
        ipcResponse(event.sender,'ble-onEvent',callId);
    }

    async connectDeviceRequest(event, callId, peripheralId) { 
        const peripheral = this.peripherals.find( p => p.id===peripheralId);
        let error = null;

        if ( peripheral  ) { 
            if (peripheral.state!=='connected') {

                try {
                    peripheral.once('disconnect', ()=> { 
                        this.onDeviceDisconnect(peripheral)}
                        )
                    await  peripheral.connectAsync();
                }
                catch (err) {
                    error = err;
                }
            }
        }
        else {
            error = new Error('device not found');
        }
        ipcResponse(event.sender,'ble-connectDevice',callId, error);
    }

    onDeviceDisconnect( peripheral) {
        try {
            peripheral.state = 'disconnected';
            this.emit('peripheral-event', 'disconnect', peripheral.id, null)
        }
        catch (err) {
            console.log('~~~~~~ ERROR',err)
        }
    }

    async getServicesAndCharacteristicsRequest(event, callId, id,services,characteristics) { 
        const peripheral = this.peripherals.find( p => p.id===id);
        let error = null;
        let res
        if ( peripheral ) { 
            try {
                res = await peripheral.discoverSomeServicesAndCharacteristicsAsync(services,characteristics);                
                peripheral.services = res.services;
                peripheral.characteristics = res.characteristics;
            }
            catch (err) { 
                error = err;
            }
            ipcResponse(event.sender,'ble-getServicesChars', callId, {   
                error,
                services:res.services? res.services.map(clone):null, 
                characteristics:characteristics? res.characteristics.map(clone): null
            });
        }
    }

    async getServicesRequest(event, callId, id,requestedServices) {
        const peripheral = this.peripherals.find( p => p.id===id);
        let error = null;
        let services

        if ( peripheral ) { 
            try {
                services = await peripheral.discoverServicesAsync(requestedServices);                
                peripheral.services = services;
                
            }
            catch (err) { 
                error = err;
            }
            ipcResponse(event.sender,'ble-getServices', callId, {   
                error,
                services:services? services.map(clone):null,                 
            });
        }
    }

    async subscribeRequest(event, callId, peripheralId,  characteristicUUID) { 
        const peripheral = this.peripherals.find( p => p.id===peripheralId);
        const characteristic = peripheral.characteristics.find( c => c.uuid===characteristicUUID);
        
        let error = null;        
        if ( peripheral && characteristic) { 
            try {

                const to = setTimeout( ()=>{
                    this.logger.logEvent({message:'subscribe timeout',fn:'subscribeRequest()',callId,peripheralId,characteristicUUID})
                    ipcResponse(event.sender,'ble-subscribe',callId, new Error('timeout'));
                },5000)

                characteristic.subscribe( ()=>{
                    clearTimeout(to);
                    ipcResponse(event.sender,'ble-subscribe',callId, error);
                
                    characteristic.write = async (data, withoutResponse,callback) => {      
                        try {
                            const res = this.ble.write(
                                characteristic._peripheralId,
                                characteristic._serviceUuid,
                                characteristic.uuid,
                                data,
                                withoutResponse,
                                callback
                            )                            
                            return res
                        }
                        catch(err) {     
                            return err;
                        }
                        
            
                      };
                });
                const ts = Date.now();
                characteristic.removeAllListeners('data');
                characteristic.on('data', (data, isNotification) => { 
                    this.emit('data', peripheralId, characteristicUUID, data, isNotification,ts);
                });


            }
            catch (err) {
                this.logger.logEvent({message:'error',fn:'subscribeRequest()',error:err.message||err, stack:err.stack})
                error = err;
                ipcResponse(event.sender,'ble-subscribe',callId, error);
            }
        }
        else { 
            this.logger.logEvent({message:'error',fn:'subscribeRequest()',error:'device not found', peripheralId, characteristicUUID})
            error = new Error('device not found');
            ipcResponse(event.sender,'ble-subscribe',callId, error);
        }
        
    }

    async unsubscribeRequest(event, callId, peripheralId,  characteristicUUID) { 
        const peripheral = this.peripherals.find( p => p.id===peripheralId);
        const characteristic = peripheral.characteristics.find( c => c.uuid===characteristicUUID);
        
        let error = null;        
        if ( peripheral && characteristic) { 
            try {
                await characteristic.unsubscribe();
                characteristic.removeAllListeners('data')
            }
            catch (err) {
                error = err;
            }
        }
        else { 
            error = new Error('device not found');
        }
        ipcResponse(event.sender,'ble-unsubscribe',callId, error);

    }

    async readRequest(event, callId, peripheralId,  characteristicUUID) { 
        const peripheral = this.peripherals.find( p => p.id===peripheralId);
        const characteristic = peripheral.characteristics.find( c => c.uuid===characteristicUUID);
        
        let error = null;        

        if ( peripheral && characteristic) { 
            characteristic.read( (err,data) => {
                ipcResponse(event.sender,'ble-read',callId, {err,data});
            });
        }
        else { 
            error = new Error('device not found');
            ipcResponse(event.sender,'ble-read',callId, {err:error,data:null});
        }        
    }


    async write( peripheralId,  characteristicUUID, data, withoutResponse) { 
        const peripheral = this.peripherals.find( p => p.id===peripheralId);
        const characteristic = peripheral.characteristics.find( c => c.uuid===characteristicUUID);
        
        if ( peripheral && characteristic) { 

            let b = data;
            let bufferStr;
    
            if (!Buffer.isBuffer(data)) {
                try {
                    if (typeof data==='object')
                        bufferStr = JSON.stringify(data)
                    else 
                        bufferStr = data.toString()
                    b = Buffer.from(data)
                }
                catch {
                    this.logger.logEvent( {message:'write: buffer is not a Buffer',buffer:bufferStr,hex:b?.toString('hex'), type:typeof data})                    
                }
            }

            if (withoutResponse===true) {
                characteristic.write( b,true)?.catch(()=>{})              
                return null;
            }
            else {

                return new Promise( done=> {
                    try {
                        characteristic.write( b,false)
                            .then ( (res)=> {
                                done(res)
                            })
                            .catch( (err)=> {
                                done(err)
                            })
                    }
                    catch(err) {
                        done (err)
                    }
    
                })
            }
        }
        else { 
            throw new Error('device not found');
        }        
    }

    setServerDebug(enabled) {
        const binding = this.ble._bindings;
        if (binding && binding.setServerDebug && typeof binding.setServerDebug === 'function')
            this.ble.setServerDebug(enabled)

    }

    pauseLogging() {
        const binding = this.ble._bindings;
        if (binding && binding.pauseLogging && typeof binding.pauseLogging === 'function')
            binding.pauseLogging()
    }

    resumeLogging() {
        const binding = this.ble._bindings;
        if (binding && binding.resumeLogging && typeof binding.resumeLogging === 'function')
            binding.resumeLogging()
    }


    on(event, callback) { 
        this.emitter.on(event, callback) 
    }


    once(event, callback) { this.emitter.on(event, callback) }

    emit(event, ...args) { 
        this.emitter.emit(event, ...args) 
        ipcSendEvent( 'ble-event',event,...args);
    }

    register(props) {
        const ble = BLEFeature.getInstance();

        // trigger connection to mqtt broker
        ble.init();
        if ( ble.isInitialized) {
            ipcMain.on('ble-init',(event, callId ) => ble.initRequest(event, callId));
            ipcMain.on('ble-startScanning',(event, callId, serviceUUIDs, allowDuplicates) => ble.startScanningRequest(event, callId,  serviceUUIDs, allowDuplicates));
            ipcMain.on('ble-stopScanning',(event, callId) => ble.stopScanningRequest(event, callId));
            ipcMain.on('ble-onEvent',(event, callId, eventName) => ble.onEventRequest(event, callId,eventName));
            ipcMain.on('ble-connectDevice',(event, callId, id) => ble.connectDeviceRequest(event, callId,id));
            ipcMain.on('ble-getServicesChars',(event, callId, id,services,characteristics) => ble.getServicesAndCharacteristicsRequest(event, callId,id,services,characteristics));
            ipcMain.on('ble-getServices',(event, callId, id,services) => ble.getServicesRequest(event, callId,id,services));
            ipcMain.on('ble-subscribe',(event, callId, id,characteristic) => ble.subscribeRequest(event, callId,id,characteristic));
            ipcMain.on('ble-unsubscribe',(event, callId, id,characteristic) => ble.unsubscribeRequest(event, callId,id,characteristic));
            ipcMain.on('ble-read',(event, callId, id,characteristic) => ble.readRequest(event, callId,id,characteristic));

            ipcHandle('ble-write', this.write.bind(this), ipcMain)
            ipcHandleNoResponse('ble-setServerDebug',this.setServerDebug.bind(this),ipcMain)
            ipcHandleNoResponse('ble-pauseLogging',this.pauseLogging.bind(this),ipcMain)
            ipcHandleNoResponse('ble-resumeLogging',this.resumeLogging.bind(this),ipcMain)
        }
    }

    registerRenderer(spec,ipcRenderer) {

        spec.ble = {}
        IpcBinding.getInstance().setApi(spec.ble);

        spec.ble.getInstance = () => { 
            return BLEFeature.getInstance().getBindings() 
        }
        spec.ble.init             = ipcCall('ble-init',ipcRenderer)        
        spec.ble.startScanning    = ipcCall('ble-startScanning',ipcRenderer)       
        spec.ble.stopScanning     = ipcCall('ble-stopScanning',ipcRenderer)      
        spec.ble.onEvent          = ipcCall('ble-onEvent',ipcRenderer)
        spec.ble.connectDevice    = ipcCall('ble-connectDevice',ipcRenderer)       
        spec.ble.getServices      = ipcCall('ble-getServices',ipcRenderer)       
        spec.ble.getServicesAndCharacteristics      = ipcCall('ble-getServicesChars',ipcRenderer)       
        spec.ble.subscribe        = ipcCall('ble-subscribe',ipcRenderer)       
        spec.ble.unsubscribe      = ipcCall('ble-unsubscribe',ipcRenderer)       
        spec.ble.read             = ipcCall('ble-read',ipcRenderer)       
        spec.ble.write            = ipcCall('ble-write',ipcRenderer)       
        spec.ble.setServerDebug   = ipcCallNoResponse('ble-setServerDebug',ipcRenderer)
        spec.ble.pauseLogging     = ipcCallNoResponse('ble-pauseLogging',ipcRenderer)
        spec.ble.resumeLogging    = ipcCallNoResponse('ble-resumeLogging',ipcRenderer)

        spec.ble.on = (ipcEvent, callback) => {
            ipcRenderer.on( ipcEvent, (_ipcEventInfo, event, ...args) => {
                try {
                    if (isTrue(process.env.IPC_DEBUG) ) 
                        console.log(`ipcEvent: ${ipcEvent}`,event, ...args)

                    if (callback && typeof callback === 'function') {
                        callback(event, ...args)
                    }

                }
                catch(err) {
                    console.log('~~~ IPCMain.error',err)
                }
            })
        }
       


        spec.registerFeatures( [
            'ble','ble-subscribe-fix', 'ble-pauseLogging'
        ] )  

    }


}

module.exports = BLEFeature;