const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const os = require('os')
const platform = os.platform()

let config;

const plugins =  [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
]

if (platform==='win32' && process.env.BUILD_TARGET==='dist')
  config = require(`./config/forge.config.windows`)
else if (platform==='win32')
  config = require(`./config/forge.config.windows.unsigned`)
else if (platform==='linux') 
  config = require(`./config/forge.config.linux.snap`)
else if (platform==='darwin')  {
  config = require(`./config/forge.config.darwin.${process.env.BUILD_TARGET??'unsigned'}`)
  plugins.push( { name: '@electron-forge/plugin-auto-unpack-natives', config: {} })
}

const forge =  {
  packagerConfig: config.packagerConfig,
  rebuildConfig: {},
  makers: config.makers,
  hooks: config.hooks,
  plugins
  
};

module.exports = forge