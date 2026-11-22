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
