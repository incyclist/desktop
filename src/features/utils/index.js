const path = require('path');
const os = require('os');
const { app } =  require('electron');


let cnt =0;


function isTrue (val)  {
    if (typeof(val)==="string")
        return val.toLowerCase()==="true" || val.toLowerCase()==="yes" || val.toLowerCase()==="1";

    if (val) return true;
    return false;
}

function getFileInfo ( urlStr, scheme='file') {

    const decoded = (str) => { 
        try {
            return decodeURI(str)
        }
        catch(err) { 
            return str
        }
        //catch { return str}
    }

    const decodedUrl = (urlStr.startsWith('http')||scheme.startsWith==='http') ? decoded(urlStr): urlStr;

    let pathInfo;
    try {
        if (scheme.startsWith('http')) {
            const urlParts = decodedUrl.split('://') 
            pathInfo = path.parse(urlParts[1])
            pathInfo.name = pathInfo.base;
            pathInfo.filename = scheme+'://'+pathInfo.dir+path.sep+pathInfo.name;
            pathInfo.outFile = pathInfo.filename;
            pathInfo.ext = pathInfo.ext.substring(1)
            pathInfo.host = pathInfo.dir.split('/')[0]
            pathInfo.dir = pathInfo.dir.split('/').slice(1).join('/')

            return pathInfo

        }
        else if ( decodedUrl.startsWith(`${scheme}:`)) {
            const urlParts = scheme.startsWith('http') ? decodedUrl.split('://') : decodedUrl.split(':///')
            pathInfo = path.parse(urlParts[1])
            pathInfo.name = pathInfo.base;
            pathInfo.filename = pathInfo.dir+path.sep+pathInfo.name;
            pathInfo.outFile = pathInfo.filename;
            pathInfo.ext = pathInfo.ext.substring(1)

            return pathInfo
            
        }
        else pathInfo = newURL(decodedUrl)

        let filename = pathInfo.pathname;

        const parts = filename.split('.');
        const ext = parts[parts.length-1];

        if ( filename.charAt(0)==='/' && filename.charAt(2)===':') 
            filename = filename.substring(1);
        let outFile = filename;

        return { filename, outFile,ext}

    }
    catch (err) {
        return {}
    }
}

function serveFile(url, _request,callback) {
    const outFile = decodeURI(url);
    callback( { path:outFile} )
}

function ipcResponse(sender,key,id,result,err) {
    if (process.env.IPC_DEBUG)
        console.log(`ipcCall response: ${key} (${id})`,result!=undefined, err!==undefined)
    try {
        sender.send(`${key}:response:${id}`, result,err)
    }
    catch {}
} 

function ipcServe(event,callId,key,fn) {
    fn()
        .then( res => ipcResponse(event.sender,key,callId,res))
        .catch( err => ipcResponse(event.sender,key,callId,null))
}

function ipcServeSync(event,callId,key,fn) {
    try {
        const res = fn();
        ipcResponse(event.sender,key,callId,res)
    }
    catch(err) {
        ipcResponse(event.sender,key,callId,null)
    }
}

function ipcCall(key,ipcRenderer, props={}) {
    return  (...args)=> {
        cnt = ++cnt % 1000
        const id = props.id || `${Date.now()}-${cnt}`;
        
        if (isTrue(props.debug) || isTrue(process.env.IPC_DEBUG) ) 
            console.log(`ipcCall: ${key} (${id})`)
        
        return new Promise( (resolve,reject) => {
            ipcRenderer.send(key,id,...args);        
          
            ipcRenderer.once(`${key}:response:${id}` , (event,result,error) => {
                if (isTrue(props.debug) || isTrue(process.env.IPC_DEBUG) ) 
                    console.log(`ipcCall response: ${key} (${id})`,result!==undefined,error)
                if (error)
                    reject(error)
                resolve(result);            
            })
        
        })
      }

}

function ipcCallNoResponse(key,ipcRenderer, props={}) {
    return  (...args)=> {
        const id = props.id || Date.now();
        if (isTrue(props.debug) || isTrue(process.env.IPC_DEBUG) ) 
            console.log(`ipcCall: ${key} (${id})`)
        
        ipcRenderer.send(key,...args);               
      }

}

function ipcCallSync(key,ipcRenderer, props={}) {
    return  (...args)=> {        
        if (isTrue(props.debug) || isTrue(process.env.IPC_DEBUG) ) 
            console.log(`ipcCall: ${key} (<sync>)`)
        
        const result = ipcRenderer.sendSync(key,...args);        

        if (isTrue(props.debug) || isTrue(process.env.IPC_DEBUG) ) 
            console.log(`ipcCall response: ${key} (<sync>)`, result!==undefined)
            return result
      }
}

