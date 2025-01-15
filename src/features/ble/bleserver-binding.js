// noble-winrt
// Copyright (C) 2017, Uri Shaked
// License: MIT

const { spawn } = require('child_process');
const nativeMessage = require('chrome-native-messaging');
const events = require('events');
const { EventLogger } = require('gd-eventlog');
const os = require('os')
const path = require('path')
const fs = require('fs')
const axios = require('axios');
const {checkDir} = require('../../utils')
const DEFAULT_UPDATE_SERVER_URL_DEV  = 'http://localhost:4000';
const DEFAULT_UPDATE_SERVER_URL_PROD = 'https://updates.incyclist.com';
const DEFAULT_UPDATE_SERVER_URL = process.env.ENVIRONMENT=='dev' ? DEFAULT_UPDATE_SERVER_URL_DEV : DEFAULT_UPDATE_SERVER_URL_PROD;
const { app } = require('electron');
const { isArrayBuffer } = require('util/types');


const server = DEFAULT_UPDATE_SERVER_URL;

const uuid = (s) => {
    //console.log(s)
    if (s) {
        if (s.includes('-')) {
            const parts = s.split('-')
            const uuidNo = parseInt('0x'+parts[0])
            return uuidNo.toString(16)
        }
        return s;
    }
}


const matches = (uuid1,uuid2) => {
    const ul1 = uuid1.toLowerCase()
    const ul2 = uuid2.toLowerCase()

    if (uuid(ul1)===uuid(ul2))
        return true;
 
    if (ul1.length<ul2.length && ul2.startsWith(ul1))
        return true
    return ul1.length>ul2.length && ul1.startsWith(ul2);

}

const sleep = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}   

function toWindowsUuid(uuid) {
    return '{' + uuid + '}';
}

function fromWindowsUuid(winUuid) {
    
    return winUuid.replace(/\{|\}/g, '');

}


class WinrtBindings extends events.EventEmitter {
    static _instance
    
    constructor(appDirectory, props={}) { 
        super();
        this.logger = new EventLogger('BLE');
        this.app = undefined;
        this.appDirectory = appDirectory;        
        this.bleServerDebug = props.bleServerDebug || true
        this.loggingPaused = false
        this.advertisements = {}
       
    }

    static getInstance(appDirectory,props={}) {
        if (!WinrtBindings._instance) {
            WinrtBindings._instance = new WinrtBindings(appDirectory,props);
        }
        return WinrtBindings._instance;
    }


    setServerDebug(bleServerDebug) {
        this.bleServerDebug = bleServerDebug
    }

    pauseLogging() {
        this.loggingPaused = true;
    }

    resumeLogging() {
        this.loggingPaused = false;        
    }

    logEvent(e) {

        //console.log('~~~ BLE Server',e, this.loggingPaused)
        if (this.loggingPaused)
            return 
        this.logger.logEvent(e)
    }

