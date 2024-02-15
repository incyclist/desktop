const RestLogAdapter = require('./RestLogAdapter')
const axios = require ('axios')
const MockAdapter = require("axios-mock-adapter");

var mock = new MockAdapter(axios);

if (!process.env.DEBUG)
    console.log = jest.fn();

describe('Constructor', () => {

    let original = RestLogAdapter.prototype.startWorker
    let rla;
    beforeEach( ()=> {
        RestLogAdapter.prototype.startWorker = jest.fn( (ms)=>{ return 'fun'} )
    })
    afterEach( ()=> {
        RestLogAdapter.prototype.startWorker = original;
        if (rla && rla.iv)
            clearInterval(rla.iv)

    } )

    test( 'full set of parameters', ()=> {

        let settings = {
            url: 'http://localhost:3000',
            cacheDir: '/tmp',
            sendInterval: 3 // seconds
        }

        rla = new RestLogAdapter(settings);
        expect(rla.url).toMatchSnapshot();
        expect(rla.startWorker).toBeCalledWith(3000)  // ms

    });

    test( 'no parameters', ()=> {
        rla = new RestLogAdapter();
        expect(rla).toMatchSnapshot();
        expect(rla.startWorker).toHaveBeenCalledWith(RestLogAdapter.DEFAULT_SEND_INTERVAL*1000)
    });


})

describe('log', () => {
    let rla;

    let original = RestLogAdapter.prototype.startWorker

    beforeEach( ()=> {
        RestLogAdapter.prototype.startWorker = jest.fn( (ms)=>{ return 'fun'} )
        rla = new RestLogAdapter({url:'http://localhost'});
    })
    afterEach( ()=> {
        RestLogAdapter.prototype.startWorker = original;
        jest.clearAllMocks();
        if (rla && rla.iv)
            clearInterval(rla.iv)
    } )

    test( 'first call', ()=> {
        rla.log('test', {a:1})
        expect(rla.inMemoryCache.length).toBe(1);
        expect(rla.inMemoryCache).toMatchSnapshot();
    });

    test( 'multiple calls', ()=> {
        rla.log('test', {a:1})
        rla.log('test', {a:2})
        rla.log('test', {a:3})
        expect(rla.inMemoryCache.length).toBe(3);
        expect(rla.inMemoryCache).toMatchSnapshot();
    });

    test( 'no parameters', ()=> {
        rla.log()
        expect(rla.inMemoryCache.length).toBe(0);
    });

    test( 'no event', ()=> {
        rla.log('test')
        expect(rla.inMemoryCache.length).toBe(0);
    });

    test( 'exceptinal case: no URL configures', ()=> {
        rla.url = undefined;
        rla.log('test', {a:1})
        rla.log('test', {a:2})
        rla.log('test', {a:3})
        expect(rla.inMemoryCache.length).toBe(0);
    });

    test( 'exceptinal case: inMemoryCache.push throw an error, errors are logged to console', ()=> {
        rla.inMemoryCache.push = jest.fn( ()=>{ throw new Error('test')})
        jest.spyOn( console,'log' );

        rla.log('test', {a:1})
        rla.log('test', {a:2})
        rla.log('test', {a:3})
        expect(rla.inMemoryCache.length).toBe(0);
        expect(console.log).toHaveBeenCalledTimes(3);
    });


})

