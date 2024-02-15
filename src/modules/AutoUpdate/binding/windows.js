const { EventEmitter } = require('events');
const { getPlatform } = require('../../../utils');
const UpdatehandlerBase = require('./base');
const autoUpdater =  require('electron').autoUpdater;

class Updatehandler extends UpdatehandlerBase {

    constructor(server, logger) {
        super(server,logger);

        this.autoUpdater = autoUpdater
        if (this.feedURL)
            this.autoUpdater.setFeedURL(this.feedURL)
    }

    
}

module.exports = Updatehandler
