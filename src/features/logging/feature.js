const {shell,ipcMain,app} = require('electron')
const {defineLogEventMethod, checkDir} = require ('../../utils');
const {ipcCall,   ipcHandle, ipcCallNoResponse, ipcHandleNoResponse,ipcRegisterBroadcast} = require ('../utils')
const path = require('path')
const {promises} = require('fs')
const fs = promises

const Feature = require('../base');

 
class LoggingSupport extends Feature {

  static _instance;

  static getInstance(props = {}) {
    if (!LoggingSupport._instance)
      LoggingSupport._instance = new LoggingSupport(props)
    return LoggingSupport._instance
  }

  constructor(props = {}) {
    super();
    
  } 

  checkAdapters() {
    if (!this.consoleAdapter && app && app.incyclistApp && app.incyclistApp.consoleAdapter)
      this.consoleAdapter =  app.incyclistApp.consoleAdapter

    if (!this.fileAdapter && app && app.incyclistApp && app.incyclistApp.fileAdapter)
      this.fileAdapter =  app.incyclistApp.fileAdapter

    if (!this.restAdapter && app && app.incyclistApp && app.incyclistApp.restAdapter)
      this.restAdapter =  app.incyclistApp.restAdapter

    //console.log('~~~ Adapters: console:',this.consoleAdapter!==undefined, 'file:', this.fileAdapter!==undefined, app!==undefined, app.incyclistApp!==undefined )
  }

  log(context, event) {
    
    const adapters = [this.consoleAdapter, this.fileAdapter, this.restAdapter]

    adapters.forEach (a => {
      if (a) a.log(context, event)
    })
    

  }

  sendBulkLog( logs) {
    
    if (logs && Array.isArray(logs)) {
      this.checkAdapters();
      logs.forEach( log => {
       
        const {context,event} = log

        this.log(context,event)

          
      })  
    }

  }


  register(props) {

    ipcHandleNoResponse('logging-bulk', this.sendBulkLog.bind(this),ipcMain)

  }

  registerRenderer( spec, ipcRenderer) {

    spec.logging={}
    spec.logging.bulkLog       = ipcCallNoResponse('logging-bulk',ipcRenderer)

    spec.registerFeatures( [
        'logging'
    ] )
  }

}

module.exports = LoggingSupport