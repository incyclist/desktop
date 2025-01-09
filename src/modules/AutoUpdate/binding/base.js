const { EventEmitter } = require('events');
const { getPlatform } = require('../../../utils');

class UpdatehandlerBase extends EventEmitter {

    constructor(server, logger) {
        super();
        if (server)
            this.feedURL = `${server}/download/app/latest/${getPlatform()}`
        this.logger = logger;
    }

    async checkForUpdates() {
        try {
            return await this.autoUpdater.checkForUpdates()
        }
        catch { return null}

    }

    quitAndInstall() {
        try {
            return this.autoUpdater.quitAndInstall()
        } catch {}
    }

    impl() {
        return this.autoUpdater
    }

    getFeedUrl() {
        return this.feedURL
    }
    
}

module.exports = UpdatehandlerBase
