const {getNiceValue} = require('./VideoScheme')
const VideoScheme = require('./VideoScheme')
const Support = require('./ffmpeg')
const fs = require('fs')
const os = require('os')
const path = require('path')

describe ( 'VideoScheme', ()=>{

    describe ('constructor',()=>{
        let ffmpeg,org

        beforeEach( ()=> {
            ffmpeg = Support.getInstance();
            org = ffmpeg.init
            ffmpeg.init = jest.fn();
        })
        afterEach( ()=> {
            ffmpeg.init = org;
            
        })
        test('ffmpegInit() is called',()=> {
            const vs = new VideoScheme();
            expect(vs).toBeDefined()
            expect(ffmpeg.init).toHaveBeenCalled()
        })
    })

    describe ( '#getNiceValue()', ()=>{
        test( 'default', ()=>{
            expect(getNiceValue()).toBe(0)
            
        })
        test( '100%', ()=>{
            expect(getNiceValue(100)).toBe(-20)
        })
        test( '0%', ()=>{
            expect(getNiceValue(0)).toBe(20)
        })

        test( '200%', ()=>{
            expect(getNiceValue(200)).toBe(-20)
        })
        test( '-100%', ()=>{
            expect(getNiceValue(-100)).toBe(20)
        })

    })

    describe( 'screenshot',()=>{

        let v;

        beforeAll( ()=>{
            v = new VideoScheme()
        })

        afterEach( ()=>{
            try { fs.unlinkSync('testdata/sample_preview.png')} catch {}
            try { fs.unlinkSync( path.join(os.tmpdir(),'sample_preview.png'))} catch {}
            try { fs.unlinkSync( path.join(os.tmpdir(),'ES_MenorcaDemo_preview.png'))} catch {}
        })

        test('valid file',async ()=>{
            const res = await v.screenshot('file:///testdata/sample.avi')
            expect(res).toBe('file:///testdata/sample_preview.png')
        })

        test('valid URL',async ()=>{
            const res = await v.screenshot('https://www.reallifevideo.eu/stream/ES_MenorcaDemo.mp4')
            expect(res).toBe('file:///'+path.join(os.tmpdir(),'ES_MenorcaDemo_preview.png'))
        })


        test('outDir',async ()=>{
            const outDir = os.tmpdir()
            const res = await v.screenshot('file:///testdata/sample.avi', {outDir})
            
        })
        test('size',async ()=>{
            const outDir = os.tmpdir()
            const res = await v.screenshot('file:///testdata/sample.avi', {size:'384x216'})
            
        })

        test('invalid file',async ()=>{
            await expect(async ()=> {await v.screenshot('file:///testdata/success.zip')}).rejects.toThrow('Invalid data found when processing input')
            
        })

        test('file does not exit',async ()=>{
            await expect(async ()=> {await v.screenshot('file:///testdata/notexisting.mp4')}).rejects.toThrow('No such file or directory')
            
        })


    })

    describe('convert',()=>{

        afterEach( ()=>{
            try { fs.unlinkSync( path.join(os.tmpdir(),'sample.mp4'))} catch {}
            try { fs.unlinkSync( path.join(os.tmpdir(),'Aigen.mp4'))} catch {}
            try { fs.unlinkSync( path.join(os.tmpdir(),'Gaming-Lunz.mp4'))} catch {}
        })

        test('valid file',async ()=>{
            const v = new VideoScheme()
            const outDir = os.tmpdir()

            const res = await new Promise( (done,reject)=> {
                v.convertToFile('file:///testdata/sample.avi',{outDir})
                    .on('conversion.progress',info=>{console.log(info)})
                    .once('conversion.done',done)
                    .once('conversion.error',reject)
            })
            expect(res).toBe('file:///'+path.join(outDir,'sample.mp4'))
        })

        // only used for manual tests
        test.skip('large file',async ()=>{
            const v = new VideoScheme()
            const outDir = os.tmpdir()

            const res = await new Promise( (done,reject)=> {
                v.convertToFile('file:////tmp/Aigen.avi',{outDir})
                    .on('conversion.progress',info=>{console.log(info)})
                    .once('conversion.done',done)
                    .once('conversion.error',reject)
            })

            expect(res).toBe('file:///'+path.join(outDir,'Aigen.mp4'))
        },30000)

        // only used for manual tests
        test.skip('large slow file',async ()=>{
            const v = new VideoScheme()
            const outDir = os.tmpdir()

            const res = await new Promise( (done,reject)=> {
                v.convertToFile('file:////mnt/nas/data/videos/tacx/AT_Gaming-Lunz/Gaming-Lunz.avi',{outDir})
                    .on('conversion.progress',info=>{console.log(info)})
                    .once('conversion.done',done)
                    .once('conversion.error',reject)
            })

            expect(res).toBe('file:///'+path.join(outDir,'Gaming-Lunz.mp4'))
        },300000)


        

    })

    describe('getCodec',()=>{
        test('file AVI',async ()=>{
            const v = new VideoScheme()
            const res = await v.getCodec('file:///testdata/sample.avi')
            expect(res).toBe('h264')
        })
        test('URL AVI',async ()=>{
            const v = new VideoScheme()
            const res = await v.getCodec('https://www.engr.colostate.edu/me/facil/dynamics/files/drop.avi')
            expect(res).toBe('indeo4')
        },10000)

        test('file MP4',async ()=>{
            const v = new VideoScheme()
            const res = await v.getCodec('file:///testdata/sample.mp4')
            expect(res).toBe('h264')
        })

        test('URL MP4',async ()=>{
            const v = new VideoScheme()
            const res = await v.getCodec('https://videos.incyclist.com/DE_Arnbach.mp4')
            expect(res).toBe('h264')
        })
                

    })

})