function ipcHandle(key,fn, ipcMain) {
    ipcMain.on(key, async (event,callId,...args)=> {
        try {
            const res = await fn(...args)
            ipcResponse(event.sender,key,callId,res,null)
        }
        catch (err) {
            console.log( `ERROR in IPC Handler ${key}(${callId})`,err)
            ipcResponse(event.sender,key,callId,null,err)
        }
        
    } )  
}



function ipcHandleSync(key,fn, ipcMain) {
    
    ipcMain.on(key, (event,...args)=> {
        try {
            const res = fn(...args)
            event.returnValue = res;
        }
        catch (err) {
            console.log( `ERROR in IPC Handler ${key}`,err)
            event.returnValue = null;
        }
        
    } )  
}

function ipcHandleNoResponse(key,fn, ipcMain) {
    ipcMain.on(key, (event,...args)=> {
        try {
            fn(...args)
        }
        catch (err) {
            console.log( `ERROR in IPC Handler ${key}`,err)
        }        
    } )  
}



function ipcRegisterBroadcast( api, ipcEvent,ipcRenderer) {
     
    api.onMessage = (callback) => {
        if (!callback)
            return;

        const onEvent = (_ipcEventInfo, ...args) => {
            if (isTrue(process.env.IPC_DEBUG) ) 
                console.log(`ipcEvent: ${ipcEvent}`)
    
            if (callback)
                callback(...args)        
            
        }  
    
        ipcRenderer.on( ipcEvent, onEvent)
    }   

    api.stopListening = (ipcEvent) => { 
        ipcRenderer.removeAllListeners( ipcEvent)
    }
}


function ipcSendEvent( event, ...args) {
    if (process.env.IPC_DEBUG)
        console.log(`ipcBroadcast: ${event} `)
    const incyclist = app.incyclistApp;

    if (!incyclist) {
        if (process.env.IPC_DEBUG)
            console.log(`ipcBroadcast could not be sent - app unknown`)
        return;
    }

    let ipc;
    try {
        ipc = incyclist.getMainWindow()?.win?.webContents
    }
    catch(err) {
        console.log(err)
    }

    if (ipc) {
        ipc.send(event,...args);
    }
    else {
        if (process.env.IPC_DEBUG)
            console.log(`ipcBroadcast could not be sent - mainWindow unknown`)

    }
}



function getCpuInfo() {

    const cpus = os.cpus();
    
    let user = 0;
    let nice = 0;
    let sys = 0;
    let idle = 0;
    let irq = 0;
    let perc = undefined;
     

    cpus.forEach( (cpu) => {
        user += cpu.times.user;
        nice += cpu.times.nice;
        sys  += cpu.times.sys;
        irq  += cpu.times.irq;
        idle += cpu.times.idle;
    });
    
    let idleDiff 
    let totalDiff
    let userPerc
    let nicePerc
    let sysPerc
    let irqPerc
    let idlePerc

    const total = user + nice + sys + idle + irq;
    let stats;

    if ( this.cpuStats  ) {
        const tsDiff = (Date.now() - this.cpuStats.ts);
        if ( tsDiff >= 1000 ) {
            idleDiff = idle - this.cpuStats.idle;
            totalDiff = total - this.cpuStats.total;
            idlePerc = (idleDiff / totalDiff) * 100;
            userPerc = (user - this.cpuStats.user) / totalDiff * 100;
            nicePerc = (nice - this.cpuStats.nice) / totalDiff * 100;
            sysPerc  = (sys - this.cpuStats.sys) / totalDiff * 100;
            irqPerc = (irq - this.cpuStats.irq) / totalDiff * 100;
            perc = 100-idlePerc;

            this.cpuStats = { idle,total,ts:Date.now(), perc, user, nice, sys, irq }                
            stats = { cpu:perc, user:userPerc, nice:nicePerc, sys:sysPerc,  irq:irqPerc, idle:idlePerc}

        }            
        else {
            stats = this.cpuStats.prev;

        }
    }
    else {
        this.cpuStats = {idle,total, user, nice, sys, irq,ts:Date.now()};        
    }

    this.cpuStats.prev = stats;
    return stats;
}




module.exports = {
    getFileInfo, serveFile, ipcCall,ipcCallSync, ipcCallNoResponse, ipcHandle, ipcHandleSync, ipcHandleNoResponse, ipcRegisterBroadcast, ipcServe,ipcServeSync,ipcSendEvent, ipcResponse,isTrue,getCpuInfo,
    isTrue   
    
};
