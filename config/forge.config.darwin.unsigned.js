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
    // TEMPORARY: lets the native updater talk to an http update server on the local network - remove again
    extendInfo: { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } },
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
