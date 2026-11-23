const { EventLogger } = require('gd-eventlog');

const LOG_BLACKLIST = ['user', 'auth', 'cacheDir', 'baseDir', 'pageDir', 'appDir'];
EventLogger.setKeyBlackList(LOG_BLACKLIST);
// Per-request and per-connection lines of the local-link transport stay in the local log file:
// they are high-volume and describe individual LAN peers.
const LOCAL_ONLY_CONTEXTS = ['LocalLinkRequests'];

// A filter runs inside the logger: it must never throw and cannot log through it (recursion), so a failure drops the event.
function restLogFilter(context, event) {
    try {
        if (LOCAL_ONLY_CONTEXTS.includes(context))
            return false;

        let fl = fileLogFilter(context, event);
        return fl;
    }
    catch (err) {
        console.error('ERROR in restLogFilter: ' + err?.message);
        return false;
    }
}
exports.restLogFilter = restLogFilter;
function fileLogFilter(context, event) {
    try {
        if (event === undefined || context === undefined)
            return false;

        if (context === 'Requests' || context === 'RestLogAdapter')
            return false;

        return true;
    }
    catch (err) {
        console.error('ERROR in fileLogFilter: ' + err?.message);
        return false;
    }
}
exports.fileLogFilter = fileLogFilter;
