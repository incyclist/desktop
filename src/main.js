/* istanbul ignore file */

// app.commandLine.appendSwitch('no-sandbox') (see IncyclistApp.configureCommandLine) runs too
// late to reliably suppress Chromium's native sandbox setup on Linux: that setup (the zygote
// fork + SUID-sandbox-helper validation) happens before this file's JS ever executes, so the
// switch lands only on some launches (e.g. a desktop-icon launch, which picks up --no-sandbox
// from the AppImage's own embedded .desktop Exec= line) and not others (e.g. a bare terminal
// invocation of the AppImage, with no such argv). Re-launching once with --no-sandbox as a real
// argv guarantees it's present before Chromium's native startup, regardless of launch method.
if (process.platform === 'linux' && !process.argv.includes('--no-sandbox')) {
    const { spawnSync } = require('node:child_process')
    const result = spawnSync(process.execPath, ['--no-sandbox', ...process.argv.slice(1)], { stdio: 'inherit' })
    process.exit(result.status ?? 1)
}

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


