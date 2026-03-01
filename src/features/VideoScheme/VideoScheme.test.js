const {getNiceValue} = require('./VideoScheme')
const VideoScheme = require('./VideoScheme')
const Support = require('./ffmpeg')
const os = require('os')
const path = require('path')

jest.mock('fluent-ffmpeg');
const ffmpegMock = require('fluent-ffmpeg');

describe ( 'VideoScheme', ()=>{

    describe ('constructor',()=>{
        let ffmpeg,org

        beforeEach( ()=> {
            ffmpeg = Support.getInstance();
            org = ffmpeg.init
            ffmpeg.init = jest.fn();
            ffmpeg.ready = jest.fn()
        })
        afterEach( ()=> {
            ffmpeg.init = org;
            
        })
        test('creates instance with logger and empty proc/progress/segments', () => {
            const vs = new VideoScheme();
            expect(vs.proc).toEqual({});
            expect(vs.progress).toEqual({});
            expect(vs.segments).toEqual({});
        });

        test('initFFMeg() sets ffmpegSupport', () => {
            const vs = new VideoScheme();
            vs.initFFMeg();
            expect(vs.ffmpegSupport).toBeDefined();
            expect(ffmpeg.init).toHaveBeenCalled();
        });
    })

    describe('#getNiceValue()', () => {
        let v;
        beforeAll(() => { v = new VideoScheme(); });

        test('default', () => { expect(v.getNiceValue()).toBe(0) });
        test('100%',    () => { expect(v.getNiceValue(100)).toBe(-20) });
        test('0%',      () => { expect(v.getNiceValue(0)).toBe(20) });
        test('200% clamps to 100%', () => { expect(v.getNiceValue(200)).toBe(-20) });
        test('-100% clamps to 0%', () => { expect(v.getNiceValue(-100)).toBe(20) });
    });

    describe('screenshot', () => {        
        let v, cmdMock;

        const sleep = async(ms)=> new Promise( done=>setTimeout(done,ms))

        beforeEach(() => {
            // Build a chainable fluent-ffmpeg mock
            cmdMock = {
                addOutputOptions: jest.fn().mockReturnThis(),
                addOption: jest.fn().mockReturnThis(),
                output: jest.fn().mockReturnThis(),
                on: jest.fn().mockReturnThis(),
                run: jest.fn(),
                
            };
            // Capture 'end' and 'error' callbacks so we can trigger them
            cmdMock.on.mockImplementation((event, cb) => {
                cmdMock._handlers = cmdMock._handlers || {};
                cmdMock._handlers[event] = cb;
                return cmdMock;
            });

            ffmpegMock.mockReturnValue(cmdMock);

            v = new VideoScheme();
            v.ffmpegSupport = { ready: jest.fn().mockResolvedValue(true) };
        });

        test('valid file:// URL resolves with preview path', async () => {
            const promise = v.screenshot('file:///testdata/sample.avi');

            await sleep(0)
            cmdMock._handlers['end'](); // simulate ffmpeg success
            const res = await promise;
            expect(res).toBe('file:///testdata/sample_preview.png');
        });

        test('http URL uses tmpdir as output folder', async () => {
            const promise = v.screenshot('https://example.com/ES_MenorcaDemo.mp4');
            await sleep(0)

            cmdMock._handlers['end']();
            const res = await promise;
            expect(res).toBe('file:///' + path.join(os.tmpdir(), 'ES_MenorcaDemo_preview.png'));
        });

        test('outDir option overrides output folder', async () => {
            const outDir = os.tmpdir();
            const promise = v.screenshot('file:///testdata/sample.avi', { outDir });
            await sleep(0)

            cmdMock._handlers['end']();
            const res = await promise;
            expect(res).toBe('file:///' + path.join(outDir, 'sample_preview.png'));
        });

        test('ffmpeg error rejects with parsed message', async () => {
            const promise = v.screenshot('file:///testdata/sample.avi');
            await sleep(0)

            cmdMock._handlers['error'](new Error('pipe:0: No such file or directory'));
            await expect(promise).rejects.toThrow('No such file or directory');
        });

        test('invalid data error rejects with correct message', async () => {
            const promise = v.screenshot('file:///testdata/success.zip');
            await sleep(0)

            cmdMock._handlers['error'](new Error('something: Invalid data found when processing input'));
            await expect(promise).rejects.toThrow('Invalid data found when processing input');
        });
    });
    describe('convertToFile', () => {
        let v;

        beforeEach(() => {
            v = new VideoScheme();
            v.ffmpegSupport = { ready: jest.fn().mockResolvedValue(true) };
        });

        test('h264 file uses convertFast path', async () => {
            v.getCodec = jest.fn().mockResolvedValue('h264');
            v.convertFast = jest.fn();
            v.convertSlow = jest.fn();

            const emitter = v.convertToFile('file:///testdata/sample.avi', { outDir: os.tmpdir() });
            // Let the internal convert() promise settle
            await new Promise(r => setImmediate(r));

            expect(v.convertFast).toHaveBeenCalled();
            expect(v.convertSlow).not.toHaveBeenCalled();
        });

        test('non-h264 file uses convertSlow path', async () => {
            v.getCodec = jest.fn().mockResolvedValue('mpeg4');
            v.convertFast = jest.fn();
            v.convertSlow = jest.fn();

            v.convertToFile('file:///testdata/sample.avi', { outDir: os.tmpdir() });
            await new Promise(r => setImmediate(r));

            expect(v.convertSlow).toHaveBeenCalled();
        });

        test('enforceSlow skips getCodec and uses convertSlow', async () => {
            v.getCodec = jest.fn();
            v.convertSlow = jest.fn();

            v.convertToFile('file:///testdata/sample.avi', { enforceSlow: true });
            await new Promise(r => setImmediate(r));

            expect(v.getCodec).not.toHaveBeenCalled();
            expect(v.convertSlow).toHaveBeenCalled();
        });

        test('emitter fires conversion.done on success', async () => {
            v.getCodec = jest.fn().mockResolvedValue('h264');
            v.convertFast = jest.fn().mockImplementation((emitter) => {
                setImmediate(() => emitter.emit('conversion.done', 'file:///tmp/sample.mp4'));
            });

            const result = await new Promise((resolve, reject) => {
                v.convertToFile('file:///testdata/sample.avi', { outDir: os.tmpdir() })
                    .once('conversion.done', resolve)
                    .once('conversion.error', reject);
            });

            expect(result).toBe('file:///tmp/sample.mp4');
        });
    });
    describe('getCodec',()=>{
        let v, cmdMock;

        beforeEach(() => {
            cmdMock = {
                on: jest.fn().mockReturnThis(),
                native: jest.fn().mockReturnThis(),
                duration: jest.fn().mockReturnThis(),
                noAudio: jest.fn().mockReturnThis(),
                videoCodec: jest.fn().mockReturnThis(),
                format: jest.fn().mockReturnThis(),
                pipe: jest.fn().mockReturnValue({ on: jest.fn() }),
            };
            cmdMock.on.mockImplementation((event, cb) => {
                cmdMock._handlers = cmdMock._handlers || {};
                cmdMock._handlers[event] = cb;
                return cmdMock;
            });
            ffmpegMock.mockReturnValue(cmdMock);

            v = new VideoScheme();
            v.ffmpegSupport = { ready: jest.fn().mockResolvedValue(true) };
            // mock run() to resolve immediately
            v.run = jest.fn().mockResolvedValue({});
        });
        test('file AVI',async ()=>{
            v.run.mockImplementationOnce(async (cmd) => {
                cmd._handlers['codecData']({ video: 'h264 (High)' });
            });
            const res = await v.getCodec('file:///testdata/sample.avi')
            expect(res).toBe('h264')
        })
        test('URL AVI',async ()=>{
            v.run.mockImplementationOnce(async (cmd) => {
                cmd._handlers['codecData']({ video: 'h264 (High)' });
            });
            const res = await v.getCodec('https://www.engr.colostate.edu/me/facil/dynamics/files/drop.avi')
            expect(res).toBe('h264')
        })
                

    })

})