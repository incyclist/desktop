const WinrtBindings = require ('../../src/features/ble/bleserver-binding');

let ble;
let prevAddress;

const onInit = async (path)=> {
    ble = WinrtBindings.getInstance('../..')
    ble.initApp = ()=>{}

    ble.on('error',onError)
    ble.on('stateChange', OnStateChange)
    ble.on('discover',onDiscover)
    ble.on('notify',onNotify)

    if (path) {
        ble.app = path
    }
    else {
        ble.app = './bin/win32-x64/BLEServer.bin'
    }
    await ble.init()
}

const onError = ( err) => {
    console.log('\nERROR:\n', err,"\n> ")
}

const onScan = (services='all', allowDuplicates=true)=> { 
    serviceUUIDs = services === 'all' ? [] : services??[].split(',')
    ble.startScanning(serviceUUIDs, allowDuplicates)
}

const onStopScan = (services='all', allowDuplicates=true)=> { 
    serviceUUIDs = services === 'all' ? [] : services??[].split(',')
    ble.stopScanning(serviceUUIDs, allowDuplicates)
}

const onDiscover = ( ...args) => {
    console.log('>discovered',...args)
}

const onNotify = ( ...args) => {
    console.log('>notify',...args)
}


const OnStateChange = ( newState) => {
    console.log('\nSTATE:\n', newState,"\n> ")
}

const onConnect = async (address)=> {
    address = verifyAddress(address)
    if (!address) return;

    await ble.connect(address)
}


const onDisconnect = async (address,emit=true)=> { 
    address = verifyAddress(address)
    if (!address) return;

    await ble.disconnect(address)
}

const onServices = async (address,filters='')=> { 
    address = verifyAddress(address)
    if (!address) return;

    const services = filters.split(',')??[]

    const found = await ble.discoverServices(address,services)
    console.log('Services: ', found)
}

const onCharacteristics = async (...args)=> { 

    let address, service,filters
    if (args.length===3) {
        address = args[0]
        service = args[1]
        filters = (args[2]??'').split(',')
    }
    else {
        service = args[0]
        filters = (args[1]??'').split(',')
    }
    address = verifyAddress(address)
    if (!address) return;

    const found = await ble.discoverCharacteristics(address,service,filters)
    console.log('Characteristics: ', found)
}

const onSubscribe = async (...args)=> { 
    let address, service,characteristic,notify 
    if ( args.length<=3) {
        address = verifyAddress(undefined)
        service = args[0]
        characteristic = args[1]
        notify = strToBool(args[2])
    }
    else {
        address = verifyAddress(args[0])
        service = args[1]
        characteristic = args[2]
        notify = strToBool(args[3])
    }
    
    if (!address) return;
    await ble.notify(address,service,characteristic,notify)
    
}

const verifyAddress = (address)=>{
    if (!address) {
        if (!prevAddress) {
            console.log('please specify the address')
            return null
        }
        address = prevAddress
    }
    if (address.includes(':'))
        address = address.split(':').join('')

    prevAddress = address
    return address
}

const strToBool = (s) => {
    // will match one and only one of the string 'true','1', or 'on' regardless
    // of capitalization and regardless of surrounding white-space.
    //
    regex=/^\s*(true|1|on)\s*$/i

    return regex.test(s);
}

module.exports = {
    onInit, 
    onScan, 
    onStopScan,
    onConnect,
    onDisconnect,
    onServices,
    onCharacteristics,
    onSubscribe,
}