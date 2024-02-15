const { ipcRenderer } = require('electron')
const {initFeaturesWeb} = require('../features')

const electron =  {
    version: process.versions.electron,
    _features: [],
}
initFeaturesWeb( electron, ipcRenderer)

module.exports = { electron}