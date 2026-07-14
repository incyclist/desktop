const EventEmitter = require('node:events')

jest.mock('electron', () => ({
    ipcMain: { on: jest.fn() },
    net: { request: jest.fn() },
}))

jest.mock('../utils', () => ({
    ipcCall: jest.fn(),
    ipcHandle: jest.fn(),
}))

const { ipcMain, net } = require('electron')
const { ipcCall, ipcHandle } = require('../utils')
const FetchFeature = require('./feature')

class FakeIncomingMessage extends EventEmitter {
    constructor(props = {}) {
        super()
        this.statusCode = props.statusCode ?? 200
        this.statusMessage = props.statusMessage ?? 'OK'
        this.headers = props.headers ?? {}
    }
}

class FakeClientRequest extends EventEmitter {
    constructor() {
        super()
        this.setHeader = jest.fn()
        this.write = jest.fn()
        this.end = jest.fn()
    }
}

describe('FetchFeature', () => {

    describe('getInstance', () => {
        beforeEach(() => {
            FetchFeature._instance = undefined
        })

        test('1st call -> creates new object', () => {
            const f = FetchFeature.getInstance()
            expect(f).toBeDefined()
        })

        test('2nd call -> returns previously created object', () => {
            const f1 = FetchFeature.getInstance()
            const f2 = FetchFeature.getInstance()
            expect(f1).toBe(f2)
        })
    })

    describe('fetch', () => {
        let feature
        let request

        beforeEach(() => {
            feature = new FetchFeature()
            request = new FakeClientRequest()
            net.request = jest.fn(() => request)
        })

        test('issues a GET by default and resolves with an axios/fetch-like response', async () => {
            const promise = feature.fetch('https://overpass.example/api/interpreter')

            const response = new FakeIncomingMessage({ statusCode: 200, statusMessage: 'OK', headers: { 'content-type': ['application/json'] } })
            request.emit('response', response)
            response.emit('data', Buffer.from('{"a":1}'))
            response.emit('end')

            const res = await promise

            expect(net.request).toHaveBeenCalledWith({ url: 'https://overpass.example/api/interpreter', method: 'GET', referrerPolicy: undefined })
            expect(request.end).toHaveBeenCalled()
            expect(request.write).not.toHaveBeenCalled()
            expect(res).toEqual({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json' },
                data: '{"a":1}'
            })
        })

        test('sends method, headers, body and referrerPolicy through to net.request', async () => {
            const promise = feature.fetch('https://overpass.example/api/interpreter', {
                method: 'POST',
                headers: { 'User-Agent': 'Incyclist/1.0', 'Referer': 'https://incyclist.com' },
                body: 'query-data',
                referrerPolicy: 'unsafe-url'
            })

            expect(net.request).toHaveBeenCalledWith({ url: 'https://overpass.example/api/interpreter', method: 'POST', referrerPolicy: 'unsafe-url' })
            expect(request.setHeader).toHaveBeenCalledWith('User-Agent', 'Incyclist/1.0')
            expect(request.setHeader).toHaveBeenCalledWith('Referer', 'https://incyclist.com')
            expect(request.write).toHaveBeenCalledWith('query-data')

            const response = new FakeIncomingMessage({ statusCode: 400, statusMessage: 'Bad Request' })
            request.emit('response', response)
            response.emit('end')

            const res = await promise
            expect(res.ok).toBe(false)
            expect(res.status).toBe(400)
        })

        test('rejects when the request emits an error', async () => {
            const promise = feature.fetch('https://overpass.example/api/interpreter')
            const error = new Error('network down')
            request.emit('error', error)

            await expect(promise).rejects.toBe(error)
        })

        test('rejects when the response emits an error', async () => {
            const promise = feature.fetch('https://overpass.example/api/interpreter')
            const response = new FakeIncomingMessage()
            request.emit('response', response)
            const error = new Error('stream broken')
            response.emit('error', error)

            await expect(promise).rejects.toBe(error)
        })
    })

    describe('register', () => {
        test('registers the fetch-request IPC handler', () => {
            const feature = new FetchFeature()
            feature.register()

            expect(ipcHandle).toHaveBeenCalledWith('fetch-request', expect.any(Function), ipcMain)
        })
    })

    describe('registerRenderer', () => {
        test('exposes spec.fetch.request and announces capabilities', () => {
            const feature = new FetchFeature()
            const spec = { registerFeatures: jest.fn() }
            const ipcRenderer = {}

            feature.registerRenderer(spec, ipcRenderer)

            expect(ipcCall).toHaveBeenCalledWith('fetch-request', ipcRenderer)
            expect(spec.registerFeatures).toHaveBeenCalledWith(['fetch', 'fetch.referrerPolicy'])
        })
    })

})
