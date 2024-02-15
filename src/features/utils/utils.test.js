const {getFileInfo,isTrue} = require("./index.js");
const os = require('os')

if (!process.env.DEBUG)
    console.log = jest.fn();

describe('Features:utils',() => {

    describe('isTrue',()=> {

        test('positive',()=>{
            expect( isTrue(true) ).toBe(true);
            expect( isTrue(1) ).toBe(true);
            expect( isTrue("1") ).toBe(true);
            expect( isTrue("true") ).toBe(true);

        })
        test('negative',()=>{
            expect( isTrue(false) ).toBe(false);
            expect( isTrue(0) ).toBe(false);
            expect( isTrue("0") ).toBe(false);
            expect( isTrue("false") ).toBe(false);

        })

    })

    describe('getFileInfo',()=>{


        test('windows url',()=>{
            if ( os.platform()!=='win32') 
                return;
            const url = 'incyclist:///C:\\Users\\Guido\\AppData\\Roaming\\incyclist\\screenshots\\screenshot-20210920213115.jpg'
            const res = getFileInfo( url,'incyclist')
            expect(res).toMatchObject( {
                name:'screenshot-20210920213115.jpg',
                ext:'jpg',
                filename: 'C:\\Users\\Guido\\AppData\\Roaming\\incyclist\\screenshots\\screenshot-20210920213115.jpg',
                outFile: 'C:\\Users\\Guido\\AppData\\Roaming\\incyclist\\screenshots\\screenshot-20210920213115.jpg'
            })
        })

        test('encoded web url',()=>{
            const url = 'https://w3schools.com/test%25.jpg'
            const res = getFileInfo( url,'http')
            expect(res).toMatchObject( {
                name:'test%.jpg',
            })
        })

    })
})
