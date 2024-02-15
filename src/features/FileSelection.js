const {ipcMain,dialog} = require('electron')

const path = require('path');
const { ipcCall,ipcResponse } = require('./utils');
const ipc = ipcMain;

class FileSelectionSupport {
  constructor(props = {}) {
    this.logger = props.logger || console;
    if ( this.logger.logEvent===undefined) {
        this.logger.logEvent = (event) => {
            const message = event.message;
            delete event.message;
            this.logger.log( message, event)
        }
    }
  } 

  initSelectFile( ) {

    ipc.on('open-file-dialog',  (event,callId,props) => {
      const opts = props || {}
      this.logger.logEvent( {message: 'open-file-dialog request', event, props:JSON.stringify(props)})
      
      const {filters, defaultPath, buttonLabel, title} = opts;
      const properties = [];
      const args = {properties,filters, defaultPath, buttonLabel, title}

      if ( opts.directory || opts.both) properties.push('openDirectory')
      if ( !opts.directory || opts.both ) properties.push('openFile')
      if ( opts.multiple) properties.push('multiSelections')
      

      dialog.showOpenDialog(args)
      .then( (files) => {
        this.logger.logEvent( {message: 'open-file-dialog response', files})
        if ( files && !files.canceled) {
          const info = files.filePaths.map( (p) => ({
            name: path.basename(p),
            path: p,
            info: path.parse(p)

          }))
          ipcResponse(event.sender,'open-file-dialog',callId,info)
          //event.sender.send('open-file-dialog:response',  info)
          
        }
        else {
          ipcResponse(event.sender,'open-file-dialog',callId,[])
          //event.sender.send('open-file-dialog:response', [])
        }
      })
    })

    

  }

  

  initSelectDir() {
    ipcMain.on('open-dir-dialog', function (event,callId) {

      dialog.showOpenDialog({
        properties: ['openFile', 'openDirectory']
      }, function (files) {

        if (files) ipcResponse(event.sender,'open-dir-dialog',callId, files)
      })
    })

  }

  static register(props) {
    const support = new FileSelectionSupport(props);

    support.initSelectFile();
      
  }



  static registerRenderer( spec, ipcRenderer) {

    spec.openFileDialog = ipcCall('open-file-dialog',ipcRenderer,{debug:process.env.DEBUG}) 

    spec.parsePath = (p)  => {
      const info = path.parse(p);
      info.delimiter = path.sep;
      return info
    }

    spec.registerFeatures( [
      'FileSelection.openFileDialog', 'FileSelection.parsePath'
  ] )
  }
}

module.exports = FileSelectionSupport