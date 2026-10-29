const UpdatehandlerBase = require('./base');
const EventEmitter = require('node:events')

const { autoUpdater } = require('electron');
const { updateElectronApp, UpdateSourceType } =  require('update-electron-app');

// Tells the update server which macOS version this client runs on, so that it can serve a feed
// matching what that OS is able to run. update-electron-app derives the feed URL itself
// (<baseUrl>/RELEASES.json) and has no option for extra query parameters, so the parameter is added
// where the URL is handed over to electron's autoUpdater.
// The patch is applied once per process; the logger is the one of the latest check.
let feedPatched = false
let feedLogger

function getMacOSVersion() {
    try {
        const version = process.getSystemVersion()
        return /^\d+(\.\d+)*$/.test(version) ? version : undefined
    }
    catch {
        return undefined
    }
}

function withMacOSVersion(url, version) {
    if (typeof url !== 'string' || /[?&]macos=/.test(url))
        return url
    return `${url}${url.includes('?') ? '&' : '?'}macos=${encodeURIComponent(version)}`
}

function patchSetFeedURL() {
    if (feedPatched)
        return

    // Without a version the parameter is left out, which the server treats like a client that
    // predates it (plain feed)
    const version = getMacOSVersion()
    if (!version)
        return

    const original = autoUpdater.setFeedURL
    const setFeedURL = original.bind(autoUpdater)
    autoUpdater.setFeedURL = (options) => {
        const patched = (typeof options === 'string')
            ? withMacOSVersion(options, version)
            : { ...options, url: withMacOSVersion(options?.url, version) }

        feedLogger?.logEvent?.({ message: 'AutoUpdate feed url', url: typeof patched === 'string' ? patched : patched.url })
        return setFeedURL(patched)
    }

    // an assignment that is silently ignored (e.g. read-only property) must not count as patched
    feedPatched = autoUpdater.setFeedURL !== original
}

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
            feedLogger = this.logger

            // Only a nice-to-have: if it cannot be applied, the check still runs with the plain feed url
            try {
                patchSetFeedURL()
            }
            catch (err) {
                this.logger?.logEvent?.({ message: 'AutoUpdate feed url patch failed', error: err.message })
            }

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