    getName(headers) {
        if (!headers || !headers['content-disposition'])
            return undefined;

        let fileName =  headers['content-disposition'].split('filename=')[1];
        fileName = fileName.replace(/\"/g, '')
        return fileName
    }

    download(overwrite=false) {

        const platform = os.platform();
        if ( platform !== 'win32' ) {             
            return Promise.reject( new Error('BLE WinRT Binding only supported on Windows') );
        }

        let binDir;
        
        try {
            binDir = path.join( this.appDirectory, `./bin`)
            const appPath = path.join( binDir, './BLEServer.exe')
            if ( fs.existsSync(appPath) && !overwrite ) {
                this.app = appPath;
                this.logEvent({message:'BLEServer file exists, not downloading'})
                return Promise.resolve(true)
            }
        }
        catch(err) {
            this.logEvent({message:'error',fn:'download()', err: err.message,stack: err.stack});
            return Promise.reject(err)
        }


        return new Promise( (resolve,reject) => {
            this.updateBusy = true;
            const arch = os.arch();
            const downloadUrl = `${server}/download/ble/${arch}/BLEServer.exe`           
            this.logEvent({message:'start downloading',url:downloadUrl});
    
            try {
                axios.get( downloadUrl, {responseType: 'stream'})
                .then( response => {
                    
                    try {
                        const name = this.getName(response.headers) || 'BLEServer.exe';          
                        const fullPath = path.join( binDir, `./${name}`)
                        
                        this.logEvent({message:'download success - saving', path: fullPath});

                        checkDir(binDir);
                        if (response.data.pipe) {
                            const writer = fs.createWriteStream(fullPath)
                            response.data.pipe(writer);
                
                            let error;
                
                            writer.on('error', err => {
                                writer.close();
                                this.updateBusy = false;
                                reject(err);
                                this.logEvent( {message: 'saving error', err: err.message,stack: err.stack})
                            });
                            writer.on('close', () => {
                                writer.end();

                                if (!error) {   
                                    this.app = fullPath
                                    this.updateBusy = false;
                                    
                                    setTimeout(()=>{
                                        resolve(true);                                        
                                        this.logEvent({message:'saving success', path: fullPath});
                                    },500)
                                    
                                    
                                }
                                //no need to call the reject here, as it will have been called in the
                                //'error' stream;
                            });    
                        }
                        else {
                            fs.writeFile(fullPath, Buffer.from(response.data),'binary', err => {
                                if (err) { 
                                    this.updateBusy = false;
                                    reject(err);
                                    this.logEvent( {message: 'saving error', err: err.message,stack: err.stack})
                                    return;
                                }
                                this.app = fullPath
                                this.updateBusy = false;
                                resolve(true);
                                this.logEvent({message:'saving success', path: fullPath});

                            });
                        }
    
                        
                    }
                    catch(err) { 
                        this.logEvent({message:'download error', err: err.message,stack: err.stack});
                    }
                })
                .catch(err => {
                    this.logEvent( {message: 'download error', err: err.message,stack:err.stack})
                    this.updateBusy = false;
                    reject(err);
                })
                .finally( ()=> {
                    this.updateBusy = false;
                })    
            }
            catch(err) {
                console.log ('~~~error', err)
            }

           
        })
    }

    initBleServer() {
        this._bleServer.stdout
        .pipe(new nativeMessage.Input())
        .on('data', (data) => {
            this._processMessage(data);
        });
        this._bleServer.stderr.on('data', (data) => {
            console.error('BLEServer:', data);
        });
        this._bleServer.on('close', (code) => {
            if (this.state!=='poweredOff') {
                this.state = 'poweredOff';
                this.emit('stateChange', this.state);
            }
        });
        this._bleServer.on('exit', (code) => {
            if (this.state!=='poweredOff') {
                this.state = 'poweredOff';
                this.emit('stateChange', this.state);    

                this._bleServer.removeAllListeners()
                delete this._bleServer;
                this.launchBleServer()
            }            
        });
        this._bleServer.on('error', (err) => {
            this.logEvent({message:'BLE Server error', error:err.message})
        });
        this._bleServer.stdin.on('error', (err) => { 
            this.logEvent({message:'BLE Server error (stdin)', error:err.message??err})
            
        })
        this._bleServer.stdout.on('error', (err) => { 
            this.logEvent({message:'BLE Server error (stdout)', error:err.message??err})
        })
    }

    initApp() {
        const incyclistBinaryPath = app.getPath('exe');
        const parts = path.parse(incyclistBinaryPath);
        this.logEvent({message:'app information',parts})

        if (parts.name.toLowerCase()==='incyclist') { // production binary            
            const bleServerPath = path.join( parts.dir, './BLEServer.bin')
            this.logEvent({message:'checking if BLEServer is pre-bundled',appPath: bleServerPath})                
            if ( fs.existsSync(bleServerPath) ) {
                this.app = bleServerPath;
                this.logEvent({message:'BLEServer is pre-bundled'})                
            }        
        }
    }

    async init() {
        const platform = os.platform();
        if ( platform !== 'win32' ) {             
            return Promise.reject( new Error('BLE WinRT Binding only supported on Windows') );
        }


        this._prevMessage = '';
        this._deviceMap = {};
        this._requestId = 0;
        this._requests = {};
        this._subscriptions = {};

        
        this.initApp();
    
        this.logEvent({message:'init',app:this.app });

        try {
            if (!this.app) 
                await this.download()
            if (this.app) {
                this.launchBleServer()
            }    
    
        }
        catch (err) {
            this.logEvent({message:'error',fn:'init()', err: err.message,stack: err.stack});
            this.emit('error',err)
        }

        
    }

    launchBleServer() {
        this._bleServer = spawn(this.app, ['']);
        this.initBleServer();
    }

    startScanning(serviceUUIDs, allowDuplicates) {
        this.scanResult = {};
        this.scanProps = {
            allowDuplicates,
            targets: serviceUUIDs
        }
        this.scanStatus = 'starting'
        this._sendMessage({ cmd: 'scan' });
    }

    stopScanning() {
        this.scanStatus = 'stopping'
        this.scanProps = undefined
        this._sendMessage({ cmd: 'stopScan' });
    }

    connect(address) {
        this.logEvent({message: 'BLEServer connect', address});
        
        return this._sendRequest({ cmd: 'connect', 'address': address })
        .then(result => {
            this._deviceMap[address] = result;
            this.emit('connect', address, null);
        })
        .catch(err => this.emit('connect', address, err));


    }

    async reconnect(address, retries=5) {
        this.logEvent({message: 'BLEServer reconnect', address});

        const connectAttempt = () => {
            return new Promise ( resolve => {
                this._sendRequest({ cmd: 'connect', 'address': address })
                .then(result => {
                    resolve(true)                    
                })
                .catch(err => resolve(false));    
            })
        }

        let success = false;
        while (!success) {
            success = await connectAttempt()
            await sleep(1000)
        }

        return success;

    }

    disconnect(address) {
        
        this.logger.logEvent({message: 'BLEServer disconnect', address});       // always log - also when logging is disabled
        this._sendRequest({ cmd: 'disconnect', device: this._deviceMap[address] })
            .then(result => {
                this._deviceMap[address] = null;
                this.emit('disconnect', address, null);
            })
            .catch(err => this.emit('disconnect', address, err));
    }

    discoverServices(address, filters = []) {
        this.logEvent({message: 'BLEServer discoverServices', address, filters});
        this._sendRequest({ cmd: 'services', device: this._deviceMap[address] })
            .then(result => {
                try {
                    const sids = result.map(fromWindowsUuid).map( s => ({uuid:s, uuid_short:uuid(s)}))
                    let services = result.map(fromWindowsUuid)
                    if (filters && filters.length>0) {                       
                        services = sids.filter( (s) => filters.find(sid => s.uuid_short===sid) ).map(s=>s.uuid)
                    }
                       
                    this.emit('servicesDiscover', address, services);
    
                }
                catch(err) {
                    console.log(err)
                }
            })
            .catch(err => this.emit('servicesDiscover', address, err));
    }


    discoverCharacteristics(address, service, filters = []) {
        this.logEvent({message: 'BLEServer discoverCharacteristics', address,service,filters});

        this._sendRequest({
            cmd: 'characteristics',
            device: this._deviceMap[address],
            service: toWindowsUuid(service),
        })
            .then(result => {
                
                this.logEvent({message: 'BLEServer characteristics:', info: result.map( c => `${address} ${fromWindowsUuid(c.uuid)}  ${Object.keys(c.properties).filter(p => c.properties[p])}`)});

                this.emit('characteristicsDiscover', address, service,
                    result.map(c => ({
                        uuid: fromWindowsUuid(c.uuid),
                        properties: Object.keys(c.properties).filter(p => c.properties[p])
                    })));
            })
            .catch(err => this.emit('characteristicsDiscover', address, service, err));
    }

    read(address, service, characteristic) {
        this.logEvent({message: 'BLEServer read', address,service,characteristic});
        this._sendRequest({
            cmd: 'read',
            device: this._deviceMap[address],
            service: toWindowsUuid(service),
            characteristic: toWindowsUuid(characteristic)
        })
            .then(result => {
                this.emit('read', address, service, characteristic, Buffer.from(result), false);
            })
            .catch(err => this.emit('read', address, service, characteristic, err, false));

    }

    notify(address, service, characteristic, notify) {
        if (!notify) {
            this.emit('notify', address, service, characteristic, notify);
            return;
        }

        try {
            const keys = Object.keys(this._subscriptions);
            const existing = keys.find( sid => { 
                const s = this._subscriptions[sid];
                return (s.address===address && s.service===service && s.characteristic === characteristic) 
            })

            if (existing) {
                this.emit('notify', address, service, characteristic, notify);
                return;
            }
    
        }
        catch(err) {
            console.log('~~~ error',err)
        }

        this._sendRequest({
            cmd: notify ? 'subscribe' : 'unsubscribe',
            device: this._deviceMap[address],
            service: toWindowsUuid(service),
            characteristic: toWindowsUuid(characteristic)
        })
            .then(result => {
                if (notify) {
                    this._subscriptions[result] = { address, service, characteristic };
                }
                this.emit('notify', address, service, characteristic, notify);
            })
            .catch(err => this.emit('notify', address, service, characteristic, err));
    }

    _processMessage(message) {
        try {
            let isPeripheralValid;
            switch (message._type) {
                case 'Start':
                    if (this.bleServerDebug)
                        this.logEvent( {message:'BLEserver in:', type:'Start', state:'poweredOn'});
    
                    this.state = 'poweredOn';
                    this.emit('stateChange', this.state);
                    break;
    
                case 'scanResult':
                    this.processScanResult(message, isPeripheralValid);
                    break;
    

                    
    
                case 'response':
                    {
                        if (this._requests[message._id]) {
                            const request = this._requests[message._id];
                            if (message.error) {
                                if (this.bleServerDebug)
                                    this.logEvent( {message:'BLEserver in:', type:'response error', _id:message._id,  error:message.error,request});
        
                                this._requests[message._id].reject(new Error(message.error));
                            } else {
                                let result = message.result;
                                try {
                                    const data = result && isArrayBuffer(result)? Buffer.from(result).toString('hex') : result
                                    if (this.bleServerDebug)
                                        this.logEvent( {message:'BLEserver in:', type:'response', _id:message._id, data,request});
                                }
                                catch(err) {
                                    console.log('~~~ BLE Server', message, err)
                                }
                                this._requests[message._id].resolve(result);
                            }
                            delete this._requests[message._id];
                        }
                        else if (this._prevMessage && this._prevMessage.cmd === 'scan')   {
                            if (this.bleServerDebug)
                                this.logEvent( {message:'BLEserver in:', request:'scan', result:'ok'});
        
                            this.scanStatus = 'started'
                            this.emit('scanStart',false);
                        }
                        else if (this._prevMessage && this._prevMessage.cmd === 'stopScan')   {
                            if (this.bleServerDebug)
                                this.logEvent( {message:'BLEserver in:', request:'stopScan', result:'ok'});
                            this.scanStatus = 'stopped'
                            this.emit('scanStop',false);
                        }
                        else {
                            if (this.bleServerDebug)
                                this.logEvent( {message:'BLEserver in:', type:'response', _id:message._id, result:message.result});
                        }
                    }
                    break;

    
                case 'disconnectEvent':
                    {
                        let processed = false;
    
                        for (let address of Object.keys(this._deviceMap)) {
                            const requestIds = Object.keys(this._requests);
        
                            const disconnectRequest = requestIds.find( i => {
                                const r = this._requests[i];
                                return (r.message && r.message.cmd==='disconnect' && r.message.address===address)
                            });
        
                            if (disconnectRequest) {
                                if (this._deviceMap[address] == message.device) {
                                    this._deviceMap[address] = null;
                                    processed = true;
                                    this.emit('disconnect', address);
                                }                            
                                if (this.bleServerDebug)
                                    this.logEvent( {message:'BLEserver in:', type:'response', address, request:'disconnect',result:'ok' });
                            }
                            else {
        
                                if (this._deviceMap[address] == message.device) {
                                    this._deviceMap[address] = null;

                                    if (!processed)
                                        this.logEvent( {message:'BLEserver in:', type:'disconnect', device:message.device});
            
                                    processed = true;
                                    this.emit('disconnect', address);
                                }                                    
        
                            }
        
                            
                        }
        
                        if (!processed)
                            this.logEvent( {message:'BLEserver in:', type:'disconnect', device:message.device});
        
    
                    }
                    break;
    
                case 'valueChangedNotification':
                    {
                        const subscription  = this._subscriptions[message.subscriptionId]
                        if (subscription) {
                            const { address, service, characteristic } = subscription;
                            const data = message.value ? Buffer.from(message.value).toString('hex') : message.value
                            if (this.bleServerDebug)
                                this.logEvent( {message:'BLEserver in:', type:'notify', address, service:uuid(service), characteristic:uuid(characteristic), data });
                
                            this.emit('read', address, service, characteristic, Buffer.from(message.value), true);
                        }
    
                    }
                  
                    break;
            }
    
        }
        catch(err) {
            this.logEvent({message:'error', fn:'_processMessage', error:err.message, in:message})
        }


    }

    processScanResult(message, isPeripheralValid) {
        {
            const advertisement = this.buildAdvertisement(message);
            const { advType } = message;
            const { address, localName, serviceUuids, uuid,rssi,ts } = advertisement;

            try {
                if (this.bleServerDebug && !ts) {
                    this.logEvent({ message: 'BLEserver in:', type: 'scanResult', address, localName, serviceUuids, advType, rssi});

                    // update timestamp
                    advertisement.ts = Date.now()
                    this.advertisements[address] = advertisement
                }
            }
            catch (err) {
                console.log('~~~ BLEServer in', message, err);
            }

            switch (advType) {
                case 'NonConnectableUndirected':
                    break;
                case 'ConnectableUndirected':
                case 'ScanableUndirected':

                    isPeripheralValid = true;

                    if (this.scanProps && this.scanProps.emitted && Array.isArray(this.scanProps.emitted)) {
                        if (this.scanProps.emitted.find(e => e === address) !== undefined)
                            isPeripheralValid = false;
                    }

                    //console.log( '~~~ found',address,isPeripheralValid,this.scanProps.targets,this.scanProps.emitted, advertisement.serviceUuids) //.map( sid ) )  => ({sid,valid:matches(sid,this.scanProps.targets[0],sid)})))
                    if (isPeripheralValid) {

                        this.scanResult[address] = { uuid, address, advertisement };
                        if (address !== undefined && address !== '' &&
                            advertisement.localName && advertisement.localName !== '' &&
                            advertisement.serviceUuids == advertisement.serviceUuids.length > 0) {
                            this.emit(
                                'discover',
                                uuid,
                                address,
                                'public', // TODO address type
                                true, // TODO connectable
                                advertisement,
                                message.rssi);
                        }
                        if (this.scanProps) {
                            if (!this.scanProps.emitted)
                                this.scanProps.emitted = [];
                            this.scanProps.emitted.push(address);
                        }

                    }

                    break;
                case 'ScanResponse':

                    let d = this.scanResult[address];
                    if (!d)
                        d = this.scanResult[address] = { uuid, address, advertisement };
                    else {
                        if (d.advertisement.localName === '' && advertisement.localName !== '')
                            d.advertisement.localName = advertisement.localName;
                        if (advertisement.serviceUuids)
                            advertisement.serviceUuids.forEach(sid => {
                                if (!d.advertisement.serviceUuids)
                                    d.advertisement.serviceUuids = [];
                                if (!d.advertisement.serviceUuids.find(sid1 => sid1 === sid))
                                    d.advertisement.serviceUuids.push(sid);
                            });
                    }

                    isPeripheralValid = true;
                    if (isPeripheralValid) {

                        this.emit(
                            'discover',
                            uuid,
                            address,
                            'public', 
                            true, 
                            d.advertisement,
                            message.rssi);
                        if (this.scanProps) {
                            if (!this.scanProps.emitted)
                                this.scanProps.emitted = [];
                            this.scanProps.emitted.push(address);
                        }


                    }

                    break;

            }
        }
        return isPeripheralValid;
    }

    buildAdvertisement(message) {
        const address =   message.bluetoothAddress;

        let uuid = address
        uuid = uuid.replace(/:/g, '')

        const existing = this.advertisements[address]??{}

        const previous = {...existing}
        delete previous.ts
        delete previous.rssi
        
        const getServices = () => {
            const uuids = existing.serviceUuids??[]
            const announced = message.serviceUuids.map(fromWindowsUuid)
            if (announced) {
                announced.forEach( uuid =>  {
                    if (!uuids.includes(uuid))
                        uuids.push(uuid)
                })
            }
                
            return uuids
        }

        const getName = ()=> {
            const announced = message.localName
            return announced?.length>0  ? announced : existing.localName??''
        }

        const advertisement =  {
            uuid,
            address,
            localName: getName(),
            serviceUuids: getServices(),
            serviceData: [],
        };

        if ( JSON.stringify(advertisement) === JSON.stringify(previous)) {
            advertisement.ts = existing.ts
        }
        advertisement.rssi = message.rssi
        
        this.advertisements[address] = advertisement
        return advertisement
    }

    _sendMessage(message) {
        if (this.bleServerDebug)
            this.logEvent({message: 'BLEServer out:', msg:message});
        
        try {
            this._prevMessage = message
            const dataBuf = Buffer.from(JSON.stringify(message), 'utf-8');
            const lenBuf = Buffer.alloc(4);
            lenBuf.writeInt32LE(dataBuf.length, 0);
            this._bleServer.stdin.write(lenBuf);
            this._bleServer.stdin.write(dataBuf);
            return null;
        }
        catch(err) {
            return err;            
        }
    }

    _sendRequest(message) {
        return new Promise((resolve, reject) => {
            const requestId = this._requestId++;
            this._requests[requestId] = { message,resolve, reject };
            const err = this._sendMessage(Object.assign({}, message, { _id: requestId }));
            if (err) {
                reject(err)
            }
        });
    }

    async write(address, service, characteristic, data, withoutResponse,callback) {
        this.logEvent({message: 'BLEServer write', address,service,characteristic,data, withoutResponse});
        // TODO data, withoutResponse
        try {
            const res = await this._sendRequest({
                cmd: 'write',
                device: this._deviceMap[address],
                service: toWindowsUuid(service),
                characteristic: toWindowsUuid(characteristic),
                value: Array.from(data),
            })

            if (callback)
                callback(res)
            return res
        }
        catch(err) {
            console.log( '~~~ BLEServer Write Error', err.message, callback)
            if (callback)
                callback(err)
            return err
        }
        /*
            .then(result => {
                this.emit('write', address, service, characteristic);
            })
            
            .catch(err => {
                console.log('~~~~ WRITE ERROR',err.message, caller)
                this.emit('write', address, service, characteristic, err)

                
            });
        */  
    }    
}

module.exports = WinrtBindings 

