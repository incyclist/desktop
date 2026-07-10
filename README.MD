# Incyclist App

This repository contains the main app of the [Incyclist](https://incyclist.com) indoor cycling app.

## Running the app

### Normal run

```bash
npm start
```

In principle, Electron developer tools can be opened at any time with `CTRL+SHIFT+ALT+I`, though this shortcut has not been reliable on Linux in recent releases.

### Development run

```bash
npm run dev
```

Starts the app with Electron developer tools opened automatically. Use this when actively working on the app.


## Building the Installers


### Windows

#### Unsigned Build
` > npm run make`

#### Signed Build for distribution 

Before running the build, you need to setup the information so that the script can properly sign:
- store your certificate (pfx file) in ./certs/installer.pfx
- set the environment variable _CERTIFICATE_PASSWORD_ to the password of the certificate

` > npm run make-win-dist`

In both cases, the result of the build can be found in [./out/make/squirrel.windows/x64/](./out/make/squirrel.windows/x64/)

### Mac

There are three different build targets for Mac: 

- An unsigned build you can use for local development and testing/debugging
- A signed and notarized build that can be used to ditribute the app outside of the Mac App Store
- A signed build that can be uploaded to the Mac App Store

The process of signing and requirements for local and App Store distributions is explained [here](https://github.com/thebinarysearchtree/forge) and [here](https://github.com/electron/osx-sign), including how to setup the certificates in provisioning profiles that are required for these build targets

In all cases, the result of the build can be found in [./out/make](./out/make)

#### Unsigned Build
` > npm run make`

#### Signed Build for distribution outside AppStore

Before running the build, you need to setup the information so that the script can properly sign. This requires the following steps to be completed:

1) Create an application in the Apple developer portal. 

2) If not done, create an "App Specific password" as described [here](https://docs.digicert.com/en/software-trust-manager/threat-detection/apple-notarization/notarize-apple-binaries.html)

3) Create, download and install a "Developer ID Application" certificate

4) Create a provisionig profile with your "Developer ID Application" Certificate and the application you have created in Step 1.  Dwnload and install the provisioning profile

5) copy the provisioning profile to [./profiles/Distribution.provisionprofile](./profiles/Distribution.provisionprofile)

6) Define the following environment variables:
- _APPLE_ID_:  appleId: usually the email address you used to create your Apple account.

- _APPLE_PASSWORD_: the password you have created in step 2

- _APPLE_TEAM_ID_: that set of characters inside the brackets at the end of your identity name.

- _APPLE_DEVELOPER_: The name ( "<FirstName> <LastName>") of the developer registered in the certificate

Once these steps are done, you can trigger the build using:
` > npm run make-mac-dist`


#### Signed Build for AppStore distribution

This is currently work in progress. I need to implement and verify the process myself and once that is done, I will describe how you could publish your own flavour of Incyclist in the Mac AppStore

` > npm run make-mac-appstore`

### Linux

#### Snap Build
` > npm run make`

#### AppImage Build
` > npm run make-linux`

In both cases, the result of the build can be found in [./out/make](./out/make)

