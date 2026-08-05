// Plain helper functions used to pass the trusted OAuth-server origin from
// the main process (OAuthWindow, which knows the configured oauth URL) into
// the isolated preload script (oauth-preload.js), and to check the current
// page's origin against it before exposing anything to that page.
//
// Kept dependency-free (no `electron`, no `window`) so it can be unit tested
// in isolation - see oauth-preload-utils.test.js.

const TRUSTED_ORIGIN_ARG_PREFIX = '--incyclist-oauth-origin=';

/**
 * Builds the `additionalArguments` entry used to hand the trusted origin to
 * the preload script's `process.argv`.
 */
function buildTrustedOriginArg(origin) {
    return `${TRUSTED_ORIGIN_ARG_PREFIX}${origin}`;
}

/**
 * Extracts the trusted origin previously injected via
 * BrowserWindow webPreferences.additionalArguments from a process.argv-like
 * array. Returns undefined if not present.
 */
function parseTrustedOrigin(argv = []) {
    if (!Array.isArray(argv))
        return undefined;

    const arg = argv.find(a => typeof a === 'string' && a.startsWith(TRUSTED_ORIGIN_ARG_PREFIX));
    return arg ? arg.substring(TRUSTED_ORIGIN_ARG_PREFIX.length) : undefined;
}

/**
 * Derives the origin (scheme+host+port) of a URL string. Returns undefined
 * if the URL cannot be parsed.
 */
function getOrigin(url) {
    try {
        return new URL(url).origin;
    }
    catch {
        return undefined;
    }
}

/**
 * True only if both origins are defined, non-empty strings and match
 * exactly. This is the gate that decides whether the preload script is
 * allowed to expose `window.api` on the current page.
 */
function isTrustedOrigin(currentOrigin, trustedOrigin) {
    return Boolean(currentOrigin) && Boolean(trustedOrigin) && currentOrigin === trustedOrigin;
}

module.exports = {
    TRUSTED_ORIGIN_ARG_PREFIX,
    buildTrustedOriginArg,
    parseTrustedOrigin,
    getOrigin,
    isTrustedOrigin,
};
