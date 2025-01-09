const updateWebBundle = require('../scripts/update-web-bundle')

module.exports = {
  hooks: {
    prePackage: async (options) => { 
      await updateWebBundle()        
    }
  },

  packagerConfig: {
    asar: true,
    appBundleId: 'com.incyclist.desktop',
    name: 'Incyclist',
    osxSign: {
      platform: 'darwin',      
      provisioningProfile: 'profiles/Distribution.provisionprofile',
      identity: `Developer ID Application: ${process.env.APPLE_DEVELOPER} (${process.env.APPLE_TEAM_ID})`,
      optionsForFile: (filePath) => {
        let entitlements;
        
        if (filePath.includes('Incyclist.app/Contents/MacOS/Incyclist'))
          entitlements =  'entitlements/incyclist.darwin.plist' 
        return {
          hardenedRuntime: true,
          entitlements
        }
      }      
    },
    osxNotarize: {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    },
    icon: 'res/icons/incyclist',
    ignore: [ '^/.github','^/.gitignore', '^/app-tests','^coverage','^/certs', '^/entitlements','^/profiles','^/bin','^/installer','^/release','scripts','^/config','^/test','^/test-results','^/testdata','README.MD','electron-builder.yml','^/.env']
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',     
      config: {
        macUpdateManifestBaseUrl: `https://updates.incyclist.com/download/app/latest/mac`
      },      
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
        icon: 'res/icons/incyclist.icns'
      },
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-pkg',
      config: {
        appId: 'com.incyclist.desktop',
        install: '/Applications',
        icon: 'res/icons/incyclist.icns'
      },
      platforms: ['darwin'],
    }
  ]
};
