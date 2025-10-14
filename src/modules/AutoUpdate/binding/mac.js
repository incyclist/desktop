const UpdatehandlerBase = require('./base');
const EventEmitter = require('node:events')

const { updateElectronApp, UpdateSourceType } =  require('update-electron-app');

class Updatehandler extends UpdatehandlerBase {


    constructor(server, logger) {
        super(server,logger);
        this.autoUpdater = new EventEmitter()
   }

    async checkForUpdates() {

        const log = this.logger?.logEvent  ? (...args) => {             
            this.logger.logEvent({message:'AutoUpdate Log',log:args.join(',')})
        } : console.log

        try {
            const config = {
                updateSource: {
                    type: UpdateSourceType.StaticStorage,
                    baseUrl: this.feedURL
                },
                logger: {log}

            }
            return await updateElectronApp(config)
        }
        catch { return null}
        
    }

    
}

module.exports = Updatehandler
