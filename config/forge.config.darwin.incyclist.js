const updateWebBundle = require('../scripts/update-web-bundle')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs/promises')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execFileAsync = promisify(execFile)
const packageJson = require('../package.json')

const APP_NAME = 'Incyclist'
const INSTALL_LOCATION = '/Applications'

// @electron-forge/maker-pkg has no way to pass a custom --component-plist to
// pkgbuild, so pkgbuild's implicit analysis leaves the component relocatable.
// macOS Installer can then "relocate" the install to wherever Launch Services
// already has com.incyclist.desktop registered (e.g. a copy previously run
// from a DMG) instead of /Applications - sometimes leaving the app installed
// nowhere findable. This builds the .pkg by hand, mirroring the same
// pkgbuild/productbuild sequence @electron/osx-sign uses internally, but with
// BundleIsRelocatable forced off.
async function buildNonRelocatablePkg(appPath, pkgPath, identity) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'incyclist-pkg-'))
  const componentPlistPath = path.join(tmpDir, 'component.plist')
  const componentPkgPath = path.join(tmpDir, `${APP_NAME}-component.pkg`)

  try {
    await execFileAsync('pkgbuild', ['--analyze', '--component', appPath, componentPlistPath])
    await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Set :0:BundleIsRelocatable false', componentPlistPath])

    await execFileAsync('pkgbuild', [
      '--install-location', INSTALL_LOCATION,
      '--component', appPath,
      '--component-plist', componentPlistPath,
      componentPkgPath,
    ])

    await execFileAsync('productbuild', [
      '--package', componentPkgPath,
      '--sign', identity,
      pkgPath,
    ])
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

module.exports = {
  hooks: {
    prePackage: async (options) => {
      await updateWebBundle()
    },
    postPackage: async (forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin') return

      const identity = `Developer ID Installer: ${process.env.APPLE_DEVELOPER} (${process.env.APPLE_TEAM_ID})`

      for (const outputPath of packageResult.outputPaths) {
        const appPath = path.join(outputPath, `${APP_NAME}.app`)
        const makeDir = path.resolve(outputPath, '..', 'make')
        await fs.mkdir(makeDir, { recursive: true })
        const pkgPath = path.join(makeDir, `${APP_NAME}-${packageJson.version}-${packageResult.arch}.pkg`)
        await buildNonRelocatablePkg(appPath, pkgPath, identity)
      }
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
        icon: 'res/icons/incyclist.icns',
        // appdmg does correctly mark .background/.VolumeIcon.icns as hidden files,
        // but Finder's "Show Hidden Files" setting (AppleShowAllFiles) overrides that
        // for anyone who has it on - a very common dev-machine setting. There's no way
        // to override a viewer's own Finder preference, so per the appdmg maintainers'
        // own recommended workaround (github.com/LinusU/node-appdmg#14), position the
        // hidden files below the visible window bounds instead.
        contents: (opts) => [
          { x: 192, y: 344, type: 'file', path: opts.appPath },
          { x: 448, y: 344, type: 'link', path: '/Applications' },
          { x: 100, y: 700, type: 'position', path: '.background' },
          { x: 300, y: 700, type: 'position', path: '.VolumeIcon.icns' },
          { x: 500, y: 700, type: 'position', path: '.DS_Store' },
        ],
        additionalDMGOptions: {
          window: {
            size: { width: 660, height: 400 }
          }
        }
      },
      platforms: ['darwin'],
    }
    // .pkg is built by hand in the postPackage hook above (see comment there) -
    // not via @electron-forge/maker-pkg, which can't produce a non-relocatable component.
  ]
};
