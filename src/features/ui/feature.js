const {shell,ipcMain,app} = require('electron')
const {defineLogEventMethod, checkDir, getAppDirectory} = require ('../../utils');
const {ipcCall,   ipcHandle, ipcCallNoResponse, ipcHandleNoResponse,ipcRegisterBroadcast} = require ('../utils')
const path = require('path')
const {promises} = require('fs')
const fs = promises

const Feature = require('../base');

 
class NativeUISupport extends Feature {

  static _instance;

  static getInstance(props = {}) {
    if (!NativeUISupport._instance)
      NativeUISupport._instance = new NativeUISupport(props)
    return NativeUISupport._instance
  }

  constructor(props = {}) {
    super()
    const {logger}  = props;
    this.logger = defineLogEventMethod(props.logger || console);
    this.shell = shell;
  } 

  setLogger(logger) {
    this.logger = logger
  }

  disableScreensaver() {
    app.incyclistApp.disableScreensaver();
    return true;
  }
  enableScreensaver() {
    app.incyclistApp.enableScreensaver();
    return true;
  }

  toggleFullScreen(){
    let res = false;

    try {
      const win = app.incyclistApp.getWindowManager().getActiveWindow()
      if (win) {
        win.setFullScreen(!win.isFullScreen());
        res = true;
      }  
    }
    catch(err) {
      this.logger.logEvent( {message:'error',fn:'on(ui-toggleFullScreen)',error:err.message||err, stack:err.stack})
      return false;
    }
    
  }

  // Open an URL in a Browser
  openExternal(url) {
    try {
        shell.openExternal(url)
    }
    catch ( err) {
        this.logger.logEvent( {message:'openUrl error',error:err.message})
    }
  }

  // Open an URL in a new window within the app
  async openWindow(url) {

      // TODO    

  }

  showItemInFolder(filename) {
    try {
        shell.showItemInFolder(filename)
    }
    catch ( err) {
        this.logger.logEvent( {message:'showItemInFolder error',error:err.message})
    }
  }
 
  async takeScreenshot(props) {
    const JPEG_QUALITY_DEFAULT = 70; 
    const {fileName = 'screenshot'} = props
        
    let win = app.incyclistApp.getWindowManager().getActiveWindow();
    let img = await win.capturePage();            
    let data = img.toJPEG(JPEG_QUALITY_DEFAULT)
    const appDir = getAppDirectory()
    
    const screenShotDir = path.join(appDir,'./screenshots')
    checkDir(screenShotDir);
    const fullPath = path.join( screenShotDir,`./${fileName}` )
    try {
        await fs.writeFile(fullPath, data)
    }
    catch(err) {
      this.logger.logEvent( {message:'error',fn:'takeScreenshot()',error:err.message||err, stack:errstack})
    }

    return fullPath


  }

  quitRequest() {
    app.incyclistApp.quit();
  }

  sendBroadcast(event) {
    app.incyclistApp.sendBroadcast(event)
  }

  register(props) {


    ipcHandle('ui-disableScreensaver',this.disableScreensaver.bind(this),ipcMain)
    ipcHandle('ui-enableScreensaver',this.enableScreensaver.bind(this),ipcMain)
    ipcHandle('ui-toggleFullScreen',this.toggleFullScreen.bind(this),ipcMain)
    ipcHandle('ui-quit',this.quitRequest.bind(this),ipcMain)
    ipcHandle('ui-take-screenshot',this.takeScreenshot.bind(this),ipcMain)
    ipcHandle('ui-open-window',this.openWindow.bind(this),ipcMain)

    ipcHandleNoResponse('ipc-sendBroadcast', this.sendBroadcast.bind(this),ipcMain)


  }

  registerRenderer( spec, ipcRenderer) {

    spec.showItemInFolder = (fileName) => this.showItemInFolder(fileName);
    spec.openPath = (path) => shell.openPath(path);
    spec.openExternal = (url) => this.openExternal(url);
    spec.beep = shell.beep;
    spec.shell = shell;


    spec.ui={}
    spec.ui.disableScreensaver   = ipcCall('ui-disableScreensaver',ipcRenderer)        
    spec.ui.enableScreensaver    = ipcCall('ui-enableScreensaver',ipcRenderer)        
    spec.ui.toggleFullScreen     = ipcCall('ui-toggleFullScreen',ipcRenderer)
    spec.ui.quit                 = ipcCall('ui-quit',ipcRenderer)
    spec.ui.takeScreenshot       = ipcCall('ui-take-screenshot',ipcRenderer)
    spec.ui.openWindow           = ipcCall('ui-open-window',ipcRenderer)

    spec.ipc={}
    spec.ipc.sendBroadcast       = ipcCallNoResponse('ipc-sendBroadcast',ipcRenderer)
    ipcRegisterBroadcast(spec.ipc,'app-event',ipcRenderer)

    spec.registerFeatures( [
        'shell.showItemInFolder', 'shell.openPath', 'shell.openExternal', 'shell.beep', 
        'ui.screensaver','ui.toggleFullSccreen', 'ui.quit', 'ui.screenshot',
        'ipc.broadcast'
    ] )
  }

}

module.exports = NativeUISupport