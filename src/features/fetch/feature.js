const { ipcMain, net } = require('electron');
const { EventLogger } = require('gd-eventlog');
const Feature = require('../base');
const { ipcCall, ipcHandle } = require('../utils');

function toPlainHeaders(headers = {}) {
    const result = {}
    Object.entries(headers).forEach(([key, value]) => {
        result[key] = Array.isArray(value) ? value.join(', ') : value
    })
    return result
}

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

            Object.entries(headers).forEach(([key, value]) => request.setHeader(key, value))

            request.on('response', (response) => this._handleResponse(url, response, resolve, reject))
            request.on('error', (err) => this._handleError(url, err, reject))

            if (body !== undefined)
                request.write(body)
            request.end()
        })
    }

    _handleResponse(url, response, resolve, reject) {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: toPlainHeaders(response.headers),
            data: Buffer.concat(chunks).toString('utf-8')
        }))
        response.on('error', (err) => this._handleError(url, err, reject))
    }

    _handleError(url, err, reject) {
        this.logger.logEvent({ message: 'error', fn: 'fetch', url, error: err.message })
        reject(err)
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
