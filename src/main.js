/* istanbul ignore file */
const Incyclist = require('./app.js')

function isSquirrelBusy() {
    return require('electron-squirrel-startup')
}

if(isSquirrelBusy())
    process.exit();
else {
    Incyclist.configureCommandLine(); // must run synchronously, before any await, to apply before Chromium's native init

    Incyclist.init().then( ()=>{
        const app = new Incyclist()   

        app.checkSingleInstance(); // will terminate if app is already running
        app.start();    
    
    })
}