describe('send', () => {
    let rla;
    let events;

    beforeEach( ()=> {
        events = {mem:[],file:[]};
        rla = new RestLogAdapter({url:'http://localhost',cacheDir:'/tmp',sendInterval:0});
        rla.loadFromMemoryCache = jest.fn( (ev) => { ev.push(...events.mem); this.inMemoryCache=[] } )
        rla.sendBusy = false;
    })

    afterEach( ()=> {
        jest.clearAllMocks()
        mock.reset();
        if (rla && rla.iv)
            clearInterval(rla.iv)
    })

    test ( 'cache populated', async ()=> {
        mock.onPost('http://localhost').replyOnce( 201,{count:3} );
        events = { file:[], mem: [ {context:'test',event:{a:1}},{context:'test',event:{b:2}},{context:'test1',event:{c:3}} ] }
        let res = await rla.send();
        expect(res).toEqual( {processed:3, mem:0, file:0})
        expect( JSON.parse(mock.history.post[0].data)).toEqual({events:events.mem})
        expect( rla.sendBusy).toBeFalsy()
    });

    test ( 'no events', async ()=> {
        mock.onPost('http://localhost').replyOnce( 201,{count:3} );
        events = { file:[], mem: [ ] }
        let res = await rla.send();
        expect(res).toEqual( {processed:0, mem:0, file:0})
        expect( rla.sendBusy).toBeFalsy()

    });

    test ( 'not all events processed', async ()=> {
        mock.onPost('http://localhost').replyOnce( 201,{count:2} );
        events = { file:[], mem: [ {context:'test',event:{a:1}},{context:'test',event:{b:2}},{context:'test1',event:{c:3}} ] }
        let res = await rla.send();
        expect(res).toEqual( {processed:2, mem:3, file:0})
        expect( JSON.parse(mock.history.post[0].data)).toEqual({events:events.mem})
        expect( rla.sendBusy).toBeFalsy()

    });

    test ( 'with headers', async ()=> {
        mock.onPost('http://localhost').replyOnce( 201,{count:3} );
        events = { file:[], mem: [ {context:'test',event:{a:1}},{context:'test',event:{b:2}},{context:'test1',event:{c:3}} ] }
        rla.headers= { a:1}

        let res = await rla.send();
        expect( mock.history.post[0].headers).toMatchObject( {a:1})
        expect( rla.sendBusy).toBeFalsy()

    });

    test( 'server returns invalid response', async ()=> {
        mock.onPost('http://localhost').replyOnce( 201,"Hellow World");
        events = { file:[], mem: [ {context:'test',event:{a:1}},{context:'test',event:{b:2}},{context:'test1',event:{c:3}} ] }
        let res = await rla.send();
        expect(res.processed).toBe(0);
        expect( rla.sendBusy).toBeFalsy()
    });

    test( 'server returns error', async ()=> {
        mock.onPost('http://localhost').replyOnce( 500,{} );
        events = { file:[], mem: [ {context:'test',event:{a:1}},{context:'test',event:{b:2}},{context:'test1',event:{c:3}} ] }
        let res = await rla.send();
        expect(res.processed).toBe(0);
        expect( rla.sendBusy).toBeFalsy()
    });

    test( 'network error', async ()=> {
        mock.onPost('http://localhost').networkErrorOnce();
        events = { file:[], mem: [ {context:'test',event:{a:1}},{context:'test',event:{b:2}},{context:'test1',event:{c:3}} ] }
        let res = await rla.send();
        expect(res.processed).toBe(0);
        expect( rla.sendBusy).toBeFalsy()
    });

    test( 'no url specificed => throws error', async ()=> {
        rla.url = undefined;
        events = { file:[], mem: [ {context:'test',event:{a:1}},{context:'test',event:{b:2}},{context:'test1',event:{c:3}} ] }
        error = undefined;
        try {
            await rla.send() 
        }
        catch(err) {
            error = err;
        }
        expect(error).toBeDefined();
        expect(rla.loadFromMemoryCache).toHaveBeenCalledTimes(0)
        expect( rla.sendBusy).toBeFalsy()
    });

    test( 'busy => returns immediatly with no events processed', async ()=> {
        events = { file:[], mem: [ {context:'test',event:{a:1}},{context:'test',event:{b:2}},{context:'test1',event:{c:3}} ] }
        rla.sendBusy = true;

        let res = await rla.send();
        expect(res.processed).toBe(0);
        expect(rla.loadFromMemoryCache).toHaveBeenCalledTimes(0)
        expect( rla.sendBusy).toBeTruthy()
    });

})

describe('startWorker', ()=> {
    let original = RestLogAdapter.prototype.send;
    let rla;

    beforeAll( ()=> {
        RestLogAdapter.prototype.send = jest.fn( );
        jest.useFakeTimers()
    })

    afterEach( ()=> {
        jest.clearAllMocks();
        if (rla && rla.iv)
            clearInterval(rla.iv)
    })

    afterAll( ()=> {
        jest.runOnlyPendingTimers();
        jest.useRealTimers()
        RestLogAdapter.prototype.send = original;
    })

    test( 'trigger send every <ms>, returns iv handler',()=> {
        rla = new RestLogAdapter({sendInterval:0.1})
        jest.advanceTimersByTime(250);
        expect( rla.iv).toBeDefined();
        expect( rla.send).toHaveBeenCalledTimes(2);

       
    })

    test( 'does not start worker if <ms>=0, returns undefined',()=> {
        RestLogAdapter.prototype.send = jest.fn();
        rla = new RestLogAdapter({sendInterval:0})
        jest.advanceTimersByTime(1000);
        expect( rla.iv).toBeUndefined();
        expect( rla.send).toHaveBeenCalledTimes(0);

    })

})


