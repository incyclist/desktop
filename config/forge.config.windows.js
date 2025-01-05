const { default: rebuild } = require('@electron/rebuild');
const updateWebBundle = require('../scripts/update-web-bundle')
const fs = require('fs/promises')
const path = require('path')

module.exports = {
  hooks: {
    prePackage: async (options) => { 
      console.log( updateWebBundle)
      await updateWebBundle()        
    },
    packageAfterExtract: async (config,target) => {
      await fs.cp('./bin/win32',target,{recursive:true})
      await fs.cp('./bin/win32-x64',target,{recursive:true})
    }
  },
  packagerConfig: {
    asar: true,
    rebuild:false,
    appBundleId: 'com.incyclist.desktop',
    name: 'Incyclist',
    icon: 'res/icons/incyclist',
    ignore: [ 
      '^/node_modules/.*/noble/build',
      '^/.github','^/.gitignore', '^/app-tests','^coverage','^/certs', '^/entitlements','^/profiles','^/bin','^/installer','^/release','scripts','^/config','^/test','^/test-results','^/testdata',
      'README.MD','playwright.config.ts','forge.config.js','^/.env']
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        remoteReleases:'https://updates.incyclist.com/download/app/latest/win64',
        
        authors: ["Guido Doumen", "Jeroen Doumen"],
        windowsSign:{
          certificateFile: './certs/installer.pfx',
          certificatePassword: process.env.CERTIFICATE_PASSWORD,
        },
        setupIcon:'res/icons/incyclist.ico'
      }
    }
  ]
};
