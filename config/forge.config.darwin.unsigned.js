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
    icon: 'res/icons/incyclist',
    ignore: [ '^/.github','^/.gitignore', '^/app-tests','^coverage','^/certs', '^/entitlements','^/profiles','^/bin','^/installer','^/release','scripts','^/config','^/test','^/test-results','^/testdata','README.MD','electron-builder.yml','^/.env']
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO'
      },
      platforms: ['darwin'],
    }
  ]
};
