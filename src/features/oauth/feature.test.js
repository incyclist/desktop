/**
 * Behaviour tests for OauthFeature.authorize()
 *
 * Strategy
 * --------
 * - Use the REAL `http` module - a genuine loopback server is fast/reliable
 *   in a test environment and lets these tests exercise the exact request
 *   parsing logic the browser redirect would trigger, rather than mocking it
 *   away.
 * - Mock only the Electron boundary (`shell.openExternal`, `app.incyclistApp`)
 *   and `ipcMain`/../utils (unused here but required by the module).
 */

jest.mock('electron', () => ({
    ipcMain: { handle: jest.fn(), on: jest.fn() },
    app: { incyclistApp: { settings: { oauthUrl: 'https://auth.test.local/' } } },
    shell: { openExternal: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('../utils', () => ({ ipcCall: jest.fn(), ipcHandle: jest.fn(), ipcCallNoResponse: jest.fn(), ipcHandleNoResponse: jest.fn() }))

const http = require('node:http')
const { shell } = require('electron')
const OauthFeature = require('./feature')

/** Simulates the browser navigating to the callback URL success.ejs/error.ejs redirects to. */
const hitCallback = (port, query = '') => new Promise( (resolve,reject) => {
    http.get(`http://127.0.0.1:${port}/callback${query}`, { agent:false }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
    }).on('error', reject)
})

/** Extracts the redirect_uri (sid) the feature registered with auth-server, from the URL passed to shell.openExternal. */
const getCallbackOrigin = () => {
    const openedUrl = new URL(shell.openExternal.mock.calls[0][0])
    return new URL(openedUrl.searchParams.get('sid'))
}

describe('OauthFeature.authorize()', () => {

    let feature

    beforeEach(() => {
        OauthFeature._instance = undefined
        feature = new OauthFeature()
        jest.clearAllMocks()
        shell.openExternal.mockResolvedValue(undefined)
    })

    test('opens the system browser at <oauthUrl>/<provider>?sid=<loopback redirect_uri>', async () => {
        const promise = feature.authorize('strava')

        // let server.listen()'s callback (which calls shell.openExternal) run
        await new Promise(process.nextTick)

        expect(shell.openExternal).toHaveBeenCalledTimes(1)
        const openedUrl = new URL(shell.openExternal.mock.calls[0][0])
        expect(openedUrl.origin+openedUrl.pathname).toBe('https://auth.test.local/strava')

        const sid = new URL(openedUrl.searchParams.get('sid'))
        expect(sid.hostname).toBe('127.0.0.1')
        expect(sid.pathname).toBe('/callback')

        await hitCallback(Number(sid.port), '?error=aborted')
        await promise
    })

    test('resolves success with all callback query params passed through under user.auth.<provider>', async () => {
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '?accesstoken=tok123&refreshtoken=ref456&id=789')

        await expect(promise).resolves.toEqual({
            success: true,
            user: { auth: { strava: { accesstoken: 'tok123', refreshtoken: 'ref456', id: '789' } } }
        })
    })

    test('uses the provider passed to authorize() as the key under user.auth', async () => {
        const promise = feature.authorize('intervals')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '?accesstoken=tok')

        const result = await promise
        expect(result.user.auth).toHaveProperty('intervals')
        expect(result.user.auth).not.toHaveProperty('strava')
    })

    test('resolves { success:false, reason:"user aborted" } for ?error=aborted (mirrors error.ejs)', async () => {
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '?error=aborted')

        await expect(promise).resolves.toEqual({ success:false, reason:'user aborted' })
    })

    test('passes through a non-"aborted" error value from the callback as-is', async () => {
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '?error=access_denied')

        await expect(promise).resolves.toEqual({ success:false, reason:'access_denied' })
    })

    test('a request to any path other than /callback is ignored and does not resolve the promise', async () => {
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        const stray = await new Promise( (resolve,reject) => {
            http.get(`http://127.0.0.1:${sid.port}/favicon.ico`, { agent:false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) }).on('error',reject)
        })
        expect(stray).toBe(404)

        // the real callback still resolves the same pending promise afterwards
        await hitCallback(sid.port, '?accesstoken=tok')
        await expect(promise).resolves.toMatchObject({ success:true })
    })

    test('the loopback server stops listening once the flow completes', async () => {
        const createSpy = jest.spyOn(http, 'createServer')
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()
        const server = createSpy.mock.results[0].value

        await hitCallback(Number(sid.port), '?accesstoken=tok')
        await promise

        expect(server.listening).toBe(false)
        createSpy.mockRestore()
    })

    test('resolves { success:false } when shell.openExternal fails to open a browser', async () => {
        shell.openExternal.mockRejectedValue(new Error('no browser configured'))

        const result = await feature.authorize('strava')

        expect(result.success).toBe(false)
        expect(result.reason).toMatch(/no browser configured/)
    })

    test('times out and resolves { success:false, reason:"timeout" } if nothing ever hits the callback', async () => {
        jest.useFakeTimers()
        try {
            const promise = feature.authorize('strava')
            await Promise.resolve() // let server.listen() schedule shell.openExternal

            jest.advanceTimersByTime(5*60*1000 + 1)

            await expect(promise).resolves.toEqual({ success:false, reason:'timeout' })
        }
        finally {
            jest.useRealTimers()
        }
    })

})
