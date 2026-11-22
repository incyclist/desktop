const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const BIG_BYTES = 48 * 1024 * 1024
const SMALL_BYTES = 200 * 1024

/**
 * Media fixtures of the self-host mode: a big video (to keep a stream in flight), a small video
 * (cheap content comparisons), a thumbnail, and one video that is deleted during the run.
 */
function createFixtures(dir) {
    fs.mkdirSync(dir, { recursive: true })
    const files = {
        big: path.join(dir, 'big.mp4'),
        small: path.join(dir, 'small.mp4'),
        thumb: path.join(dir, 'small.jpg'),
        gone: path.join(dir, 'gone.mp4'),
    }
    fs.writeFileSync(files.big, crypto.randomBytes(BIG_BYTES))
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
            route('g1-big', 'G1 big', files.big),
            route('g1-small', 'G1 small', files.small, files.thumb),
            route('g1-gone', 'G1 gone', files.gone),
        ],
        titles: { big: 'G1 big', small: 'G1 small', gone: 'G1 gone' },
    }
}

module.exports = { createFixtures, BIG_BYTES, SMALL_BYTES }
