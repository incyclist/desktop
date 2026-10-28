const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const path = require('node:path')

const execFileAsync = promisify(execFile)

// Every file sent to eSigner is a billable signing, so only these are signed.
// Squirrel and the packager offer many more files (DLLs, .node modules, ...).
const FILES_TO_SIGN = ['incyclist.exe', 'update.exe']
// The installer is renamed to include the app name and version, e.g. "Incyclist-1.2.3 Setup.exe"
const INSTALLER_SUFFIX = 'setup.exe'

const REQUIRED_ENV = [
    'CODE_SIGN_TOOL_JAR',
    'SSL_COM_USERNAME',
    'SSL_COM_PASSWORD',
    'SSL_COM_CREDENTIAL_ID',
    'SSL_COM_TOTP_SECRET'
]

const shouldSign = (file) => {
    const name = path.win32.basename(file).toLowerCase()
    return FILES_TO_SIGN.includes(name) || name.endsWith(INSTALLER_SUFFIX)
}

const getMissingEnv = (env = process.env) => REQUIRED_ENV.filter(key => !env[key])

const buildArgs = (file, env = process.env) => [
    '-jar', env.CODE_SIGN_TOOL_JAR,
    'sign',
    `-username=${env.SSL_COM_USERNAME}`,
    `-password=${env.SSL_COM_PASSWORD}`,
    `-credential_id=${env.SSL_COM_CREDENTIAL_ID}`,
    `-totp_secret=${env.SSL_COM_TOTP_SECRET}`,
    `-input_file_path=${file}`,
    '-override=true'
]

// Squirrel may offer a file the packager has already signed. Signing it again would be billed again.
const isAlreadySigned = async (file) => {
    const script = `(Get-AuthenticodeSignature -LiteralPath $env:SIGN_CHECK_FILE).Status`
    try {
        const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            env: { ...process.env, SIGN_CHECK_FILE: file }
        })
        return stdout.trim() === 'Valid'
    }
    catch {
        return false
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

    if (await isAlreadySigned(file)) {
        console.log(`windows-sign: ${file} is already signed, skipping`)
        return
    }

    console.log(`windows-sign: signing ${file}`)
    const { stdout } = await execFileAsync('java', buildArgs(file), { maxBuffer: 10 * 1024 * 1024 })
    console.log(stdout)

    // CodeSignTool reports some failures on stdout with exit code 0
    if (/error/i.test(stdout)) {
        throw new Error(`CodeSignTool reported an error while signing ${file}`)
    }
}

module.exports = windowsSign
module.exports.default = windowsSign
module.exports.shouldSign = shouldSign
module.exports.getMissingEnv = getMissingEnv
module.exports.buildArgs = buildArgs
module.exports.FILES_TO_SIGN = FILES_TO_SIGN
