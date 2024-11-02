const path = require('path');
const {exec} = require('node:child_process');
__dirname = path.join(__dirname,'..')

const package = require( path.join(__dirname,'./package.json'));

const run = async (cmd) =>{
    return new Promise ((done)=>{
        exec(cmd,(error,stdout,stderr) => {
            if (error) {
                console.log('ERROR:\n', error)
                process.exit(1)
            }
            console.log(stdout) 
            console.log(stderr) 
            done()
        })
    })
}

const main = async() =>{

    const version = package.version
    const signTool = 'node_modules\\electron-installer-windows\\vendor\\squirrel\\signtool.exe'
    const exeFile = `.\\installer\\win64\\incyclist-${version}-setup.exe`
    const certFile = path.join(__dirname,'certs/installer.pfx')

    console.log('signing ...')
    await run(`${signTool} sign /f ${certFile} ${exeFile}`)

    console.log('setting timestamp ...')
    await run(`${signTool} timestamp /t http://timestamp.comodoca.com ${exeFile}`)

}

main()