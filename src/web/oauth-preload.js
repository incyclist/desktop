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

// Electron's sandboxed preload environment (the default whenever
// nodeIntegration:false/contextIsolation:true and sandbox isn't explicitly
// disabled - see oauth.js's webPreferences) only allows requiring a small
// allowlist of built-in modules ('electron', 'events', 'timers', 'url').
// require()-ing a sibling local file like './oauth-preload-utils' fails
// there ("module not found"), even though the very same require works fine
// from oauth.js in the unsandboxed main process. So the trusted-origin check
// is duplicated here, inline, rather than shared via a require - it's kept
// in sync with oauth-preload-utils.js (the source of truth, unit tested in
// oauth-preload-utils.test.js) since both are tiny and rarely change.
const TRUSTED_ORIGIN_ARG_PREFIX = '--incyclist-oauth-origin=';

function parseTrustedOrigin(argv = []) {
    if (!Array.isArray(argv))
        return undefined;

    const arg = argv.find(a => typeof a === 'string' && a.startsWith(TRUSTED_ORIGIN_ARG_PREFIX));
    return arg ? arg.substring(TRUSTED_ORIGIN_ARG_PREFIX.length) : undefined;
}

function isTrustedOrigin(currentOrigin, trustedOrigin) {
    return Boolean(currentOrigin) && Boolean(trustedOrigin) && currentOrigin === trustedOrigin;
}

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
