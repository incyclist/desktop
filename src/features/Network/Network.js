const net = require ('net')
const { networkInterfaces } = require('os');

const DEFAULT_SCAN_TIMEOUT = 10000; 

class _Helper  {
    scanPort( host,port ) {
        return new Promise( (resolve, reject) => {
            try {
                //console.log('scanning',host,port)
                const socket = new net.Socket();
                let done = false;

                socket.setTimeout(500,(e) =>{done=true;})
                socket.on('timeout',()=>{ 
                    reject('timeout'); 
                    socket.removeAllListeners();
                    socket.destroy();
                })
                socket.on('error',(err)=>{ 
                    reject(err); 
                    socket.removeAllListeners();
                    socket.destroy();
 
                })
        
                socket.once('ready',()=>{
                    if (!done) {
                        resolve(host)
                    }
                    socket.destroy();

                })
                socket.connect( port, host );
            }
            catch (err) {
                reject(err)
            }
        
        })
    
    }
    
    
    getLocalNetworkSubnets() {
        const nets = networkInterfaces();
    
        const address = Object.keys(nets)
        // flatten interfaces to an array
        .reduce((a, key) => [
            ...a,
            ...networkInterfaces()[key]
        ], [])
        // non-internal ipv4 addresses only
        .filter(iface => iface.family === 'IPv4' && !iface.internal && iface.netmask==='255.255.255.0')
        .map( iface => { 
            const parts = iface.address.split('.');
            return `${parts[0]}.${parts[1]}.${parts[2]}`    
        })
    
        const subnets  = address.filter((x, i) => i === address.indexOf(x))
        subnets.push('127.0.0')
        return subnets;
    }
    
}


/** 
 * 
 *  @typedef ScanProps
 *  @property {number} timeout 
**/

/** 
 *  scan local networks to find hosts that have a specific port opened
 * 
 *  @param {number} port
 *  @param {ScanProps} props
 * 
 *  @return {Promise< Array<string> >} hosts
 */

function scan( port,props={timeout:DEFAULT_SCAN_TIMEOUT} ) {
    return new Promise( async (resolve, reject) => {
        if (!port)
            return reject( new Error('no port specified') )
        const helper = new _Helper();
        const subnets = helper.getLocalNetworkSubnets()                 
        const hosts = [];
        const range = [];
        for (let i=1;i<255;i++) range.push(i)
    
        let completed = 0;
        let total = subnets.length*254;
        const start = Date.now();
        const timeout = start+props.timeout;

        subnets.forEach( async sn => {           
            range.forEach( async j => {
                const host = `${sn}.${j}`
                helper.scanPort(host,port)
                    .then( r=> { 
                        completed++; hosts.push(r); return r
                    })
                    .catch(err =>{   
                        completed++;
                    });
                
            })
        })             
        
        const iv = setInterval( ()=> {
            if ( completed>=total || Date.now()>timeout) {
                resolve(hosts);
                console.log(completed,total)
                clearInterval(iv)
            }
        },100)
    })
}

module.exports = {scan,_Helper}