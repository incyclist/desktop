const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { shouldSign, getMissingEnv, buildSshArgs, signRemote } = require('./windowsSign')

const env = {
    SIGNER_HOST: '203.0.113.7',
    SIGNER_PORT: '2223',
    SIGNER_USER: 'incyclist-signer',
    SIGNER_KEY_FILE: 'C:\\tmp\\signer_key',
    SIGNER_KNOWN_HOSTS: 'C:\\tmp\\signer_known_hosts'
}

// Fake ssh process: reads the file from stdin and answers like the signer would
const fakeSpawn = ({ code = 0, reply = (input) => Buffer.concat([Buffer.from('SIGNED:'), input]), stderr = '' } = {}) => {
    const calls = []
    const spawnFn = (cmd, args) => {
        calls.push({ cmd, args })
        const child = new EventEmitter()
        child.stdin = new PassThrough()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        const chunks = []
        child.stdin.on('data', (d) => chunks.push(d))
        child.stdin.on('end', () => {
            if (stderr) child.stderr.write(stderr)
            child.stderr.end()
            const out = reply(Buffer.concat(chunks))
            if (out.length) child.stdout.write(out)
            child.stdout.end()
            setImmediate(() => child.emit('close', code))
        })
        return child
    }
    return { spawnFn, calls }
}

describe('windowsSign', () => {

    describe('shouldSign', () => {
        test.each([
            'C:\\work\\out\\Incyclist-win32-x64\\Incyclist.exe',
            'C:\\tmp\\Update.exe',
            'C:\\tmp\\Setup.exe',
            '/tmp/setup.EXE',
            'C:\\work\\out\\make\\Incyclist-26.8.2 Setup.exe'
        ])('signs %s', (file) => {
            expect(shouldSign(file)).toBe(true)
        })

        test.each([
            'C:\\work\\out\\Incyclist-win32-x64\\ffmpeg.dll',
            'C:\\work\\out\\Incyclist-win32-x64\\vcruntime140.dll',
            'C:\\work\\node_modules\\usb\\prebuilds\\win32-x64\\node.napi.node',
            'C:\\work\\out\\Incyclist-win32-x64\\chrome_crashpad_handler.exe',
            'C:\\work\\Incyclist-0.9.0-full.nupkg'
        ])('does not sign %s', (file) => {
            expect(shouldSign(file)).toBe(false)
        })
    })

    describe('getMissingEnv', () => {
        test('returns nothing when all variables are set', () => {
            expect(getMissingEnv(env)).toEqual([])
        })

        test('lists empty and absent variables', () => {
            expect(getMissingEnv({ ...env, SIGNER_HOST: '', SIGNER_KEY_FILE: undefined }))
                .toEqual(['SIGNER_HOST', 'SIGNER_KEY_FILE'])
        })
    })

    describe('buildSshArgs', () => {
        test('connects non-interactively with the pinned host key and names the file', () => {
            const args = buildSshArgs('C:\\work\\out\\make\\Incyclist-26.8.2 Setup.exe', env)

            expect(args).toEqual(expect.arrayContaining([
                '-T',
                'BatchMode=yes',
                'IdentitiesOnly=yes',
                'StrictHostKeyChecking=yes',
                'UserKnownHostsFile=C:\\tmp\\signer_known_hosts'
            ]))
            expect(args.slice(1, 5)).toEqual(['-i', 'C:\\tmp\\signer_key', '-p', '2223'])
            expect(args.slice(-3)).toEqual(['incyclist-signer@203.0.113.7', 'sign', 'Incyclist-26.8.2_Setup.exe'])
        })
    })

    describe('signRemote', () => {
        let dir
        let file

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winsign-'))
            file = path.join(dir, 'Update.exe')
            fs.writeFileSync(file, 'MZ-unsigned')
        })

        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true })
        })

        test('replaces the file with what the signer returns', async () => {
            const { spawnFn, calls } = fakeSpawn()

            await signRemote(file, { env, spawnFn })

            expect(fs.readFileSync(file, 'utf8')).toBe('SIGNED:MZ-unsigned')
            expect(fs.existsSync(`${file}.signed`)).toBe(false)
            expect(calls[0].cmd).toBe('ssh')
        })

        test('keeps the original and reports the signer message when the signer fails', async () => {
            const { spawnFn } = fakeSpawn({ code: 3, reply: () => Buffer.alloc(0), stderr: 'no signing session is open' })

            await expect(signRemote(file, { env, spawnFn })).rejects.toThrow(/exit 3.*no signing session is open/)

            expect(fs.readFileSync(file, 'utf8')).toBe('MZ-unsigned')
            expect(fs.existsSync(`${file}.signed`)).toBe(false)
        })

        test('keeps the original when the signer returns nothing', async () => {
            const { spawnFn } = fakeSpawn({ reply: () => Buffer.alloc(0) })

            await expect(signRemote(file, { env, spawnFn })).rejects.toThrow(/empty file/)

            expect(fs.readFileSync(file, 'utf8')).toBe('MZ-unsigned')
        })

        test('fails when ssh cannot be started', async () => {
            const spawnFn = () => {
                const child = new EventEmitter()
                child.stdin = new PassThrough()
                child.stdout = new PassThrough()
                child.stderr = new PassThrough()
                setImmediate(() => child.emit('error', new Error('ENOENT')))
                return child
            }

            await expect(signRemote(file, { env, spawnFn })).rejects.toThrow(/could not start ssh: ENOENT/)

            expect(fs.readFileSync(file, 'utf8')).toBe('MZ-unsigned')
        })
    })
})
