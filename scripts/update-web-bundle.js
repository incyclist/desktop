const fs = require('fs')
const path = require('path')
const baseDir = path.join(__dirname,'..')
const axios = require('axios')
const package_json = require('../package.json')
const os = require('os');
const { ZipData } = require('../src/modules/zip')
const readline = require('node:readline');

const { version,name} = package_json

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

async function copyFromServer(url,targetDir) {

    axios.defaults.headers.common = { "X-uuid":"update-react","X-arch":os.arch(), "X-platform":os.platform(), "user-agent": `update-react/${version} (${os.platform()};${os.arch()};${os.release()})`};

    console.log('checking version ...')
    let response = await axios.get(`${url}/api/v1/apps/${name}/${version}?uuid=update-react`) ?? {}
    let {reactVersion} = response.data||{};

    if (!reactVersion?.length) {
        reactVersion = await getReactVersionFromUser();
    }
    if (!reactVersion)
        throw new Error('could not identify react version')


    console.log(`downloading version ${reactVersion} ...`)
    response = await axios.get(`${url}/download/react/${name}-${reactVersion}.zip`,{responseType: 'arraybuffer'}) || {data:{}}
    const {data} = response

    console.log('unzipping ...')
    let zip = new ZipData(data);
    let status = await zip.extract(targetDir);
    console.log('unzipping done')

    if ( !status || !status.success) 
        throw new Error('could net extract ZIP file')
}

function updateWebBundle(targetDir) {
    let buildPath;
    let buildUrl;

    const configFile = path.join(baseDir,'./config/settings.json')

    if (fs.existsSync(configFile)) {
        const { react={} } = require('../config/settings.json')
        buildPath = react.buildPath
        buildUrl  = react.buildUrl
    }

    return new Promise (done => {
        if (buildPath) {
            const reactBuildDir = path.join(baseDir,buildPath)
           
            console.log('copy files from ',reactBuildDir)
            fs.cpSync(reactBuildDir,targetDir, {recursive: true})
            done(0)
        
        }
        else if (buildUrl) {
            copyFromServer(buildUrl,targetDir)
            .then(()=>done(0))
            .catch( (err)=> {
                console.log( 'could not load from server, error:',err.message)
                done(1)
            })
        }
        else {
            console.log( 'please specify react build path in ./config/settingss.json, react.buildPath')
            done(1)
        } 
    
    })
    
    
    
}

module.exports = updateWebBundle

