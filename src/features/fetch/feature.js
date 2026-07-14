const { ipcMain, net } = require('electron');
const { EventLogger } = require('gd-eventlog');
const Feature = require('../base');
const { ipcCall, ipcHandle } = require('../utils');

// singleton pattern
class FetchFeature extends Feature {
    static _instance;

    constructor(props = {}) {
        super(props)
        this.logger = new EventLogger('fetch')
    }

    static getInstance() {
        if (!FetchFeature._instance)
            FetchFeature._instance = new FetchFeature()
        return FetchFeature._instance
    }

    // Issues the request from the main process via Electron's net module, so a
    // custom cross-origin Referer can be forced with referrerPolicy:'unsafe-url' -
    // an option that only exists on net.request, not on the renderer's fetch/XHR.
    async fetch(url, init = {}) {
        const { method = 'GET', headers = {}, body, referrerPolicy } = init

        return new Promise((resolve, reject) => {
            let request
            try {
                request = net.request({ url, method, referrerPolicy })
            }
            catch (err) {
                reject(err)
                return
            }

            Object.entries(headers).forEach(([key, value]) => {
                request.setHeader(key, value)
            })

            request.on('response', (response) => {
                const chunks = []
                response.on('data', (chunk) => chunks.push(chunk))
                response.on('end', () => {
                    const data = Buffer.concat(chunks).toString('utf-8')
                    const responseHeaders = {}
                    Object.entries(response.headers ?? {}).forEach(([key, value]) => {
                        responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value
                    })

                    resolve({
                        ok: response.statusCode >= 200 && response.statusCode < 300,
                        status: response.statusCode,
                        statusText: response.statusMessage,
                        headers: responseHeaders,
                        data
                    })
                })
                response.on('error', (err) => {
                    this.logger.logEvent({ message: 'error', fn: 'fetch', url, error: err.message })
                    reject(err)
                })
            })

            request.on('error', (err) => {
                this.logger.logEvent({ message: 'error', fn: 'fetch', url, error: err.message })
                reject(err)
            })

            if (body !== undefined)
                request.write(body)
            request.end()
        })
    }

    register(_props) {
        ipcHandle('fetch-request', this.fetch.bind(this), ipcMain)
    }

    registerRenderer(spec, ipcRenderer) {
        spec.fetch = {}
        spec.fetch.request = ipcCall('fetch-request', ipcRenderer)

        spec.registerFeatures([
            'fetch', 'fetch.referrerPolicy'
        ])
    }

}

module.exports = FetchFeature