describe('stop', ()=> {
    let original = RestLogAdapter.prototype.send;    
    let rla;

    beforeAll( ()=> {
        RestLogAdapter.prototype.send = jest.fn( );
        jest.spyOn(RestLogAdapter,'_clear');
        jest.useFakeTimers()
    })

    afterEach( ()=> {
        
        jest.clearAllMocks();

        if (rla && rla.iv)
            clearInterval(rla.iv)
    })

    afterAll( ()=> {
        jest.runOnlyPendingTimers();
        jest.useRealTimers()
        RestLogAdapter.prototype.send = original;
    })

    test( 'active interval => clears interval and sends data one more time',()=> {

        rla = new RestLogAdapter({sendInterval:10}) // every 10s
        jest.advanceTimersByTime(50);
        expect( rla.iv).toBeDefined();
        expect( rla.send).toHaveBeenCalledTimes(0);

        rla.stop();
        expect( RestLogAdapter._clear).toHaveBeenCalledTimes(1);
        expect( rla.iv).toBeUndefined();
        expect( rla.send).toHaveBeenCalledTimes(1);

    })

    test( 'no active interval => nothing will be done',()=> {
        RestLogAdapter.prototype.send = jest.fn();
        rla = new RestLogAdapter({sendInterval:0})
        jest.advanceTimersByTime(1000);
        expect( rla.iv).toBeUndefined();
        expect( rla.send).toHaveBeenCalledTimes(0);

        rla.stop();
        expect( RestLogAdapter._clear).toHaveBeenCalledTimes(0);
        expect( rla.iv).toBeUndefined();
        expect( rla.send).toHaveBeenCalledTimes(0);


    })

})



describe('flush', ()=> {


    let rla = undefined;

    afterEach( ()=> {       
        jest.clearAllMocks();
        if (rla && rla.iv)
            clearInterval(rla.iv)
   
    })


    test( 'normal call => send should be called ',async ()=> {

        rla = new RestLogAdapter({sendInterval:1000}) // every 1000s
        rla.send= jest.fn();

        await rla.flush();
        expect( rla.send).toHaveBeenCalledTimes(1);
    })

    test( 'send throws exception => no exception should be thrown',async ()=> {
        rla = new RestLogAdapter({sendInterval:1000}) // every 1000s
        rla.send = jest.fn( ()=>  { throw new Error('test')} );
        
        let error = undefined;
        try {
            await rla.flush();  
        } 
        catch( err) {
            error = err;
        }
        expect( rla.send).toHaveBeenCalledTimes(1);
        expect(error).toBeUndefined();


    })

})

describe('loadFromMemoryCache', () => {

    let rla;
    beforeEach( ()=> {
        rla = new RestLogAdapter({sendInterval:1000}) // every 1000s
    })
    afterEach( ()=> {       
        if (rla & rla.iv) {
            clearInterval(rla.iv)
        }
    })

    test( 'empty cache' ,()=> {
        rla.inMemoryCache = []
        const events = [ 1,2,3,4]
        rla.loadFromMemoryCache( events )
        expect(events).toMatchObject([ 1,2,3,4])
        expect(rla.inMemoryCache).toMatchObject([])
    })

    test( 'cache populated, events empty' ,()=> {
        rla.inMemoryCache = [1,2,3,4,5]
        const events = []
        rla.loadFromMemoryCache( events )
        expect(events).toMatchObject([ 1,2,3,4,5])
        expect(rla.inMemoryCache).toMatchObject([])

    })

    test( 'cache populated, events already has items' ,()=> {
        rla.inMemoryCache = [1,2,3,4,5]
        const events = [1,2,3,4]
        rla.loadFromMemoryCache( events )
        expect(events).toMatchObject([ 1,2,3,4, 1,2,3,4,5])
        expect(rla.inMemoryCache).toMatchObject([])

    })

    test( 'exceptional: event is not an array ' ,()=> {
        rla.inMemoryCache = [1,2,3,4,5]
        const events = "something"
        expect(() =>  rla.loadFromMemoryCache( events )).toThrow()

    })


})

