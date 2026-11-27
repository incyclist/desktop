const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const path = require('node:path')

// This module is loaded by @electron/windows-sign (also from inside its signtool shim),
// so it may only use Node built-ins.

const execFileAsync = promisify(execFile)

// Each signature uses the hardware key on the remote signer, and the signer only accepts
// a few files per session. Squirrel and the packager offer many more files (DLLs, .node modules, ...).
const FILES_TO_SIGN = ['incyclist.exe', 'update.exe']
// The installer is renamed to include the app name and version, e.g. "Incyclist-1.2.3 Setup.exe"
const INSTALLER_SUFFIX = 'setup.exe'

const REQUIRED_ENV = [
    'SIGNER_HOST',
    'SIGNER_PORT',
    'SIGNER_USER',
    'SIGNER_KEY_FILE',
    'SIGNER_KNOWN_HOSTS'
]

const shouldSign = (file) => {
    const name = path.win32.basename(file).toLowerCase()
    return FILES_TO_SIGN.includes(name) || name.endsWith(INSTALLER_SUFFIX)
}

const getMissingEnv = (env = process.env) => REQUIRED_ENV.filter(key => !env[key])

// The signer only runs a fixed command; the trailing file name is used for its log only.
const buildSshArgs = (file, env = process.env) => [
    '-T',
    '-i', env.SIGNER_KEY_FILE,
    '-p', String(env.SIGNER_PORT),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${env.SIGNER_KNOWN_HOSTS}`,
    '-o', 'ConnectTimeout=30',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=8',
    '-o', 'LogLevel=ERROR',
    `${env.SIGNER_USER}@${env.SIGNER_HOST}`,
    'sign', path.win32.basename(file).replace(/[^A-Za-z0-9._-]/g, '_')
]

// Streams the file to the signer over SSH and replaces it with the signed file it returns.
// The original stays untouched if anything fails.
const signRemote = (file, { env = process.env, spawnFn = spawn } = {}) => new Promise((resolve, reject) => {
    const signedFile = `${file}.signed`
    const child = spawnFn('ssh', buildSshArgs(file, env), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const out = fs.createWriteStream(signedFile)
    let stderr = ''
    let failed = false

    const fail = (err) => {
        if (failed) return
        failed = true
        out.destroy()
        fs.rm(signedFile, { force: true }, () => reject(err))
    }

    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.stdout.pipe(out)
    child.on('error', (err) => fail(new Error(`could not start ssh: ${err.message}`)))
    // The signer may close the connection early (e.g. no open session); that is reported via the exit code
    child.stdin.on('error', () => {})
    out.on('error', fail)

    fs.createReadStream(file)
        .on('error', fail)
        .pipe(child.stdin)

    let exitCode
    let pending = 2
    const done = () => {
        if (--pending > 0 || failed) return
        if (exitCode !== 0) {
            return fail(new Error(`signer failed for ${file} (exit ${exitCode}): ${stderr.trim()}`))
        }
        const size = fs.statSync(signedFile).size
        if (size === 0) {
            return fail(new Error(`signer returned an empty file for ${file}: ${stderr.trim()}`))
        }
        try {
            fs.renameSync(signedFile, file)
            resolve()
        }
        catch (err) {
            fail(err)
        }
    }
    child.on('close', (code) => { exitCode = code; done() })
    out.on('finish', done)
})

const getSignatureStatus = async (file) => {
    const script = `(Get-AuthenticodeSignature -LiteralPath $env:SIGN_CHECK_FILE).Status`
    try {
        const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            env: { ...process.env, SIGN_CHECK_FILE: file }
        })
        return stdout.trim()
    }
    catch {
        return 'Unknown'
    }
}

// Called by @electron/windows-sign once per file. Errors thrown here are only logged by the caller,
// so the workflow verifies the signatures after the build.
async function windowsSign(file) {
    if (!shouldSign(file)) {
        return
    }

    const missing = getMissingEnv()
    if (missing.length > 0) {
        throw new Error(`Cannot sign ${file}: missing environment variables ${missing.join(', ')}`)
    }

    // Squirrel may offer a file the packager has already signed. Signing it again would use up the signer's budget.
    if (await getSignatureStatus(file) === 'Valid') {
        console.log(`windows-sign: ${file} is already signed, skipping`)
        return
    }

    console.log(`windows-sign: signing ${file}`)
    await signRemote(file)

    const status = await getSignatureStatus(file)
    if (status !== 'Valid') {
        throw new Error(`${file} has signature status ${status} after signing`)
    }
    console.log(`windows-sign: signed ${file}`)
}

module.exports = windowsSign
module.exports.default = windowsSign
module.exports.shouldSign = shouldSign
module.exports.getMissingEnv = getMissingEnv
module.exports.buildSshArgs = buildSshArgs
module.exports.signRemote = signRemote
module.exports.FILES_TO_SIGN = FILES_TO_SIGN
