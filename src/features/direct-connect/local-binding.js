const { Bonjour } = require('bonjour-service')
const net = require('net');

const createBinding = ()=>{
    return {
        mdns: new MDNSBinding(),
        net      
    }
}

class MDNSBinding {
    
    connect() {
        this.bonjour = new Bonjour()
        
    }

    disconnect() {
        if (this.bonjour) {
            this.bonjour.destroy()
            this.bonjour = null
        }
    }

    find(opts , onUp) {
        this.bonjour.find(opts, (s)=>{ 
            this.handleAnnouncement(s,onUp) 
        })
    }       

    handleAnnouncement(service,callback) {
        const {name,txt,port,referer,protocol} = service
        const announcement = {
            name,address:referer?.address,protocol,port,
            serialNo:txt?.['serial-number'], 
            serviceUUIDs:txt?.['ble-service-uuids']?.split(',')
        }
        if (callback)
            callback(announcement)
    }
        

}
