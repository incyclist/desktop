const FFMpegSupport = require('./ffmpeg')
let Utils= require( '../../utils')
const f = FFMpegSupport.getInstance();
jest.setTimeout(10000)
describe ('ffmpeg',()=> {

    test ('download', async () => {
        
        const success = await f.download(123)
        expect(success).toBeTruthy()
        expect(f.updateBusy).toBeFalsy()
    }, 30000)
}) 