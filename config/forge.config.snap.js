const updateWebBundle = require('../scripts/update-web-bundle')

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
    icon: 'res/icons/incyclist',
    ignore: [ '^/.github','^/.gitignore', '^/app-tests','^coverage','^/certs', '^/entitlements','^/profiles','^/bin','^/installer','^/release','scripts','^/config','^/test','^/test-results','^/testdata','README.MD','electron-builder.yml','^/.env']
  },
  makers: [
    {
      name: '@electron-forge/maker-snap',     
      platforms: ['linux'],
      config: {
        "category":"Game",
        "base": "core22",
        "confinement":"devmode",
        "plugs" : [
            "bluez",
            "bluetooth-control",
            "alsa",
            "audio-playback",
            "cpu-control",
            "display-control",
            "locale-control",
            "network",
            "network-bind",
            "home",
            "serial-port",
            "removable-media" 
        ]
        
      }
      
    }
  ]
};
