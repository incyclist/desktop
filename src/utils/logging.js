const { EventLogger } = require('gd-eventlog');

const LOG_BLACKLIST = ['user', 'auth', 'cacheDir', 'baseDir', 'pageDir', 'appDir'];
EventLogger.setKeyBlackList(LOG_BLACKLIST);
// Per-request and per-connection lines of the local-link transport stay in the local log file:
// they are high-volume and describe individual LAN peers.
const LOCAL_ONLY_CONTEXTS = ['LocalLinkRequests'];

function restLogFilter(context, event) {

    if (LOCAL_ONLY_CONTEXTS.includes(context))
        return false;

    let fl = fileLogFilter(context, event);
    return fl;
}
exports.restLogFilter = restLogFilter;
function fileLogFilter(context, event) {

    if (event === undefined || context === undefined)
        return false;

    if (context === 'Requests' || context === 'RestLogAdapter')
        return false;

    return true;
}
exports.fileLogFilter = fileLogFilter;
