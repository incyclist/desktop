const { ipcRenderer,ipcMain } = require("electron")
const NetworkFeature = require("./NetworkFeature")

jest.mock('../utils', ()=> {
    return {
        ipcServe: jest.fn( (event,callId,key,fn) => {
            fn() 
        } ),
        ipcCall: jest.fn(),
        ipcResponse: jest.fn()
    }
})
const utils = require('../utils')

jest.mock('./Network')
const {scan} = require('./Network',)
const { ipcCall, ipcResponse } = require("../utils")

describe ('NetworkFeature',()=> {

    describe ('constructor',()=>{
        test( '',()=>{
            const f = new NetworkFeature();
            expect ( f.logger).toBeDefined();
    
        })
    })

    describe ('getInstance',()=>{

        beforeEach( ()=> {
            NetworkFeature._instance = undefined;
        })

        test ('1st call -> creates new Object', ()=>{
            const f = NetworkFeature.getInstance();
            expect(f).toBeDefined();
        })

        test ('1st call -> overwrites object manually created via constructor ', ()=>{
            const f1 = new NetworkFeature()
            const f2 = NetworkFeature.getInstance();
            expect(f1).not.toBe(f2)
        })

        test ('2nd call -> returns previously created object ', ()=>{
            const f1 = NetworkFeature.getInstance();
            const f2 = NetworkFeature.getInstance();
            expect(f1).toBe(f2)
        })

    })

    describe('register',()=>{
        const original = { on:ipcMain.on, emit:ipcMain.emit }
        beforeEach( ()=>{
            ipcMain.on = jest.fn( (event,callback)=> {
                callback()
            }) 
        })

        afterEach( ()=>{
            ipcMain.on = original.on;
        })

        test('register',()=>{
            const res = NetworkFeature.getInstance().register( )
            expect(res).toBeUndefined();  // does not return anything
            expect(ipcMain.on).toHaveBeenCalledWith('network-scan',expect.anything() )  // has registered ipc-call 'network-scan'
            expect(utils.ipcServe).toHaveBeenCalled()            

        })

    })

    describe('registerRenderer',()=>{
        test('success',()=>{
            const api = { registerFeatures:jest.fn()}
            const res = NetworkFeature.getInstance().registerRenderer( api, ipcRenderer )

            expect(res).toBeUndefined();  // does not return anything
            expect(utils.ipcCall).toHaveBeenCalledWith('network-scan',expect.anything())    // has registered ipc-call 'network-scan'
            expect(api.registerFeatures).toHaveBeenCalledWith(['network.scan']) ;           // has added 'network.scan' to  features array

        })
        test('spec does not have registerFeatures function -> will throw an error',()=>{
            const api = {}
            expect( ()=> {
                const res = NetworkFeature.getInstance().registerRenderer( api, ipcRenderer )
            }).toThrow()            
        })
    })


    describe('scan',()=>{
        const original = { on:ipcMain.on, emit:ipcMain.emit }
        beforeEach( ()=>{
            let _callbacks = []
            ipcMain.on = jest.fn( (key,callback)=> {
                _callbacks[key] = callback
            }) 
            ipcMain.emit = jest.fn( (key,callId,...args) => {
                const fn = _callbacks[key];
                fn({},callId,...args)
            })

        })

        afterEach( ()=>{
            ipcMain.on = original.on;
            ipcMain.emit = original.emit

        })

        test('call',()=>{
  
            NetworkFeature.getInstance().register( )
            ipcMain.emit( 'network-scan','123',4711)
            expect(scan).toHaveBeenCalledWith(4711)            

        })

    })

})