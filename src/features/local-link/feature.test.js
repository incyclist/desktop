jest.mock('electron', () => ({
    ipcMain: { on: jest.fn() },
    app: { incyclistApp: undefined },
}))

const crypto = require('node:crypto')
const LocalLinkFeature = require('./feature')

describe('LocalLinkFeature', () => {
    let feature

    beforeEach(() => {
        feature = new LocalLinkFeature()
        feature.emitEvent = jest.fn()
        feature.media.emit = feature.emitEvent
    })

    afterEach(async () => {
        await feature.stop()
    })

    test('is a singleton', () => {
        expect(LocalLinkFeature.getInstance()).toBe(LocalLinkFeature.getInstance())
    })

    test('getCapabilities reports transport version 1', async () => {
        const caps = await feature.getCapabilities()
        expect(caps.transportVersion).toBe(1)
        expect(caps.capabilities).toEqual(expect.arrayContaining(['http-media', 'range', 'peer-filter']))
    })

    test('start/getStatus/stop for the media listener', async () => {
        const res = await feature.start({ media: { port: 0, host: '127.0.0.1' } })
        expect(res.media.ok).toBe(true)
        expect(res.control).toBeUndefined()
        expect(Array.isArray(res.addresses)).toBe(true)

        const again = await feature.start({ media: { port: 0, host: '127.0.0.1' } })
        expect(again.media).toMatchObject({ ok: true, alreadyRunning: true, port: res.media.port })

        let status = await feature.getStatus()
        expect(status.running).toEqual({ control: false, media: true })
        expect(status.ports.media).toBe(res.media.port)
        expect(status.announced).toBeNull()

        expect(await feature.stop({ listener: 'media' })).toEqual({ ok: true })
        status = await feature.getStatus()
        expect(status.running.media).toBe(false)
    })

    test('start without a media request does not start it', async () => {
        await feature.start({})
        expect((await feature.getStatus()).running.media).toBe(false)
    })

    test('publishMedia is reflected in the status counts', async () => {
        const digest = crypto.createHash('sha256').update('t').digest('base64url')
        const res = await feature.publishMedia({ documents: {}, handles: [{ handle: 'h1', path: '/tmp/x.mp4' }], tokens: [{ digest, id: 'a' }] })
        expect(res).toEqual({ ok: true, rejectedHandles: [], rejectedTokens: 0 })
        const status = await feature.getStatus()
        expect(status.handleCount).toBe(1)
        expect(status.tokenCount).toBe(1)
    })

    test('setPeerPolicy validates', async () => {
        expect((await feature.setPeerPolicy({ defaultPrivate: true, allow: ['100.64.0.0/10'] })).ok).toBe(true)
        expect((await feature.setPeerPolicy({ defaultPrivate: true, allow: ['nope'] })).ok).toBe(false)
    })
})
