const events = require('events');

class NobleIpcBinding extends events.EventEmitter { 
    static _instance

    constructor() { 
        super(); 
        this.initialized = false
        this.api = undefined

        this._bindings = this;
        this._state = 'unknown'

        this.connectedDevices = [];
        

        // or lazy init bindings if someone attempts to get state first
        Object.defineProperties(this, {
            state: {
                get: () => {
                    if (!this.initialized && this.getApi()) {
                        this.init();
                        this.initialized = true;
                    }
                    return this._state;
                },
                set: (state) => {
                    this._state = state
                }
            }
        });
    }

    setApi(api) { 
        this.api = api;
    }

    getApi() {
        return this.api;
    }


    static getInstance() {
        if (!NobleIpcBinding._instance) {
            NobleIpcBinding._instance = new NobleIpcBinding();
        }
        return NobleIpcBinding._instance;
    }

    setServerDebug(enabled) {
        this.getApi().setServerDebug(enabled)

    }
    pauseLogging() {
        this.getApi().pauseLogging()
    }

    resumeLogging() {
        this.getApi().resumeLogging()
    }

    startScanning(serviceUUIDs, allowDuplicates, callback) {
        this.getApi().startScanning(serviceUUIDs, allowDuplicates).then( err => {
            if (callback) {
                callback(err);
            }
        })

    }
    stopScanning(callback) {
        this.getApi().stopScanning().then( () => {
            if (callback) {
                callback();
            }
        })

    }

    async connectDevice(peripheral) {
        const {id} = peripheral
        
        const cachedPeripheral = this.connectedDevices.find(d => d.id === id) 
        if (cachedPeripheral) {

            const {characteristics} = cachedPeripheral
            characteristics.forEach( c => {
                try {
                    c.unsubscribe()
                    c.removeAllListeners()
                }
                catch{}
            } )
            this.connectedDevices.splice( this.connectedDevices.indexOf(cachedPeripheral),1)
        }
        const error =  await this.getApi().connectDevice(id)
        if ( error ) 
            throw error;
        peripheral.state = 'connected';
        this.connectedDevices.push({id,peripheral});
    }

    async disconnectDevice(peripheral, callback) {
        const {id} = peripheral

        const cachedPeripheral = this.connectedDevices.find(d => d.id === id) 
        if (cachedPeripheral) {
            this.connectedDevices.splice( this.connectedDevices.indexOf(cachedPeripheral),1)
        }

        if (callback)
            callback(null)
    }

    async subscribe(peripheral,characteristic, callback) { 
        const {id} = peripheral;
        const {uuid} = characteristic;
        const err = await this.getApi().subscribe(id,uuid)
        if (callback) {
            callback(err);
        }
    }

    async unsubscribe(peripheral,characteristic, callback) { 
        const {id} = peripheral;
        const {uuid} = characteristic;
        const err = await this.getApi().unsubscribe(id,uuid)
        if (callback) {
            callback(err);
        }
    }


    async read(peripheral,characteristic, callback) { 
        const {id} = peripheral;
        const {uuid} = characteristic;
        const {err,data} = await this.getApi().read(id,uuid)
        
        if (callback) {
            callback(err,data);
        }
    }

    async write(peripheral,characteristic,data,withoutResponse, callback) { 
        const {id} = peripheral;
        const {uuid} = characteristic;
        try {
            const err = await this.getApi().write(id,uuid,data,withoutResponse)
            
            if (!withoutResponse && callback) {
                callback(err);
            }
        }
        catch(err) {
            if (!withoutResponse && callback) {
                callback(err);
            }

        }
    }


