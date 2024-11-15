const fs = require('fs')
const path = require('path')
const baseDir = path.join(__dirname,'..')
const axios = require('axios')
const package_json = require('../package.json')
const os = require('os');
const { ZipData } = require('../src/modules/zip')
const { checkDir } = require('../src/utils')
const { version,name} = package_json
const lnk = require('lnk')
const readline = require('node:readline');


let config = process.argv[2]??'../package.json'

if (config.startsWith('./')) config='.'+config


const {build={}} = require(config)??{}

console.log( 'config:', build)
console.log('Platform:', os.platform(),build[os.platform()])
const buildResources = build?.directories?.buildResources || "./res"
const buildDir = path.join(baseDir,`release/${os.platform()}`)
const appBuildDir = path.join(buildDir,buildResources)


function cleanupDirectory(dir) {

    const unlink = (l) => { try {fs.unlinkSync(l)} catch {}}
    const rm = (l) => { try {fs.rmSync(dir,{recursive:true});} catch{} }

    // clean build directory
    if (os.platform()==='darwin') {
        rm(path.join(buildDir,'./bin'))
        rm(path.join(buildDir,'./node_modules'))
    }
    else  {
        unlink(path.join(buildDir,'./bin'))
        unlink(path.join(buildDir,'./node_modules'))
    }
    unlink(path.join(buildDir,'./src'))
    unlink(path.join(buildDir,'./scripts'))
    
    try {
        try {fs.rmSync(dir,{recursive:true});} catch{}
        checkDir(dir)    
    } catch (err) {
        console.log(err)
    }

    console.log('cleanup build dir done')

}

function getReactVersionFromUser() {
    return new Promise (resolve =>{
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question(`UI Version?`, version => {
            rl.close();
            resolve(version)
          });
    
    })
}

async function copyFromServer(url) {

    axios.defaults.headers.common = { "X-uuid":"update-react","X-arch":os.arch(), "X-platform":os.platform(), "user-agent": `update-react/${version} (${os.platform()};${os.arch()};${os.release()})`};

    console.log('checking version ...')
    let response = await axios.get(`${url}/api/v1/apps/${name}/${version}?uuid=update-react`)  ?? {}
    let {reactVersion} = response?.data??{}

    if (!reactVersion?.length) {
        reactVersion = await getReactVersionFromUser();
    }


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
const configFile = path.join(baseDir,'./config/settings.json')
if (fs.existsSync(configFile)) {
    const { react={} } = require('../config/settings.json')
    buildPath = react.buildPath
    buildUrl  = react.buildUrl
}

console.log('~~~ Build Dir:', buildDir)
cleanupDirectory(buildDir)
checkDir(buildDir)

console.log('~~~ Resources Dir:', appBuildDir)



checkDir(buildResources)

fs.cpSync(path.join(baseDir,'./res'),appBuildDir, {recursive: true})


if (os.platform()==='win32') {
    lnk.sync(path.join(baseDir,'./node_modules'),buildDir)
    lnk.sync(path.join(baseDir,'./bin'),buildDir)
    lnk.sync(path.join(baseDir,'./config'),buildDir)
    lnk.sync(path.join(baseDir,'./src'),buildDir)
    lnk.sync(path.join(baseDir,'./scripts'),buildDir)
}
else if (os.platform()==='darwin') {
    console.log('copying node modules  ...')
    try { fs.cpSync(path.join(baseDir,'./node_modules'),path.join(buildDir,'./node_modules'), {recursive: true}) } catch {}
    console.log('... done')
    try { fs.mkdirSync(path.join(buildDir,'./bin'))} catch {}
    if (fs.existsSync(path.join(baseDir,`./bin/mac-${os.arch()}`)))
        try { fs.symlinkSync(path.join(baseDir,`./bin/mac-${os.arch()}`),path.join(buildDir,`./bin/mac-${os.arch()}`)) } catch {}
    fs.symlinkSync(path.join(baseDir,'./src'),path.join(buildDir,'./src'))
    fs.symlinkSync(path.join(baseDir,'./scripts'),path.join(buildDir,'./scripts'))    

}
else {
    console.log('copying node modules  ...')
    try { fs.cpSync(path.join(baseDir,'./node_modules'),path.join(buildDir,'./node_modules'), {recursive: true}) } catch {}
    console.log('... done')
    if (fs.existsSync(path.join(baseDir,`./bin/${os.platform()}-${os.arch()}`)))
        try { fs.symlinkSync(path.join(baseDir,`./bin/${os.platform()}`),path.join(buildDir,`./bin/${os.platform()}`)) } catch {}
    try { fs.mkdirSync(path.join(buildDir,'./bin'))} catch {}
    fs.symlinkSync(path.join(baseDir,'./src'),path.join(buildDir,'./src'))
    fs.symlinkSync(path.join(baseDir,'./scripts'),path.join(buildDir,'./scripts'))    
}


if (!package_json.build) {
    package_json.build = build
}
else {
    ['win32','darwin','linux'].forEach( p=> {
        if (p!==os.platform())
            delete package_json.build[p]
    })   
    
    package_json.build.directories = package_json.build[os.platform()]?.directories
    if (package_json.build.directories){
        if (package_json.build.directories.output)
            package_json.build.directories.output = path.join(__dirname, package_json.build.directories.output  )
        delete package_json.build[os.platform()].directories
    }
}
fs.writeFileSync( path.join(buildDir,'./package.json'), JSON.stringify(package_json,null,2 ))


if (buildPath) {
    const reactBuildDir = path.join(baseDir,buildPath)
   
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


