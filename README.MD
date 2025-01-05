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

#### Unsigned Build
` > npm run make`

#### Signed Build for AppStore distribution

Before running the build, you need to setup the information so that the script can properly sign:

__TODO__: add description of process

` > npm run make-mac-appstore`

#### Signed Build for distribution outside AppStore

Before running the build, you need to setup the information so that the script can properly sign:

__TODO__: add description of process

` > npm run make-mac-dist`


### Linux

#### Snap Build
` > npm run make`

#### AppImage Build
` > npm run make-linux`

In both cases, the result of the build can be found in [./out/make](./out/make)

