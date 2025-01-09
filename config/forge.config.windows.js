const updateWebBundle = require('../scripts/update-web-bundle')
const fs = require('fs/promises')

module.exports = {
  hooks: {
    prePackage: async (options) => { 
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
        authors: ["Guido Doumen", "Jeroen Doumen"],
        setupIcon:'res/icons/incyclist.ico'
      }
    }
  ]
};
