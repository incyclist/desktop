const axios = require ('axios')
const {EventLogger,BaseAdapter} = require('gd-eventlog');
const fs = require('fs')
const os = require('os')
const path = require('path')

class RestLogAdapter extends BaseAdapter {
    static  DEFAULT_SEND_INTERVAL = 120; // 2min

    constructor(opts={}) {
        super();
        this.logger = opts.logger || new EventLogger('RestLogAdapter');

        this.logger.logEvent({message:'New RestLogAdapter',opts})

        // set defaults
        this.url = undefined;
        this.cacheDir = undefined;
        this.iv = undefined;
        this.inMemoryCache = [];
        this.sendInterval = RestLogAdapter.DEFAULT_SEND_INTERVAL*1000;
        this.sendBusy = false;
        this.headers = undefined;

        // copy parameters from opts
        this.url = opts.url
        this.headers = opts.headers
        this.cacheDir = opts.cacheDir
        if (opts.sendInterval!==undefined)
            this.sendInterval = opts.sendInterval*1000; 
        else 
            this.sendInterval = RestLogAdapter.DEFAULT_SEND_INTERVAL*1000;

        this.iv = this.startWorker( this.sendInterval);    
    
    }

    startWorker(ms) {
        if (ms) {
            return  setInterval( ()=>{this.send() },ms)
        }
    }

    // this function was only introduced, so we can better mock/spy on it in tests
    static _clear(iv) {
        clearInterval(iv);
    }

    stop() {

        if ( this.iv!==undefined) {
            RestLogAdapter._clear(this.iv);
            this.iv = undefined;
            this.send(true);
        }

    }

    async flush() {
        try {
            return await this.send(true);
        }
        catch(err) {
            console.log(err.message, err.stack)
        }
    }

    log(context, event) {
        
        if ( this.url===undefined)
            return;
        if ( context===undefined || event==undefined)
            return;

        try {

            this.inMemoryCache.push( {context,event} )
        }
        catch (err) {
            console.log(err.message, err.stack)
            //this.logger.logEvent({message:'error',error})
        }

    }

    loadFromMemoryCache(events) {
        if ( !events || !Array.isArray(events))
            throw new Error( 'Illegal Arguments: events must be an array')

        let cnt = events.push( ...this.inMemoryCache)
        this.inMemoryCache = this.inMemoryCache.slice(cnt);    
    }


    send(ignoreBusy=false) {
        return new Promise( (resolve, reject) => {

            let stats = { processed:0, mem:this.inMemoryCache.length, file:0 }

            if (this.url===undefined)
                return reject( new Error('no Url specified')) ;

            if ( this.sendBusy && !ignoreBusy)
                return resolve(stats);

            this.sendBusy = true;

            let events  = [];          
            this.loadFromMemoryCache(events);
            this.logger.logEvent( {message:'worker thread sending',events:events.length})

            if( events.length===0) {
                this.sendBusy = false;
                return resolve( stats);
            }
        
            let config = this.headers ? { headers : this.headers} : undefined;
            
            axios.post( this.url,{events},config)
            .then( res => {
                stats.mem = this.inMemoryCache.length;

                let processed = 0;                    
                if (!res.data || !res.data.count) res.data = {count:0}
                processed = stats.processed =  res.data.count ;
                
                if (processed!==events.length) {
                    // trigger resending of events
                    this.inMemoryCache.concat(events);
                    stats.mem +=  events.length
                }

                this.sendBusy = false;
                return resolve(stats)
            })                   
            .catch (err=> {
                try {
                    if ( err.response !==undefined) {
                        const fName = path.join( os.tmpdir(), `./failed_logs-${Date.now()}`)
                        this.logger.logEvent( {message:'could not send',events:fName,status:err.response.status,statusText:err.response.statusText})                        
                        fs.writeFileSync( fName,JSON.stringify(events))
                    }
                    else {
                        this.logger.logEvent( {message:'could not send',events:fName,errno:err.errno,code:err.code})
                        fs.writeFileSync( fName,JSON.stringify(events))
                    }
    
                }
                catch {}

                this.sendBusy = false;
                resolve( { processed:0, mem:this.inMemoryCache.length, file:0 })
            })

            
            

        })
    }
    

}

module.exports = RestLogAdapter