const fs = require('fs')
const path = require('path')
__dirname = path.join(__dirname,'..')
const axios = require('axios')
const { version,name} = require('../package.json')
const os = require('os');
const { ZipData } = require('../src/modules/zip')
const { checkDir } = require('../src/utils')

return;

function cleanupDirectory(dir) {
    try {
        fs.rmSync(dir,{recursive:true});        
    } catch {}
    checkDir(dir)    
}

async function copyFromServer(url) {

    axios.defaults.headers.common = { "X-uuid":"update-react","X-arch":os.arch(), "X-platform":os.platform(), "user-agent": `update-react/${version} (${os.platform()};${os.arch()};${os.release()})`};
    const appBuildDir = path.join(__dirname,'./build')

    console.log('checking version ...')
    let response = await axios.get(`${url}/api/v1/apps/${name}/${version}?uuid=update-react`) || {}
    const {reactVersion} = response.data||{};
    if (!reactVersion)
        throw new Error('could not identify react version')


    console.log(`downloading version ${reactVersion} ...`)
    response = await axios.get(`${url}/download/react/${name}-${reactVersion}.zip`,{responseType: 'arraybuffer'}) || {data:{}}
    const {data} = response

    //cleanupDirectory(appBuildDir)

    console.log('unzipping ...')
    let zip = new ZipData(data);
    let status = await zip.extract(appBuildDir);
    console.log('done')

    //cleanupDirectory(appBuildDir)


    if ( !status || !status.success) 
        throw new Error('could net extract ZIP file')
}



let buildPath;
let buildUrl;
const configFile = path.join(__dirname,'./config/settings.json')
if (fs.existsSync(configFile)) {
    const { react={} } = require('../config/settings.json')
    buildPath = react.buildPath
    buildUrl  = react.buildUrl
}

const WINDOWS_BINDING = path.join(__dirname,'./build/Release')
const BIN_DIR = path.join(__dirname,'./bindings.binary')

if (fs.existsSync(WINDOWS_BINDING)) {
    fs.cpSync(WINDOWS_BINDING,BIN_DIR,{recursive:true})
}

if (buildPath) {
    const reactBuildDir = path.join(__dirname,buildPath)
    const appBuildDir = path.join(__dirname,'./build')
    cleanupDirectory(appBuildDir)
    
    console.log('copy files from ',reactBuildDir)
    fs.cpSync(reactBuildDir,appBuildDir, {recursive: true})

}
else if (buildUrl) {
    copyFromServer(buildUrl)
    .then(()=>process.exit(0))
    .catch( (err)=> {
        console.log( 'could not load from server, error:',err.message)
        process.exit(1)
    })
}
else {
    console.log( 'please specify react build path in ./config/settingss.json, react.buildPath')
    process.exit(1)
}

