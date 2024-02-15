const {getAppDirectory} = require('./index')
const path = require('path')

describe ('utils',()=> {

    test( 'getAppDirectory',()=> {
        // Note the electron mock will always return 'test/out' in getPath()
        
        const appDir = getAppDirectory();
        expect(appDir).toBe( `test${path.sep}out${path.sep}Incyclist`)
    })
})