/**
 * Behaviour tests for FormPostFeature.createFormRequest() + postRequest()
 *
 * Strategy
 * --------
 * - Use the REAL impl-requestlib so the tests reflect what the current
 *   implementation actually does.
 * - Mock only at the I/O boundary:
 *     • `request.post`  – the outgoing HTTP call
 *     • `fs/promises`   – file reads for file-type upload fields
 * - The same test file can be run against impl-fetchapi by swapping the
 *   import in feature.js; if all tests still pass the replacement is
 *   behaviourally equivalent.
 */

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn(), on: jest.fn() } }))
jest.mock('../utils',  () => ({ ipcCall: jest.fn(), ipcHandle: jest.fn() }))

// ── HTTP boundary mock ───────────────────────────────────────────────────────
jest.mock('request')
const request = require('request')

// ── Filesystem boundary mock ─────────────────────────────────────────────────
jest.mock('fs/promises')
const fs = require('fs/promises')

// ── Subject under test (uses the real impl-requestlib internally) ────────────
const FormPostFeature = require('./feature')


// ─── helpers ────────────────────────────────────────────────────────────────

/** Simulate a successful request.post() callback */
const mockHttpSuccess = (body, statusCode = 200) => {
    request.post.mockImplementation((_url, _opts, cb) =>
        cb(null, { statusCode, statusMessage: 'OK' }, JSON.stringify(body))
    )
}

/** Simulate a non-2xx response from request.post() */
const mockHttpError = (statusCode, statusMessage, body = {}) => {
    request.post.mockImplementation((_url, _opts, cb) =>
        cb(null, { statusCode, statusMessage }, JSON.stringify(body))
    )
}

/** Simulate a network-level failure (ECONNREFUSED etc.) */
const mockHttpNetworkFailure = (message = 'connect ECONNREFUSED') => {
    request.post.mockImplementation((_url, _opts, cb) =>
        cb(new Error(message))
    )
}


// ─── suite ──────────────────────────────────────────────────────────────────

