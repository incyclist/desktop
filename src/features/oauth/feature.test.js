/**
 * Behaviour tests for OauthFeature.authorize()
 *
 * Strategy
 * --------
 * - Use the REAL `http` module - a genuine loopback server is fast/reliable
 *   in a test environment and lets these tests exercise the exact request
 *   parsing logic the browser redirect would trigger, rather than mocking it
 *   away.
 * - Mock only the Electron boundary (`shell.openExternal`, `app.incyclistApp`),
 *   `axios` (the off-browser code-exchange call to auth-server) and
 *   `ipcMain`/../utils (unused here but required by the module).
 */

jest.mock('electron', () => ({
    ipcMain: { handle: jest.fn(), on: jest.fn() },
    app: { incyclistApp: { settings: { oauthUrl: 'https://auth.test.local/' } } },
    shell: { openExternal: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('../utils', () => ({ ipcCall: jest.fn(), ipcHandle: jest.fn(), ipcCallNoResponse: jest.fn(), ipcHandleNoResponse: jest.fn() }))
jest.mock('axios')

const http = require('node:http')
const crypto = require('node:crypto')
const axios = require('axios')
const { shell } = require('electron')
const OauthFeature = require('./feature')

/** Simulates the browser navigating to the callback URL success.ejs/error.ejs redirects to. */
const hitCallback = (port, query = '') => new Promise( (resolve,reject) => {
    http.get(`http://127.0.0.1:${port}/callback${query}`, { agent:false }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
    }).on('error', reject)
})

/** Parses the URL the feature opened via shell.openExternal. */
const getOpenedUrl = () => new URL(shell.openExternal.mock.calls[0][0])

const getCallbackOrigin = () => new URL(getOpenedUrl().searchParams.get('sid'))

const sha256base64url = (value) => crypto.createHash('sha256').update(value).digest('base64url')

describe('OauthFeature.authorize()', () => {

    let feature

    beforeEach(() => {
        OauthFeature._instance = undefined
        feature = new OauthFeature()
        jest.clearAllMocks()
        shell.openExternal.mockResolvedValue(undefined)
        axios.post.mockResolvedValue({ data: { user: { auth: { strava: { accesstoken:'tok' } } } } })
    })

    test('opens the system browser at <oauthUrl>/<provider>?sid=<loopback redirect_uri>&code_challenge=...', async () => {
        const promise = feature.authorize('strava')

        // let server.listen()'s callback (which calls shell.openExternal) run
        await new Promise(process.nextTick)

        expect(shell.openExternal).toHaveBeenCalledTimes(1)
        const openedUrl = getOpenedUrl()
        expect(openedUrl.origin+openedUrl.pathname).toBe('https://auth.test.local/strava')
        expect(openedUrl.searchParams.get('code_challenge_method')).toBe('S256')
        expect(openedUrl.searchParams.get('code_challenge')).toBeTruthy()

        const sid = new URL(openedUrl.searchParams.get('sid'))
        expect(sid.hostname).toBe('127.0.0.1')
        expect(sid.pathname).toBe('/callback')

        await hitCallback(Number(sid.port), '?error=aborted')
        await promise
    })

    test('exchanges the callback code for tokens via a direct POST carrying the matching verifier', async () => {
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const openedUrl = getOpenedUrl()
        const codeChallenge = openedUrl.searchParams.get('code_challenge')
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '?code=abc123')
        await promise

        expect(axios.post).toHaveBeenCalledTimes(1)
        const [url, body] = axios.post.mock.calls[0]
        expect(url).toBe('https://auth.test.local/strava/token')
        expect(body.code).toBe('abc123')
        // the verifier sent to auth-server must be the pre-image of the
        // code_challenge that was published in the (attacker-visible) browser URL
        expect(sha256base64url(body.code_verifier)).toBe(codeChallenge)
    })

    test('resolves { success:true, user } from the token-exchange response body', async () => {
        axios.post.mockResolvedValue({ data: { user: { auth: { strava: { accesstoken:'tok123', refreshtoken:'ref456', id:'789' } } } } })

        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '?code=abc123')

        await expect(promise).resolves.toEqual({
            success: true,
            user: { auth: { strava: { accesstoken:'tok123', refreshtoken:'ref456', id:'789' } } }
        })
    })

    test('resolves { success:false } when the code exchange POST fails (e.g. wrong/expired code)', async () => {
        axios.post.mockRejectedValue({ response: { status: 400, data: { error:'invalid_grant' } } })

        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '?code=stale-code')

        await expect(promise).resolves.toMatchObject({ success:false })
    })

    test('resolves { success:false, reason:"no code in callback" } if the callback carries neither code nor error', async () => {
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '')

        await expect(promise).resolves.toEqual({ success:false, reason:'no code in callback' })
        expect(axios.post).not.toHaveBeenCalled()
    })

    test('resolves { success:false, reason:"user aborted" } for ?error=aborted (mirrors error.ejs)', async () => {
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()

        await hitCallback(Number(sid.port), '?error=aborted')

        await expect(promise).resolves.toEqual({ success:false, reason:'user aborted' })
        expect(axios.post).not.toHaveBeenCalled()
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
        await hitCallback(sid.port, '?code=abc123')
        await expect(promise).resolves.toMatchObject({ success:true })
    })

    test('the loopback server stops listening once the flow completes', async () => {
        const createSpy = jest.spyOn(http, 'createServer')
        const promise = feature.authorize('strava')
        await new Promise(process.nextTick)
        const sid = getCallbackOrigin()
        const server = createSpy.mock.results[0].value

        await hitCallback(Number(sid.port), '?code=abc123')
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
