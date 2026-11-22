const http = require('node:http')

/**
 * One HTTP request without keep-alive. Resolves with {status, headers, body} once the response
 * is complete, or {error} if the connection broke first.
 */
function get(target, path, { method = 'GET', token, auth = 'query', headers = {}, timeout = 8000 } = {}) {
    return new Promise(resolve => {
        const h = { ...headers }
        let p = path
        if (token && auth === 'bearer')
            h.Authorization = `Bearer ${token}`
        else if (token)
            p += (p.includes('?') ? '&' : '?') + `t=${encodeURIComponent(token)}`
        const req = http.request({ host: target.host, port: target.port, path: p, method, headers: h, agent: false, timeout }, res => {
            const chunks = []
            res.on('data', c => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
            res.on('error', error => resolve({ error, status: res.statusCode, partial: Buffer.concat(chunks) }))
            res.on('aborted', () => resolve({ error: new Error('aborted'), status: res.statusCode, partial: Buffer.concat(chunks) }))
        })
        req.on('timeout', () => { req.destroy(new Error('timeout')) })
        req.on('error', error => resolve({ error }))
        req.end()
    })
}

/**
 * Starts a request and hands over the live response (paused), so a test can hold a stream open.
 * Resolves with {res, req, done} where `done` resolves with {bytes, ok, error} when the body ends or breaks.
 */
function openStream(target, path, { token, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: target.host, port: target.port, agent: false,
            path: path + (path.includes('?') ? '&' : '?') + `t=${encodeURIComponent(token)}`, headers,
        }, res => {
            res.pause()
            const state = { bytes: 0 }
            const done = new Promise(done => {
                res.on('data', c => { state.bytes += c.length })
                res.on('end', () => done({ ok: true, bytes: state.bytes }))
                res.on('error', error => done({ ok: false, bytes: state.bytes, error }))
                res.on('aborted', () => done({ ok: false, bytes: state.bytes, error: new Error('aborted') }))
                res.on('close', () => done({ ok: res.complete, bytes: state.bytes }))
            })
            resolve({ res, req, done, state })
        })
        req.on('error', reject)
        req.end()
    })
}

/** Reads at most `maxBytes` of a response and then drops the connection (for open-ended ranges of big files). */
function peek(target, path, { token, headers = {}, maxBytes = 65536 } = {}) {
    return new Promise(resolve => {
        const req = http.request({
            host: target.host, port: target.port, agent: false, headers,
            path: path + (path.includes('?') ? '&' : '?') + `t=${encodeURIComponent(token)}`,
        }, res => {
            const chunks = []
            let got = 0
            const finish = () => { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }) }
            res.on('data', c => { chunks.push(c); got += c.length; if (got >= maxBytes) finish() })
            res.on('end', finish)
            res.on('error', finish)
        })
        req.on('error', error => resolve({ error }))
        req.end()
    })
}

/** Raw TCP request, for malformed requests. Resolves with everything received until close. */
function raw(target, text, timeout = 3000) {
    const net = require('node:net')
    return new Promise(resolve => {
        const chunks = []
        const socket = net.connect(target.port, target.host, () => socket.write(text))
        socket.setTimeout(timeout, () => socket.destroy())
        socket.on('data', c => chunks.push(c))
        socket.on('error', () => undefined)
        socket.on('close', () => resolve(Buffer.concat(chunks)))
    })
}

/** Splits a multipart/byteranges body into [{range:'a-b/size', body}] */
function parseMultipart(body, contentType) {
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
    if (!boundary)
        return undefined
    const text = body.toString('latin1')
    const parts = []
    const delim = `--${boundary}`
    let pos = text.indexOf(delim)
    while (pos !== -1) {
        const after = pos + delim.length
        if (text.startsWith('--', after))
            break
        const headEnd = text.indexOf('\r\n\r\n', after)
        const head = text.slice(after, headEnd)
        const range = /Content-Range: bytes (\d+)-(\d+)\/(\d+)/i.exec(head)
        const next = text.indexOf(`\r\n${delim}`, headEnd + 4)
        parts.push({ start: Number(range[1]), end: Number(range[2]), size: Number(range[3]), body: body.subarray(headEnd + 4, next) })
        pos = next === -1 ? -1 : next + 2
    }
    return parts
}

module.exports = { get, peek, openStream, raw, parseMultipart }
