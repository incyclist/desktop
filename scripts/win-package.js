const packager = require('electron-packager');
const fs = require('fs');
const fse = require('fs-extra');  
const { platform } = require('os');
const path = require('path');
const updateWebBundle = require('./update-web-bundle');
const { checkDir } = require('../src/utils');


const baseDir = __dirname = path.join(__dirname,'..')
let argv = process.argv.slice(2);
const options = require( path.join(__dirname,argv[0]));

async function main (options) {

    console.log('Creating package (this may take a while)...')

    try {


      let idxBuild = options.bundled.find( i=> i==='build') 

      if (idxBuild!==-1) {
        try { fs.rmSync(path.join(baseDir,'bindings.binary'),{recursive:true})} catch {}
        try { fs.renameSync( path.join(baseDir,'build'), path.join(baseDir,'bindings.binary')) } catch {}
        options.ignore.push('bindings.binary/')
      }

      const resDir = path.join(baseDir,'./build')
      console.log('Updating Web Bundle to', resDir)
      checkDir(resDir)
      await updateWebBundle( resDir )


      console.log('Bundle Electron with WebBundle', options)
      const appPaths = await packager(options)

      if (idxBuild!==-1) {
        try { fs.rmSync(path.join(baseDir,'build'),{recursive:true})} catch{}
        try { fs.renameSync( path.join(baseDir,'bindings.binary'),path.join(baseDir,'build')) } catch{}
      }

      if (appPaths.length > 1) {
          console.error(`Wrote new apps to:\n${appPaths.join('\n')}`)
      } else if (appPaths.length === 1) {
          console.error('Wrote new app to', appPaths[0])

          console.log('checking for bundled binaries ...')
          if (options.bundled && options.bundled.length>0) {
            options.bundled.forEach( bundle => {
              const binPath= path.join(__dirname,bundle)             
              if ( fs.existsSync(binPath)) {

                const platformPathIn =  path.join(binPath,options.platform)
                if ( fs.existsSync(platformPathIn)) { 
                  fse.copySync( platformPathIn, appPaths[0], { overwrite:true, preserveTimestamps :true})
                }

                const archPathIn =  path.join(binPath,`${options.platform}-${options.arch}`)
                if ( fs.existsSync(archPathIn)) { 
                  fse.copySync( archPathIn, appPaths[0], { overwrite:true, preserveTimestamps :true})
                }


              }
    
            })
          }

        }
      } catch (err) {
        if (err.message) {
          console.error(err.message)
        } else {
          console.error(err, err.stack)
        }
        
      }



}

main(options)