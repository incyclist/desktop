const fs = require('fs')
const path= require('path');
const {ZipData} = require ('./zip');

describe( 'unzip' ,()=> {

    test ( 'positive' ,async () => {
        let data = fs.readFileSync('testdata/success.zip');
        let zip = new ZipData(data);
        let status = await zip.extract(path.join('testdata','./out'));
        expect(status.success).toBe(true);
        expect(status.files.sort()).toMatchSnapshot();

    })

    test ( 'can be called twice' ,async () => {
        let data = fs.readFileSync('testdata/success.zip');
        let zip = new ZipData(data);
        let status1 = await zip.extract(path.join('testdata','./out'));
        expect(status1.success).toBe(true);

        zip = new ZipData(data);
        let status2 = await zip.extract(path.join('testdata','./out'));
        expect(status2.success).toBe(true);
        expect(status2.files.sort()).toEqual(status1.files.sort())

    })

    test ( 'failure' ,async () => {
        let data = fs.readFileSync('testdata/failure.zip',{encoding:null});
        let zip = new ZipData(data);
        let status = await zip.extract(path.join('testdata','./out'));
        expect(status.success).toBe(false);
        
    })

})