    async getServicesAndCharacteristics(peripheral,services, characteristics) { 
        //throw new Error('getServices not implemented')
        const {id} = peripheral

        const res =  await this.getApi().getServicesAndCharacteristics(id,services,characteristics)

        if ( res.error ) 
            throw res.error;

        if ( res.characteristics ) { 
            res.characteristics.forEach(c => {
                c.emitter = new events.EventEmitter();
                c.emit = (event,...args) => { c.emitter.emit(event,...args) }
                c.on = (event, callback) => { c.emitter.on(event, callback) }
                c.off = (event, callback) => { c.emitter.off(event, callback) }
                c.removeAllListeners = (event) => { c.emitter.removeAllListeners(event) }
                c.once = (event, callback) => { c.emitter.once(event, callback) }
                c.subscribe = (callback) => { this.subscribe(peripheral,c,callback) }
                c.unsubscribe = (callback) => { this.unsubscribe(peripheral,c,callback) }
                c.read = (callback) => { this.read(peripheral,c,callback)}
                c.write = (data, withoutResponse, callback) => { this.write(peripheral,c,data,withoutResponse,callback)}

            })
        }

        let found = this.connectedDevices.find(d => d.id === id)
        if (found) {
            found.services = res.services;
            found.characteristics = res.characteristics;
        }
        
        return {services:res.services, characteristics:res.characteristics};

    }

    async getServices(peripheral,services) { 
        //throw new Error('getServices not implemented')
        const {id} = peripheral

        const res =  await this.getApi().getServices(id,services)
        if ( res.error ) 
            throw res.error;


        let found = this.connectedDevices.find(d => d.id === id)
        if (found) {
            found.services = res.services;
        }
        
        return res.services;
    }

    init() {
       this.getApi().on('ble-event', (event, ...args) => { 

            if (event==='discover') {
                const peripheral = args[0];
                peripheral.emitter = new events.EventEmitter();
                peripheral.connectAsync = ()=> {
                    return this.connectDevice(peripheral); 
                }
                peripheral.discoverServicesAsync = (services)=> {
                    return this.getServices(peripheral,services);
                }

                peripheral.discoverSomeServicesAndCharacteristicsAsync = (services,characteristics)=> {
                    return this.getServicesAndCharacteristics(peripheral,services,characteristics);
                }
                peripheral.disconnect = (cb) => {
                    return this.disconnectDevice(peripheral,cb)
                }
                peripheral.disconnectAsync = () => {
                    return new Promise ( (done)=> { 
                        this.disconnectDevice(peripheral,done) 
                    })
                }

                peripheral.on = (event, callback) => { peripheral.emitter.on(event, callback) }              
                peripheral.off = (event, callback) => { peripheral.emitter.off(event, callback) }              
                peripheral.once = (event, callback) => { peripheral.emitter.once(event, callback) }            
                peripheral.removeAllListeners = (event) => { peripheral.emitter.removeAllListeners(event) } 
                peripheral.emit = (event,...args) => { peripheral.emitter.emit(event,...args) }    
                

                this.emit(event,  peripheral) ;
            }
            else if (event==='data') {
                const peripheralId = args[0];
                const characteristicId = args[1];
                const data = args[2];
                const isNotification = args[3];

                const peripheral = this.connectedDevices.find(d => d.id === peripheralId)
                if (peripheral) { 
                    const characteristic = peripheral.characteristics.find(c => c.uuid === characteristicId)
                    if (characteristic) {
                        characteristic.emit('data', data, isNotification)
                    }
                }
            }
            else if (event==='peripheral-event') {

                const _event = args[0]
                const peripheralId = args[1];
                const data = args.splice(2);
                const device = this.connectedDevices ? this.connectedDevices.find(d => d.id === peripheralId): undefined

                if (device) { 
                    const peripheral = device.peripheral;
                    peripheral.state = 'disconnected';

                    const idx = this.connectedDevices.findIndex(d => d.id === peripheralId)
                    this.connectedDevices.splice(idx,1)
                    peripheral.emitter.emit(_event, ...data)

                }
            }
            else {
                this.emit(event, ...args) ;
            }
       })

       this.getApi().onEvent('stateChange');
       

       this.getApi().init().then(state => {
            this.emit('stateChange', state);
        })
    }

    onEvent(event, callback, ...args) { 
        if (event === 'stateChange') {
            this._state = args[0];
        }

        callback(...args)
    }


    on(event, callback) { 

        if (event === 'stateChange') {
            if (!this.initialized) {
                if ( this.getApi() ) {
                    this.init();
                    this.initialized = true;
                }
                
            }
        }        
        
        if (this.getApi())  {
            this.getApi().onEvent(event)
        }
        
        
        super.on(event, (...args) => { this.onEvent(event,callback, ...args) });

    }



}





module.exports =  NobleIpcBinding;

