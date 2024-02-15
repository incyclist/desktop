const { protocol, ipcMain } = require('electron')
const fs = require('fs')
const { defineLogEventMethod} = require ('../utils')
const {getFileInfo,serveFile} = require('./utils')

const SCHEME = 'incyclist' 

class IncyclistScheme {

    constructor(props = {}) {
        this.logger = defineLogEventMethod(props.logger || console);
        this.requestLogger = defineLogEventMethod(props.requestLogger || console);

    }

    initIpc() {

        ipcMain.on('incyclist-readbinary-request',(event,props) => {
            const opts = props || {}
            const {path,url} = opts;
            let fileName = path;
            if (url) {
                const info = getFileInfo(url,SCHEME)
                fileName = info.fileName
            } 
            fs.readFile(fileName,'binary', (err,data) => {
                event.sender.send('incyclist-readbinary-response', err,data)
            });

        })
    }


    


    static register( props) {
        const support = new IncyclistScheme(props);

        protocol.registerFileProtocol (SCHEME,(request,callback) => {
            const {outFile} = getFileInfo(request.url,SCHEME)
            support.requestLogger.logEvent({message:'serve file', scheme:SCHEME,filename:outFile, info:getFileInfo(outFile,SCHEME) });
            serveFile(outFile,request,callback)
        }) 

        support.initIpc();
           
   
    }

    static registerRenderer( spec, ipcRenderer) {

        spec.IncyclistFile = {
            readBinaryFile:  (props)=> {
                return new Promise( (resolve,reject) => {
                    ipcRenderer.send('incyclist-readbinary-request',props);                 
                    ipcRenderer.once('incyclist-readbinary-response', (event,err,data) => {                    
                    resolve(data);
                    })
                })
            }        

        }

    
      }
        
}

module.exports = IncyclistScheme