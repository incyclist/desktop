const { EventLogger } = require('gd-eventlog');

const LOG_BLACKLIST = ['user', 'auth', 'cacheDir', 'baseDir', 'pageDir', 'appDir'];
EventLogger.setKeyBlackList(LOG_BLACKLIST);
function restLogFilter(context, event) {

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
