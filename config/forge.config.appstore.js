const updateWebBundle = require('./scripts/update-web-bundle')

module.exports = {
  packagerConfig: {
    hooks: {
      beforePack: async (options) => { 
        await updateWebBundle()        
      }
    },
    asar: true,
    appBundleId: 'com.incyclist.desktop',
    name: 'Incyclist',
    osxSign: {
      platform: 'mas',   
      type:'distribution',   
      provisioningProfile: 'profiles/AppStore.provisionprofile',
      optionsForFile: (filePath) => {
        let entitlements;
        
        if (filePath.includes('Incyclist.app/Contents/MacOS/Incyclist'))
          entitlements =  'entitlements/incyclist.mas.plist' 
        else {
          entitlements = 'entitlements/default.mas.plist';

          // If it is not the top level app bundle, we sign with inherit
          if (filePath.includes('.app/')) {
            entitlements = 'entitlements/default.mas.child.plist';
          }        
        }
        return {
          hardenedRuntime: false,
          entitlements
        }
      }      
    },
    icon: 'res/icons/incyclist',
    ignore: [ '^/.github','^/.gitignore', '^/app-tests','^coverage','^/certs', '^/entitlements','^/profiles','^/bin','^/installer','^/release','scripts','^/config','^/test','^/test-results','^/testdata','README.MD','electron-builder.yml','^/.env']
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-pkg',
      config: {
        name: 'Incyclist',
        icon: './res/icons/incyclist.icns',
        appId: 'com.incyclist.desktop',
        install: '/Applications'
      },
      platforms: ['darwin'],
    }
  ],
};
