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

// CodeSignTool reads ./conf/code_sign_tool.properties relative to its working directory.
// The jar sits in <tool dir>/jar, so the tool dir is its parent.
const getToolDir = (env = process.env) => path.win32.dirname(path.win32.dirname(env.CODE_SIGN_TOOL_JAR))

const buildArgs = (file, env = process.env) => [
    '-jar', env.CODE_SIGN_TOOL_JAR,
    'sign',
    `-username=${env.SSL_COM_USERNAME}`,
    `-password=${env.SSL_COM_PASSWORD}`,
    `-credential_id=${env.SSL_COM_CREDENTIAL_ID}`,
    `-totp_secret=${env.SSL_COM_TOTP_SECRET}`,
    `-input_file_path=${file}`,
    '-override'
]

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

const runCodeSignTool = async (file) => {
    try {
        const { stdout, stderr } = await execFileAsync('java', buildArgs(file), { cwd: getToolDir(), maxBuffer: 10 * 1024 * 1024 })
        console.log(`windows-sign: CodeSignTool stdout:\n${stdout}`)
        console.log(`windows-sign: CodeSignTool stderr:\n${stderr}`)
    }
    catch (err) {
        // CodeSignTool prints its failure reason to stdout/stderr
        console.log(`windows-sign: CodeSignTool failed (exit ${err.code}):\n${err.stdout}\n${err.stderr}`)
        throw new Error(`CodeSignTool failed while signing ${file}`)
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

    // Squirrel may offer a file the packager has already signed. Signing it again would be billed again.
    if (await getSignatureStatus(file) === 'Valid') {
        console.log(`windows-sign: ${file} is already signed, skipping`)
        return
    }

    console.log(`windows-sign: signing ${file}`)
    await runCodeSignTool(file)

    // CodeSignTool can exit successfully without having signed anything
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
module.exports.buildArgs = buildArgs
module.exports.getToolDir = getToolDir
module.exports.FILES_TO_SIGN = FILES_TO_SIGN
