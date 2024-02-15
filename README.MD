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

### Problems

In case you get error like this: 
    bindings.node'
    was compiled against a different Node.js version using
    NODE_MODULE_VERSION 64. This version of Node.js requires
    NODE_MODULE_VERSION 73. Please try re-compiling or re-installing
    ...

Steps:

    If you have not installed electron-rebuild just install it with the command: npm i -D electron-rebuild
    Remove from the node-modules folder the serialport and @serialport folders.
    Remove the file packages-lock.json
    Run npm i to install non-installed modules
    And finally run ./node_modules/.bin/electron-rebuild

It is very important to run ./node_modules/.bin/electron-rebuild directly after npm i.

Source: https://stackoverflow.com/a/52796884

## Building the Installers


### Windows

#### Configure the build

You need to configure the build ( filename, signing settings, auto-update URL) in the file [./config/win64-installer.json](./config/win64-installer.json) (64 Bit) or [./config/win32-installer.json](./config/win32-installer.json)

#### Create the packager
` > npm run package-win64` (64Bit Windows)<br>
or<br> 
` > npm run package-win32` (32Bit Windows)


#### Create the (signed) installer
` > npm run installer-win64` (64Bit Windows)<br>
or<br> 
` > npm run installer-win32` (32Bit Windows)

#### Sign the app



`node_modules\electron-installer-windows\vendor\squirrel\signtool.exe timestamp /tr http://timestamp.comodoca.com .\installer\win64\incyclist-`{version}`-setup.exe `


### Mac

#### Create the packager
` > npm run package-mac`

#### Create the (signed) installer
` > npm run installer-mac`



### Linux

#### Create the installer (includes packaging)
` > npm run installer-linux64`

