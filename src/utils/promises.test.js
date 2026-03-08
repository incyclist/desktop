const NamedPromise  = require("./promises")
const {sleep} = require('../utils/sleep')
describe ('promises',()=>{
    describe('exec',()=>{

        test('no timeout',async ()=>{
            const promise = new Promise (done=>{done(10)})
            NamedPromise.add('test', promise)

            const res = await NamedPromise.exec('test')
            expect(res).toBe(10)
        })

        test('with timeout',async ()=>{
            jest.useFakeTimers()
            NamedPromise.add('test', sleep(1000))

            const promise = NamedPromise.exec('test',30)
            
            jest.advanceTimersByTime(30)
            
            await expect(promise).rejects.toThrow('timeout')
            
            jest.useRealTimers()
        })
    })
})