const FFMpegSupport = require('./ffmpeg')

const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=0',
    'content-disposition': 'attachment; filename="ffmpeg"',
    'content-length': '76597656',
    'content-type': 'application/octet-stream',
    date: 'Tue, 12 Oct 2021 08:50:08 GMT',
    etag: 'W/"490c998-17c464e6d51"',
    'last-modified': 'Sun, 03 Oct 2021 13:18:37 GMT',
    vary: 'Accept-Encoding',
    'x-powered-by': 'Express',
    connection: 'close'
}


describe ('ffmpeg',()=> {

    describe ('getName', () => {
        
        test( 'success',()=> {
            const ffmpeg = FFMpegSupport.getInstance()
            const name = ffmpeg.getName(headers);
            expect(name).toBe('ffmpeg')
        })
        
        test( 'content-disposition header missing -> returns undefined',()=> {
            const ffmpeg = FFMpegSupport.getInstance()
            const name = ffmpeg.getName({});
            expect(name).toBeUndefined();
        })
        test( 'header undefined -> returns undefined',()=> {
            const ffmpeg = FFMpegSupport.getInstance()
            const name = ffmpeg.getName();
            expect(name).toBeUndefined();
        })

    })
}) 