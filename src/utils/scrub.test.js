const os = require('node:os')
const { scrubString, scrubValue, withPathScrubbing, resetCache } = require('./scrub')

describe('scrub', () => {
    beforeEach(() => { resetCache() })

    describe('scrubString', () => {
        let homedir
        beforeEach(() => { homedir = jest.spyOn(os, 'homedir') })
        afterEach(() => { homedir.mockRestore() })

        test('replaces the current home directory (posix)', () => {
            homedir.mockReturnValue('/home/jane')
            expect(scrubString('/home/jane/.config/Incyclist/logs')).toBe('$HOME/.config/Incyclist/logs')
        })

        test('replaces home directory with spaces in the user name', () => {
            homedir.mockReturnValue('C:\\Users\\Jane Doe')
            expect(scrubString('C:\\Users\\Jane Doe\\AppData\\Roaming\\Incyclist')).toBe('$HOME\\AppData\\Roaming\\Incyclist')
        })

        test('replaces JSON-escaped windows paths', () => {
            homedir.mockReturnValue('C:\\Users\\jane')
            expect(scrubString('{"p":"C:\\\\Users\\\\jane\\\\Videos\\\\a.mp4"}')).toBe('{"p":"$HOME\\\\Videos\\\\a.mp4"}')
        })

        test('replaces file:// urls, incl. url encoded names', () => {
            homedir.mockReturnValue('/home/jane doe')
            expect(scrubString('video:///home/jane%20doe/Videos/a.mp4')).toBe('video://$HOME/Videos/a.mp4')
        })

        test('replaces other users home dirs in stack traces', () => {
            homedir.mockReturnValue('/home/jane')
            expect(scrubString('at x (/Users/bob/dev/app.js:1:2)')).toBe('at x ($HOME/dev/app.js:1:2)')
            expect(scrubString('at x (C:\\Users\\bob\\AppData\\Local\\app.asar\\a.js)')).toBe('at x ($HOME\\AppData\\Local\\app.asar\\a.js)')
            expect(scrubString('at x (c:/users/bob/a.js)')).toBe('at x ($HOME/a.js)')
        })

        test('replaces multiple occurrences', () => {
            homedir.mockReturnValue('/home/jane')
            expect(scrubString('ENOENT /home/jane/a -> /home/jane/b')).toBe('ENOENT $HOME/a -> $HOME/b')
        })

        test('leaves paths outside of a home directory untouched', () => {
            homedir.mockReturnValue('/home/jane')
            expect(scrubString('D:\\Videos\\a.mp4')).toBe('D:\\Videos\\a.mp4')
            expect(scrubString('/mnt/nas/videos/a.mp4')).toBe('/mnt/nas/videos/a.mp4')
            expect(scrubString('/usr/lib/incyclist')).toBe('/usr/lib/incyclist')
        })

        test('does not break on a root-like home directory', () => {
            homedir.mockReturnValue('/')
            expect(scrubString('/etc/hosts')).toBe('/etc/hosts')
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
