const { sleep } = require("incyclist-devices/lib/utils/utils")
const NamedPromise  = require("./promises")

describe ('promises',()=>{
    describe('exec',()=>{

        test('no timeout',async ()=>{
            const promise = new Promise (done=>{done(10)})
            NamedPromise.add('test', promise)

            const res = await NamedPromise.exec('test')
            expect(res).toBe(10)
            
            
        })

        test('with timeout',async ()=>{
            NamedPromise.add('test', sleep(1000))

            const tsStart = Date.now()
            await expect( async ()=>{ await NamedPromise.exec('test',30) }).rejects.toThrow('timeout')
            
        })
    })
})