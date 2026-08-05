const {
    TRUSTED_ORIGIN_ARG_PREFIX,
    buildTrustedOriginArg,
    parseTrustedOrigin,
    getOrigin,
    isTrustedOrigin,
} = require('./oauth-preload-utils');

describe('oauth-preload-utils', () => {

    describe('buildTrustedOriginArg / parseTrustedOrigin', () => {

        it('round-trips an origin through the additionalArguments encoding', () => {
            const arg = buildTrustedOriginArg('https://auth.incyclist.com');
            expect(arg).toBe(`${TRUSTED_ORIGIN_ARG_PREFIX}https://auth.incyclist.com`);
            expect(parseTrustedOrigin([arg])).toBe('https://auth.incyclist.com');
        });

        it('finds the flag among other unrelated argv entries', () => {
            const argv = ['electron', '--foo=bar', buildTrustedOriginArg('https://auth.incyclist.com'), '--baz'];
            expect(parseTrustedOrigin(argv)).toBe('https://auth.incyclist.com');
        });

        it('returns undefined when the flag is not present', () => {
            expect(parseTrustedOrigin(['electron', '--foo=bar'])).toBeUndefined();
        });

        it('returns undefined for a missing or non-array argv', () => {
            expect(parseTrustedOrigin(undefined)).toBeUndefined();
            expect(parseTrustedOrigin(null)).toBeUndefined();
            expect(parseTrustedOrigin('not-an-array')).toBeUndefined();
        });

        it('returns undefined for an empty argv array', () => {
            expect(parseTrustedOrigin([])).toBeUndefined();
        });
    });

    describe('getOrigin', () => {

        it('extracts scheme+host from a full oauth page URL', () => {
            expect(getOrigin('https://auth.incyclist.com/strava?sid=123')).toBe('https://auth.incyclist.com');
        });

        it('ignores path, query and trailing slash differences', () => {
            expect(getOrigin('https://auth.incyclist.com/')).toBe('https://auth.incyclist.com');
            expect(getOrigin('https://auth.incyclist.com')).toBe('https://auth.incyclist.com');
        });

        it('respects a non-default port', () => {
            expect(getOrigin('https://localhost:8443/strava')).toBe('https://localhost:8443');
        });

        it('returns undefined for an unparsable URL', () => {
            expect(getOrigin('not a url')).toBeUndefined();
            expect(getOrigin(undefined)).toBeUndefined();
            expect(getOrigin('')).toBeUndefined();
        });
    });

    describe('isTrustedOrigin', () => {

        it('is true when current and trusted origin match exactly', () => {
            expect(isTrustedOrigin('https://auth.incyclist.com', 'https://auth.incyclist.com')).toBe(true);
        });

        it('is false when the page has navigated to a third-party origin (e.g. Strava)', () => {
            expect(isTrustedOrigin('https://www.strava.com', 'https://auth.incyclist.com')).toBe(false);
        });

        it('is false for scheme/host mismatches that a naive substring check could miss', () => {
            expect(isTrustedOrigin('https://auth.incyclist.com.evil.com', 'https://auth.incyclist.com')).toBe(false);
            expect(isTrustedOrigin('http://auth.incyclist.com', 'https://auth.incyclist.com')).toBe(false);
        });

        it('is false when either origin is missing', () => {
            expect(isTrustedOrigin(undefined, 'https://auth.incyclist.com')).toBe(false);
            expect(isTrustedOrigin('https://auth.incyclist.com', undefined)).toBe(false);
            expect(isTrustedOrigin(undefined, undefined)).toBe(false);
            expect(isTrustedOrigin('', '')).toBe(false);
        });
    });
});
