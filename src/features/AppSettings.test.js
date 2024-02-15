const AppSettings = require('./AppSettings')
const {getValue,setValue} = require('./AppSettings')

const TEST_DATA = {
    "store": {
        "book": [ 
          {
            "category": "reference",
            "author": "Nigel Rees",
            "title": "Sayings of the Century",
            "price": 8.95
          }, {
            "category": "fiction",
            "author": "Evelyn Waugh",
            "title": "Sword of Honour",
            "price": 12.99
          }, {
            "category": "fiction",
            "author": "Herman Melville",
            "title": "Moby Dick",
            "isbn": "0-553-21311-3",
            "price": 8.99
          }, {
             "category": "fiction",
            "author": "J. R. R. Tolkien",
            "title": "The Lord of the Rings",
            "isbn": "0-395-19395-8",
            "price": 22.99
          }
        ],
        "bicycle": {
          "color": "red",
          "price": 19.95
        }
      }
}


describe('AppSettings',()=> {

    describe('constructor',()=> {
        let fn;
        let env = JSON.parse(JSON.stringify(process.env))
        beforeAll( ()=> {
            fn = AppSettings.prototype.loadSettings;
        })

        beforeEach( ()=> {
            AppSettings.prototype.loadSettings = jest.fn();
            process.env = JSON.parse(JSON.stringify(env));
        })

        afterAll( ()=> {
            AppSettings.prototype.loadSettings = fn;
        })

        test('no arguments', ()=> {
            const s = new AppSettings();
            expect(s.logger).toBeDefined();
            expect(s.queue).toMatchObject([])
            expect(s.state).toMatchObject( {saveJSONBusy: false,dirty: false})
            expect(s.loadSettings).toHaveBeenCalled()
            expect(s.environment).toBe('prod')
        } )

        test('props.environment is set',()=> {
            process.env.ENVIRONMENT = 'beta'
            const s = new AppSettings({environment:'alpha'});
            expect(s.environment).toBe('alpha')
        }) 
        test('props.environment is not set, env variable ENVIRONMENRT is set',()=> {
            process.env.ENVIRONMENT = 'beta'
            const s = new AppSettings();
            expect(s.environment).toBe('beta')
        }) 

    })
    describe ('getValue',()=>{

        test('child of array',()=>{
            expect(getValue(TEST_DATA,'store.book.0.author')).toEqual('Nigel Rees')
        })

        test('top level',()=>{
            expect(getValue(TEST_DATA,'store')).toMatchObject( TEST_DATA.store)

        })
        test('first level',()=>{
            expect(getValue(TEST_DATA,'store.bicycle')).toMatchObject({color:'red',price:19.95})

        })

        test('not found',()=>{
            expect(getValue(TEST_DATA,'store.cars')).toBeUndefined()

        })

        test('not found with default',()=>{
            expect(getValue(TEST_DATA,'store.cars',{x:1})).toMatchObject({x:1})

        })

        test('getValue() returns cloned object',()=> {
            const settings = JSON.parse(JSON.stringify(TEST_DATA));
            const value = getValue(settings,'store.book.0')
            value.author = 'John Doe'
            expect(settings.store.book[0].author).toEqual('Nigel Rees')
        })

    })

    describe ('setValue',()=>{

        test('child of array',()=>{
            const settings = JSON.parse(JSON.stringify(TEST_DATA));
            const res = setValue(settings,'store.book.0.author','John Doe')
            expect(res).toEqual('John Doe')
            expect(settings.store.book[0].author).toEqual('John Doe')
            
        })

        test('first level',()=>{
            const settings = JSON.parse(JSON.stringify(TEST_DATA));
            const res = setValue(settings,'store','John Doe')
            expect(res).toEqual('John Doe')
            expect(settings.store).toEqual('John Doe')
        })

        test('empty key',()=>{
            const settings = JSON.parse(JSON.stringify(TEST_DATA));
            expect (()=>setValue(settings,'','John Doe')).toThrow()
        })

        test('undefined key',()=>{
            const settings = JSON.parse(JSON.stringify(TEST_DATA));
            expect (()=>setValue(settings,undefined,'John Doe')).toThrow()
        })

        test(' key not found',()=>{
            const settings = JSON.parse(JSON.stringify(TEST_DATA));
            const res = setValue(settings,'store.cars','John Doe')
            expect(res).toEqual('John Doe')
            expect(settings.store.cars).toEqual('John Doe')
            
        })

        test(' parent key not found',()=>{
            const settings = JSON.parse(JSON.stringify(TEST_DATA));
            const res = setValue(settings,'dealer.cars',{owner:'John Doe'})
            expect(res).toMatchObject({owner:'John Doe'})
            expect(settings.dealer.cars.owner).toEqual('John Doe')
            
        })


        test(' child key not found',()=>{
            const settings = JSON.parse(JSON.stringify(TEST_DATA));
            const res = setValue(settings,'store.motorbike.harley.owner','John Doe')
            expect(res).toEqual('John Doe')
            expect(settings.store.motorbike.harley.owner).toEqual('John Doe')
            
        })

    })

    describe( 'fileSync',()=>{

        let s;
        let fn;

        beforeAll( ()=> {
            fn = AppSettings.prototype.loadSettings;
        })

        afterAll( ()=> {
            AppSettings.prototype.loadSettings = fn;
        })

        beforeEach( ()=> {
            AppSettings.prototype.loadSettings = jest.fn();
            s = new AppSettings();
            s.getSettingsFileName = jest.fn( ()=>'test.json')
        })

        test('succes',async ()=> {
            s.state.dirty = true;
            s.settings = {}
            s.saveJSON = jest.fn( ()=>true)

            await s.fileSync();
            expect( s.saveJSON).toHaveBeenCalled();
            expect( s.state.dirty).toBeFalsy();
        })

        test('saveJSON resolves with false -> remains dirty',async ()=> {
            s.state.dirty = true;
            s.settings = {}
            s.saveJSON = jest.fn( ()=>false)

            await s.fileSync();
            expect( s.saveJSON).toHaveBeenCalled();
            expect( s.state.dirty).toBeTruthy();
            
        })

        test('error in saveJSON -> remains dirty',async ()=> {
            s.state.dirty = true;
            s.settings = {}
            s.saveJSON = jest.fn( ()=>Promise.reject('error'))

            await s.fileSync();
            expect( s.saveJSON).toHaveBeenCalled();
            expect( s.state.dirty).toBeTruthy();
            
        })

        test('not dirty -> saveJson not called',async ()=> {
            s.state.dirty = false;
            s.settings = {}
            s.saveJSON = jest.fn( ()=>true)

            await s.fileSync();
            expect( s.saveJSON).not.toHaveBeenCalled();
            expect( s.state.dirty).toBeFalsy();
            
        })

        test('settings not set -> saveJson not set, remains dirty',async ()=> {
            s.state.dirty = true;
            s.settings = undefined
            s.saveJSON = jest.fn( ()=>true)
            
            await s.fileSync();
            expect( s.saveJSON).not.toHaveBeenCalled();
            expect( s.state.dirty).toBeTruthy();
        })

    })

    describe('getUuidFromFile',()=>{

        test( 'file contains a uuid',()=>{
            const s = new AppSettings();
            s.fs = {
                existsSync: jest.fn( ()=> true),
                readFileSync: jest.fn( ()=> '1234')
            }

            const res = s.getUuidFromFile();
            expect(res).toBe('1234')
        })

        test( 'file does not exist',()=>{
            const s = new AppSettings();
            s.fs = {
                existsSync: jest.fn( ()=> false),
                readFileSync: jest.fn( ()=> '1234')
            }

            const res = s.getUuidFromFile();
            expect(res).toBeUndefined()
        })

        test( 'file is empty',()=>{
            const s = new AppSettings();
            s.fs = {
                existsSync: jest.fn( ()=> true),
                readFileSync: jest.fn( ()=> '')
            }

            const res = s.getUuidFromFile();
            expect(res).toBeUndefined()
        })

        test( 'error while reading',()=>{
            const s = new AppSettings();
            s.fs = {
                existsSync: jest.fn( ()=> true),
                readFileSync: jest.fn( ()=> {throw new Error('test')})
            }

            const res = s.getUuidFromFile();
            expect(res).toBeUndefined()
        })

    })

})