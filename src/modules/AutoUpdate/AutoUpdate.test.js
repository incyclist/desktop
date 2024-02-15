const AutoUpdate = require ('.' )
const axios = require('axios')
const UpdaterFactory = require('./binding/factory')
const EventEmitter = require('events')

const mockExtract = jest.fn( ()=> Promise.resolve({success:true}))
const UpdatehandlerBase = require('./binding/base')
jest.mock('../zip',()=>{
    return {
        ZipData: jest.fn( ()=> ({
            extract: mockExtract
        }))
    }
})


describe( 'AutoUpdate',()=> {

    describe('performWebUpdateCheck',()=>{

        let a;
        let version = '1.0';

        beforeEach( ()=>{
            jest.mock('axios')
            const app = {
                settings:{},
                getName: ()=>'Incyclist',
                getVersion: ()=>version,
                verifyDirectory: jest.fn(),
                getAppDirectory: jest.fn(()=>'./test/out') 
            }
            a = new AutoUpdate(app);

        })
        afterEach( ()=>{
            jest.unmock('axios')

        })

        test('success',async ()=>{
            const data = { 
                appVersion: "0.9.4", reactVersion: "0.6", size: 4349536,
                setting: {
                  logRest: { sendInterval: 10}
                }
              }
            axios.get = jest.fn( ()=> Promise.resolve({data}))
            const res = await a.performWebUpdateCheck()
            expect(res.available).toBe(true)
            expect(res.data).toBe(data)
            expect(res.promise).toBeUndefined()

        })

        test('error',async ()=>{
            axios.get = jest.fn( ()=> Promise.reject( new Error('some error')))
            const res = await a.performWebUpdateCheck()
            expect(res.available).toBe(false)
            expect(res.data).toBeUndefined()
            expect(res.promise).toBeUndefined()
            
        })

        test('timeout',async ()=>{
            a.getWebTimeout = jest.fn().mockReturnValue(10)
            const data = { 
                appVersion: "0.9.4", reactVersion: "0.6", size: 4349536,
                setting: {
                  logRest: { sendInterval: 10}
                }
              }

            axios.get = jest.fn( async ()=> { 
                await new Promise ( done=> setTimeout(done,100))
                return Promise.resolve({data})
            })
            const res = await a.performWebUpdateCheck()
            expect(res.available).toBeUndefined()
            expect(res.timeout).toBe(true)
            expect(res.data).toBeUndefined()
            expect(res.promise).toBeDefined()

            const res1 = await res.promise
            expect(res1.available).toBe(true)
            expect(res1.data).toBe(data)
            expect(res1.promise).toBeUndefined()

            
        })

    })


    describe('performAppUpdateCheck',()=>{

        let a;
        let version = '1.0';
        let original;

        class MockUpdater extends EventEmitter {

            

        }
        const mock = new MockUpdater() 

        beforeEach( ()=>{            
            original = UpdaterFactory.getBinding
            UpdaterFactory.getBinding = jest.fn( (server,url) => {
                const updater = new UpdatehandlerBase()
                updater.autoUpdater = mock
                
                return updater
            })
            const app = {
                settings:{},
                getName: ()=>'Incyclist',
                getVersion: ()=>version,
                verifyDirectory: jest.fn(),
                getAppDirectory: jest.fn(()=>'./test/out') 
            }

            a = new AutoUpdate(app);

        })
        afterEach( ()=>{
            UpdaterFactory.getBinding = original

        })

        test('success',async ()=>{
            mock.checkForUpdates=jest.fn( ()=> { 
                mock.emit('checking-for-update') 
                mock.emit('update-available') 
                return new Promise (done=>{})
            })          

            
            const res = await a.performAppUpdateCheck()
            expect(res.available).toBe(true)
            expect(res.promise).toBeUndefined()
        })

        test('no updates',async ()=>{
            mock.checkForUpdates=jest.fn( ()=> { 
                mock.emit('checking-for-update') 
                mock.emit('update-not-available') 
                return new Promise (done=>{})
            })          

            
            const res = await a.performAppUpdateCheck()
            expect(res.available).toBe(false)
            expect(res.promise).toBeUndefined()
        })

        test('timeout',async ()=>{
            mock.checkForUpdates=jest.fn( ()=> { 
                setTimeout( ()=>{
                    mock.emit('checking-for-update') 
                    mock.emit('update-available') 
                },10000)
                return new Promise (done=>{})
            })          

            a.getAppTimeout = jest.fn().mockReturnValue(10)
            

            
            const res = await a.performAppUpdateCheck()
            expect(res.available).toBe(undefined)
            expect(res.timeout).toBe(true)
            expect(res.promise).toBeDefined()
        })

        test('autoupdate disabled',async ()=>{
            mock.checkForUpdates=jest.fn( ()=> { 
                return null
            })          

            
            const res = await a.performAppUpdateCheck()
            expect(res.available).toBe(false)
            expect(res.promise).toBeUndefined()
        })

    })

    describe('updateAppForCurrentLaunch',()=>{

        let a;
        let version = '1.0';
        let original;
        
        const mock = new EventEmitter() 

        beforeEach( ()=>{            
            original = UpdaterFactory.getBinding
            UpdaterFactory.getBinding = jest.fn( (server,url) => {
                const updater = new UpdatehandlerBase()
                updater.autoUpdater = mock
                
                return updater
            })
            const app = {
                settings:{},
                getName: ()=>'Incyclist',
                getVersion: ()=>version,
                verifyDirectory: jest.fn(),
                getAppDirectory: jest.fn(()=>'./test/out') 
            }
            a = new AutoUpdate(app);
        })
        afterEach( ()=>{
            UpdaterFactory.getBinding = original
        })

        test('success',async ()=>{
            a.emit = jest.fn()
            mock.quitAndInstall = jest.fn( () => { mock.emit('before-quit-for-update')})

            setTimeout( ()=>{
                mock.emit('update-downloaded')          
            },50)          

            
            a.updateAppForCurrentLaunch()

            const pause = ()=>new Promise(done=>setTimeout(done,100))
            await pause()

            expect(mock.quitAndInstall).toHaveBeenCalled()
            expect(a.emit).toHaveBeenCalledWith('app-relaunch')

            
        })


    })


})