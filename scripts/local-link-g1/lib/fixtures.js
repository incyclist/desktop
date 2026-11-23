const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const MB = 1024 * 1024
/** Real shared videos are multi-GB: the big fixture is a SPARSE file, so it costs next to no disk. */
const HUGE_BYTES = 4 * 1024 * MB + 12_345
const SMALL_BYTES = 200 * 1024

/** Writes random bytes at an offset of an (otherwise sparse) file, so that wrong offsets are detectable. */
function seed(file, offset, length) {
    const fd = fs.openSync(file, 'r+')
    try { fs.writeSync(fd, crypto.randomBytes(length), 0, length, offset) }
    finally { fs.closeSync(fd) }
}

/**
 * Media fixtures of the self-host mode: a huge SPARSE video (4 GB + a few bytes, random data only in
 * the windows the checks read), a small video with a thumbnail, and one video that is deleted during the run.
 */
function createFixtures(dir) {
    fs.mkdirSync(dir, { recursive: true })
    const files = {
        huge: path.join(dir, 'huge.mp4'),
        small: path.join(dir, 'small.mp4'),
        thumb: path.join(dir, 'small.jpg'),
        gone: path.join(dir, 'gone.mp4'),
    }
    fs.writeFileSync(files.huge, '')
    fs.truncateSync(files.huge, HUGE_BYTES)
    const mid = Math.floor((HUGE_BYTES - MB) / 2)
    seed(files.huge, 0, MB)
    seed(files.huge, mid, MB)
    seed(files.huge, HUGE_BYTES - MB, MB)
    seed(files.huge, Math.floor(HUGE_BYTES * 0.25), 8192)
    seed(files.huge, Math.floor(HUGE_BYTES * 0.75), 8192)
    fs.writeFileSync(files.small, crypto.randomBytes(SMALL_BYTES))
    fs.writeFileSync(files.thumb, crypto.randomBytes(4096))
    fs.writeFileSync(files.gone, crypto.randomBytes(8192))

    const route = (id, title, video, preview) => ({
        description: {
            id, title, isLocal: true, routeHash: `hash-${id}`, videoFormat: 'mp4', tsLastChange: 1_700_000_000_000,
            videoUrl: pathToFileURL(video).href, previewUrl: preview ? pathToFileURL(preview).href : undefined,
        },
    })
    return {
        files,
        routes: [
            route('g1-huge', 'G1 huge', files.huge),
            route('g1-small', 'G1 small', files.small, files.thumb),
            route('g1-gone', 'G1 gone', files.gone),
        ],
        titles: { huge: 'G1 huge', small: 'G1 small', gone: 'G1 gone' },
    }
}

module.exports = { createFixtures, HUGE_BYTES, SMALL_BYTES }
