const os = require('node:os')
const { scrubString, scrubValue, withPathScrubbing, resetCache } = require('./scrub')

describe('scrub', () => {
    beforeEach(() => { resetCache() })

    describe('scrubString', () => {
        let homedir
        beforeEach(() => { homedir = jest.spyOn(os, 'homedir') })
        afterEach(() => { homedir.mockRestore() })

        // [description, home directory, input, expected]
        const cases = [
            ['current home directory (posix)', '/home/jane', '/home/jane/.config/Incyclist/logs', '$HOME/.config/Incyclist/logs'],
            ['user name with spaces', 'C:\\Users\\Jane Doe', 'C:\\Users\\Jane Doe\\AppData\\Roaming', '$HOME\\AppData\\Roaming'],
            ['JSON-escaped windows path', 'C:\\Users\\jane', '{"p":"C:\\\\Users\\\\jane\\\\a.mp4"}', '{"p":"$HOME\\\\a.mp4"}'],
            ['url encoded user name in a url', '/home/jane doe', 'video:///home/jane%20doe/Videos/a.mp4', 'video://$HOME/Videos/a.mp4'],
            ['other user (posix, in stack trace)', '/home/jane', 'at x (/Users/bob/dev/app.js:1:2)', 'at x ($HOME/dev/app.js:1:2)'],
            ['other user (windows, in stack trace)', '/home/jane', 'at x (C:\\Users\\bob\\Local\\a.js)', 'at x ($HOME\\Local\\a.js)'],
            ['other user (lower case windows path)', '/home/jane', 'at x (c:/users/bob/a.js)', 'at x ($HOME/a.js)'],
            ['multiple occurrences', '/home/jane', 'ENOENT /home/jane/a -> /home/jane/b', 'ENOENT $HOME/a -> $HOME/b'],
            ['other drive (untouched)', '/home/jane', 'D:\\Videos\\a.mp4', 'D:\\Videos\\a.mp4'],
            ['network mount (untouched)', '/home/jane', '/mnt/nas/videos/a.mp4', '/mnt/nas/videos/a.mp4'],
            ['system path (untouched)', '/home/jane', '/usr/lib/incyclist', '/usr/lib/incyclist'],
            ['root-like home directory', '/', '/etc/hosts', '/etc/hosts'],
        ]

        test.each(cases)('%s', (_name, home, input, expected) => {
            homedir.mockReturnValue(home)
            expect(scrubString(input)).toBe(expected)
        })

        test('ignores non-strings', () => {
            expect(scrubString(undefined)).toBeUndefined()
            expect(scrubString(5)).toBe(5)
            expect(scrubString('')).toBe('')
        })
    })

    describe('scrubValue', () => {
        beforeEach(() => { jest.spyOn(os, 'homedir').mockReturnValue('/home/jane') })
        afterEach(() => { jest.restoreAllMocks() })

        test('scrubs nested objects and arrays without modifying the input', () => {
            const input = { message: 'x', info: { dir: '/home/jane/Videos', list: ['/home/jane/a', 3] }, n: 1, u: undefined, nul: null }
            const res = scrubValue(input)
            expect(res).toEqual({ message: 'x', info: { dir: '$HOME/Videos', list: ['$HOME/a', 3] }, n: 1, u: undefined, nul: null })
            expect(input.info.dir).toBe('/home/jane/Videos')
        })

        test('keeps class instances as is', () => {
            const err = new Error('/home/jane/x')
            expect(scrubValue({ err }).err).toBe(err)
        })

        test('handles circular references', () => {
            const a = { p: '/home/jane/x' }
            a.self = a
            const res = scrubValue(a)
            expect(res.p).toBe('$HOME/x')
            expect(res.self).toBe('[Circular]')
        })

        test('scrubs every occurrence of a shared (non-circular) reference', () => {
            const o = { p: '/home/jane/x' }
            const res = scrubValue({ a: o, b: o, c: [o] })
            expect(res.a.p).toBe('$HOME/x')
            expect(res.b.p).toBe('$HOME/x')
            expect(res.c[0].p).toBe('$HOME/x')
        })

        test('scrubs object keys', () => {
            const res = scrubValue({ first: 1, '/home/jane/v.mp4': { n: '/home/jane/w' }, last: 2 })
            expect(res).toEqual({ first: 1, '$HOME/v.mp4': { n: '$HOME/w' }, last: 2 })
        })

        test('returns the original if nothing needs to be replaced', () => {
            const input = { a: 1, b: ['x', { c: 'y' }], d: { e: true } }
            expect(scrubValue(input)).toBe(input)
        })

        test('copies only the changed branch', () => {
            const clean = { x: 1 }
            const input = { clean, dirty: { p: '/home/jane/a' } }
            const res = scrubValue(input)
            expect(res).not.toBe(input)
            expect(res.clean).toBe(clean)
        })

        test('fails closed beyond the max depth', () => {
            let deep = { p: '/home/jane/secret' }
            for (let i = 0; i < 15; i++) deep = { n: deep }
            expect(JSON.stringify(scrubValue(deep))).not.toContain('jane')
        })

        test('scrubs a non-standard home directory with a one character name', () => {
            os.homedir.mockReturnValue('/srv/j')
            resetCache()
            expect(scrubString('open /srv/j/x')).toBe('open $HOME/x')
        })
    })

    describe('withPathScrubbing', () => {
        beforeEach(() => { jest.spyOn(os, 'homedir').mockReturnValue('/home/jane') })
        afterEach(() => { jest.restoreAllMocks() })

        test('scrubs the event and does not forward the unfiltered raw event', () => {
            const log = jest.fn()
            const adapter = { log }
            withPathScrubbing(adapter)

            adapter.log('ctx', { path: '/home/jane/a' }, { data: { path: '/home/jane/a' }, event: {}, context: 'c' })

            expect(log).toHaveBeenCalledWith('ctx', { path: '$HOME/a' }, undefined)
        })

        test('works without raw event', () => {
            const log = jest.fn()
            const adapter = { log }
            withPathScrubbing(adapter)
            adapter.log('ctx', { path: '/home/jane/a' })
            expect(log).toHaveBeenCalledWith('ctx', { path: '$HOME/a' }, undefined)
        })

        test('keeps adapter this-binding and does not wrap twice', () => {
            const adapter = { calls: 0, log() { this.calls++ } }
            withPathScrubbing(adapter)
            const wrapped = adapter.log
            withPathScrubbing(adapter)
            expect(adapter.log).toBe(wrapped)
            adapter.log('ctx', {})
            expect(adapter.calls).toBe(1)
        })

        test('tolerates undefined adapter', () => {
            expect(withPathScrubbing(undefined)).toBeUndefined()
        })
    })
})