describe('FormPostFeature – behaviour against impl-requestlib', () => {

    let feature

    beforeEach(() => {
        FormPostFeature._instance = undefined
        feature = new FormPostFeature()
        jest.clearAllMocks()
    })


    // ── createFormRequest ────────────────────────────────────────────────────

    describe('createFormRequest', () => {

        test('plain fields are passed through unchanged into formData', async () => {
            const uploadInfo = { username: 'alice', score: 42 }
            const opts = { url: 'https://example.com/upload' }

            await feature.createFormRequest(opts, uploadInfo)

            const stored = feature.requests[0].opts
            expect(stored.formData.username).toBe('alice')
            expect(stored.formData.score).toBe(42)
        })

        test('undefined fields in uploadInfo are omitted from formData', async () => {
            const uploadInfo = { present: 'yes', missing: undefined }
            await feature.createFormRequest({ url: 'https://x.com' }, uploadInfo)

            const stored = feature.requests[0].opts
            expect(stored.formData).not.toHaveProperty('missing')
        })

        test('file-type fields are replaced with buffer + filepath options', async () => {
            const fileContent = Buffer.from('binary content')
            fs.readFile.mockResolvedValue(fileContent)

            const uploadInfo = {
                attachment: { type: 'file', fileName: '/tmp/photo.jpg' }
            }
            await feature.createFormRequest({ url: 'https://x.com' }, uploadInfo)

            const stored = feature.requests[0].opts
            expect(fs.readFile).toHaveBeenCalledWith('/tmp/photo.jpg')
            expect(stored.formData.attachment).toMatchObject({
                value:   fileContent,
                options: { filepath: '/tmp/photo.jpg' }
            })
        })

        test('original opts object is not mutated except for the added id', async () => {
            const opts = { url: 'https://x.com', method: 'POST' }

            await feature.createFormRequest(opts, { field: 'val' })

            // formData must live on the stored copy, not leak back onto opts
            expect(opts.formData).toBeUndefined()
            expect(opts.url).toBe('https://x.com')
        })

        test('returns opts with a newly assigned numeric id', async () => {
            const opts = { url: 'https://x.com' }
            const result = await feature.createFormRequest(opts, {})

            expect(result).toBe(opts)
            expect(typeof result.id).toBe('number')
        })

        test('still returns opts (without crashing) when fs.readFile rejects', async () => {
            fs.readFile.mockRejectedValue(new Error('file not found'))
            const uploadInfo = { doc: { type: 'file', fileName: '/missing.pdf' } }
            const opts = { url: 'https://x.com' }

            // impl-requestlib catches the error internally and returns opts anyway
            const result = await feature.createFormRequest(opts, uploadInfo)
            expect(result.id).toBeDefined()
        })

    })


    // ── postRequest ──────────────────────────────────────────────────────────

    describe('postRequest', () => {

        /** Convenience: create a request then immediately post it */
        const createAndPost = async (uploadInfo = { field: 'value' }) => {
            const opts    = { url: 'https://example.com/upload', method: 'POST' }
            const created = await feature.createFormRequest(opts, uploadInfo)
            return { result: await feature.postRequest({ id: created.id }), id: created.id }
        }

        test('sends the request to the correct URL', async () => {
            mockHttpSuccess({ ok: true })
            await createAndPost()
            expect(request.post).toHaveBeenCalledWith(
                'https://example.com/upload',
                expect.anything(),
                expect.any(Function)
            )
        })

        test('does NOT pass url as a field inside the request options', async () => {
            mockHttpSuccess({})
            await createAndPost()
            const passedOptions = request.post.mock.calls[0][1]
            expect(passedOptions).not.toHaveProperty('url')
        })

        test('returns { data } containing parsed JSON body on success', async () => {
            const serverPayload = { id: 99, status: 'accepted' }
            mockHttpSuccess(serverPayload)

            const { result } = await createAndPost()

            expect(result.error).toBeUndefined()
            expect(result.data).toMatchObject({
                data:       serverPayload,
                statusCode: 200,
            })
        })

        test('formData built by createFormRequest is forwarded to request.post', async () => {
            mockHttpSuccess({})
            await createAndPost({ username: 'bob', score: 7 })

            const passedOptions = request.post.mock.calls[0][1]
            expect(passedOptions.formData).toMatchObject({ username: 'bob', score: 7 })
        })

        test('returns { error } with status info on a non-2xx response', async () => {
            mockHttpError(422, 'Unprocessable Entity', { detail: 'bad input' })

            const { result } = await createAndPost()

            expect(result.data).toBeUndefined()
            expect(result.error).toBeDefined()
            expect(result.error.response.status).toBe(422)
            expect(result.error.response.message).toBe('Unprocessable Entity')
        })

        test('returns { error } on a network-level failure', async () => {
            mockHttpNetworkFailure('connect ECONNREFUSED 127.0.0.1:443')

            const { result } = await createAndPost()

            expect(result.data).toBeUndefined()
            expect(result.error).toBeInstanceOf(Error)
            expect(result.error.message).toMatch(/ECONNREFUSED/)
        })

        test('request is removed from queue after a successful post', async () => {
            mockHttpSuccess({})
            await createAndPost()
            expect(feature.requests).toHaveLength(0)
        })

        test('request is removed from queue even when post fails with HTTP error', async () => {
            mockHttpError(500, 'Internal Server Error')
            await createAndPost()
            expect(feature.requests).toHaveLength(0)
        })

        test('request is removed from queue even when post fails with network error', async () => {
            mockHttpNetworkFailure()
            await createAndPost()
            expect(feature.requests).toHaveLength(0)
        })

        test('returns { error: "request not found" } for an unknown id', async () => {
            const res = await feature.postRequest({ id: 99999 })
            expect(res.error.message).toBe('request not found')
            expect(request.post).not.toHaveBeenCalled()
        })

        test('second post with the same id returns "request not found"', async () => {
            mockHttpSuccess({})
            const { result: first, id } = await createAndPost()
            expect(first.error).toBeUndefined()

            const second = await feature.postRequest({ id })
            expect(second.error.message).toBe('request not found')
        })

    })

})
