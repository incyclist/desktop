const OAuthWindow = require('./oauth');

describe('OAuthWindow', () => {

    /**
     * Builds an OAuthWindow-like instance without invoking the real
     * constructor (which would create a real Electron BrowserWindow).
     * Only sets the fields getTrustedOrigin() actually reads.
     */
    function createInstance(pageUrl) {
        const instance = Object.create(OAuthWindow.prototype);
        instance.pageUrl = pageUrl;
        return instance;
    }

    describe('getTrustedOrigin', () => {

        it('returns the origin of the default Incyclist auth server', () => {
            const win = createInstance('https://auth.incyclist.com/strava?sid=123');
            expect(win.getTrustedOrigin()).toBe('https://auth.incyclist.com');
        });

        it('returns the origin of a configured (e.g. staging) oauth server', () => {
            const win = createInstance('https://staging-auth.incyclist.com/intervals?sid=456');
            expect(win.getTrustedOrigin()).toBe('https://staging-auth.incyclist.com');
        });

        it('never returns a third-party origin such as strava.com', () => {
            const win = createInstance('https://auth.incyclist.com/strava?sid=123');
            expect(win.getTrustedOrigin()).not.toBe('https://www.strava.com');
        });

        it('returns undefined for an unparsable pageUrl (fails closed)', () => {
            const win = createInstance('not a url');
            expect(win.getTrustedOrigin()).toBeUndefined();
        });
    });

});
