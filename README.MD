# Incyclist App

This repository contains the main app of the [Incyclist](https://incyclist.com) indoor cycling app.

## Running the app

### Requirements

Incyclist depends on a couple of external services. Although the app will work without any of those services, some parts of the application might be impacted if those services are not correctly configured. 

Therefore, the credentials to access those services have to be configured:

Create a file secrets.json in the [./src](./src) folder. This file needs to contain the following information

#### Message Queue Broker

Incyclist uses a Message Queue to manage group rides. You either need to request credentials via our Slack workspace, or you need to setup your own MQTT Message Broker

_MQ_BROKER_ URL of the Message Queue Broker (required for group ride support) 

_MQ_USER_ , _MQ_PASSWORD_  Credentials to to be used to authenticate against the Message Queue Broker

#### JAWG API Keys

The [JAWG Elevation API](https://www.jawg.io/en/) is used to update elevation profiles, when generating routes. In order to request credentials, got to their web site

_JAWG_API_KEY_  API key for the [JAWG Elevation API](https://www.jawg.io/en/)

#### Google Maps API Keys

The Google Maps Api Keys are used to present Street View or Sattelite View during ride. In order to request credentials, visit the Google Maps web site

_GOOGLE_API_KEY_ API Key for [Google Maps API](https://developers.google.com/maps)

#### Strava API Keys

The Strava API is used to connect with the Strava service and upload activities after finishing a ride. In order to request credentials, visit the Strava developer web site

_STRAVA_CLIENT_ID_,  _STRAVA_CLIENT_SECRET_ Credentials for the [Strava API](https://developers.strava.com/)

#### Incyclist API Keys

The Incyclist API is used to fro various operations ( e.g. automatic update, getting routes and videos, getting group rides,....). In order to request credentials, contact us via the Incyclist Slack workspace

_INCYCLIST_API_KEY_ Incyclist API Key


### Starting

`> npm start`

### Using Electron Developer Tools

Once the app is started, you can press CTRL+SHIFT+ALT+I to open the Electron Developer Tools.


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

