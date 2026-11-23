const { restLogFilter, fileLogFilter } = require('./logging')

describe('log filters', () => {
    test('per-request local-link lines go to the file only', () => {
        const event = { message: 'local-link media request' }
        expect(fileLogFilter('LocalLinkRequests', event)).toBe(true)
        expect(restLogFilter('LocalLinkRequests', event)).toBe(false)
    })

    test('local-link lifecycle lines are forwarded', () => {
        expect(restLogFilter('LocalLink', { message: 'x' })).toBe(true)
    })

    test('undefined context or event is dropped', () => {
        expect(restLogFilter(undefined, {})).toBe(false)
        expect(fileLogFilter('LocalLink', undefined)).toBe(false)
    })
})

describe('log filters never throw', () => {
    afterEach(() => { jest.restoreAllMocks() })

    test('restLogFilter drops the event and reports to the console if the lookup throws', () => {
        const err = jest.spyOn(console, 'error').mockImplementation(() => {})
        jest.spyOn(Array.prototype, 'includes').mockImplementation(() => { throw new Error('boom') })
        expect(restLogFilter('LocalLink', { message: 'x' })).toBe(false)
        expect(err).toHaveBeenCalledWith(expect.stringContaining('boom'))
    })
})
