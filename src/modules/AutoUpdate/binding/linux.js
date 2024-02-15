const autoUpdater = require('electron-updater').autoUpdater
const EventEmitter = require("events");
const { getPlatform } = require('../../../utils');
const UpdatehandlerBase = require('./base');

class Updatehandler extends UpdatehandlerBase {

    constructor(server, logger) {
        super(server,logger);
        this.logger = logger;

        this.autoUpdater = autoUpdater
        if (this.feedURL)
            autoUpdater.setFeedURL(this.feedURL)

        autoUpdater.logger = {
            warn: (...args) => { this.logEvent( { message:'autoUpdate.warn', args})},
            error: (...args) => {this.logEvent( { message:'autoUpdate.error', args})},
            info: (...args) => {this.logEvent( { message:'autoUpdate.info', args})},
            log: (...args) => {this.logEvent( { message:'autoUpdate.log', args})},
            debug: (...args) => {this.logEvent( { message:'autoUpdate.debug', args})}
        }




    }

    logEvent(e) {
        if (this.logger)
            this.logger.logEvent(e)
    }

    async checkForUpdates() {    

        try {    
            return await autoUpdater.checkForUpdatesAndNotify()
        }
        catch(err) {
            console.log(err)
            return null;
        }

    }

    
}


module.exports = Updatehandler