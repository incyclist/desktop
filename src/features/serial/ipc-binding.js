let _api;

const SerialIpcBinding  = {
    async list () {
        return await IpcBinding.list('serial')
    },
    async open(options) {
        return await IpcBinding.open('serial',options)
    }
}

const TCPIpcBinding = {

    async list (port,excludes) {
        return await IpcBinding.list('tcpip',port,excludes)
    },
    async open(options) {
        return await IpcBinding.open('tcpip',options)
    }

}


const IpcBinding = {
    async list (interface,port,excludes) {
        if (_api) {
            return await _api.list(interface,port,excludes)
        }
    },
    
    async open(interface, options) {
        if (_api) {
            const id = await _api.open(interface,options)
            return new IpcPortBinding(interface,id)
        }

    },
    setApi(api) {
        _api = api;
    }

}


class IpcPortBinding {
   

    constructor(ifName,id) {
        this.interface = ifName
        this.id = id
        this.isClosing = false
        this.isReading = false

        // forward all events that are emitted by native binding
        //_api.onMessage( this.onMessage.bind(this) )
    }    

    // isOpen
    get isOpen() {        
        return _api.isOpen(this.id)
    }


    async close() {
        this.isClosing = true;
        return _api.close(this.id)
    }

    async read(buffer, offset, length) {

        let res,error;

        try {
            let success = false
            do {
                this.isReading = true
                res =  await _api.read(this.id,buffer,offset,length)
                this.isReading = false
                success = res && res.buffer && res.bytesRead;

            }
            while (!success && !this.isClosing)

            if (success) {
                const b = Buffer.from(res.buffer)
                b.copy(buffer,offset,offset,offset+res.bytesRead)
            }
            else {
                buffer = Buffer.from(res?.buffer|| [])
                bytesRead = 0;
            }
    
        }
        catch(err) {
            this.isReading = false
            error = err
            throw err
        }

        return { bytesRead:res.bytesRead, buffer}
    }

    async write(buffer) {

            const b= Buffer.from(buffer)
            //console.log('~~~write', b.toString('hex'), this.isOpen)
            return await _api.write(this.id,b)
    }


    async update(options) {
        const res = await _api.update(this.id,options)
        return res;
    }

    async set(options) {
        const res = await _api.set(this.id,options)
        return res;
    }

    async get() {
        const options = await _api.get(this.id)
        return options;

    } 

    async getBaudRate() {
        const baudRate = await _api.getBaudRate(this.id)
        return baudRate;
    } 

    async flush() {
        const res = await _api.flush(this.id)
        return res;
    }

    async drain() {
        const res = await _api.drain(this.id)
        return res;
    }

    /*
    onMessage(id,event,...data) {
        if (id!==this.id)
            return;
        console.log('~~~ EVENT', event,data)
    }
    */



}

module.exports = { SerialIpcBinding, TCPIpcBinding,IpcBinding,IpcPortBinding}