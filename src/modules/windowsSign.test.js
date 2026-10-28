const { shouldSign, getMissingEnv, buildArgs, getToolDir } = require('./windowsSign')

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
        const env = {
            CODE_SIGN_TOOL_JAR: 'tool.jar',
            SSL_COM_USERNAME: 'user',
            SSL_COM_PASSWORD: 'pw',
            SSL_COM_CREDENTIAL_ID: 'cred',
            SSL_COM_TOTP_SECRET: 'totp'
        }

        test('returns nothing when all variables are set', () => {
            expect(getMissingEnv(env)).toEqual([])
        })

        test('lists empty and absent variables', () => {
            expect(getMissingEnv({ ...env, SSL_COM_PASSWORD: '', SSL_COM_TOTP_SECRET: undefined }))
                .toEqual(['SSL_COM_PASSWORD', 'SSL_COM_TOTP_SECRET'])
        })
    })

    describe('buildArgs', () => {
        test('passes credentials and the file to CodeSignTool, overriding in place', () => {
            const args = buildArgs('C:\\tmp\\Setup.exe', {
                CODE_SIGN_TOOL_JAR: 'C:\\cst\\code_sign_tool.jar',
                SSL_COM_USERNAME: 'user',
                SSL_COM_PASSWORD: 'pw',
                SSL_COM_CREDENTIAL_ID: 'cred',
                SSL_COM_TOTP_SECRET: 'totp'
            })

            expect(args).toEqual([
                '-jar', 'C:\\cst\\code_sign_tool.jar',
                'sign',
                '-username=user',
                '-password=pw',
                '-credential_id=cred',
                '-totp_secret=totp',
                '-input_file_path=C:\\tmp\\Setup.exe',
                '-override'
            ])
        })
    })

    describe('getToolDir', () => {
        test('is the parent of the directory holding the jar', () => {
            expect(getToolDir({ CODE_SIGN_TOOL_JAR: 'D:\\a\\_temp\\codesigntool\\jar\\code_sign_tool-1.3.2.jar' }))
                .toBe('D:\\a\\_temp\\codesigntool')
        })
    })
})
