const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
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
    ignore: [ '^/.github','^/.gitignore', '^/app-tests','^/certs', '^/entitlements','^/profiles','^/bin','^/installer','^/release','scripts','^/config','^/test','^/testdata','README.MD','electron-builder.yml','^/.env']
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
