// Dedicated, minimal preload for OAuthWindow (src/web/pages/oauth.js).
//
// OAuthWindow navigates to real, remote, third-party pages (e.g.
// www.strava.com, intervals.icu) as part of the OAuth redirect flow - not
// just Incyclist's own auth-server pages. Unlike src/web/preload.js (used by
// the main app window, which only ever loads Incyclist/web-ui content), this
// preload must NOT expose the full feature surface (ble/ant/serial/video/...)
// and must NOT rely on nodeIntegration/contextIsolation:false, since that
// would hand real Node globals (require/process/module) to whatever JS the
// third-party site chooses to run.
//
// It exposes only `window.api.oauth.emit(sid, event)` - the single call
// microservices/auth-server's success.ejs/error.ejs make - via
// contextBridge, and only ever on Incyclist's own auth-server origin. On any
// other origin (strava.com, intervals.icu, etc.) `window.api` is never
// created, so a compromised or malicious third-party page has nothing to
// find or collide with.

const { contextBridge, ipcRenderer } = require('electron');
const { parseTrustedOrigin, isTrustedOrigin } = require('./oauth-preload-utils');

const trustedOrigin = parseTrustedOrigin(process.argv);

if (isTrustedOrigin(window.location.origin, trustedOrigin)) {
    contextBridge.exposeInMainWorld('api', {
        oauth: {
            // Same call shape as the previous window.api.oauth.emit (backed by
            // ipcCallNoResponse('oauth-emit', ipcRenderer)) so success.ejs /
            // error.ejs need no changes.
            emit: (sid, event) => ipcRenderer.send('oauth-emit', sid, event),
        },
    });
}
