class NamedPromise {

    static _promises = {}

    static add(name,promise) {
        NamedPromise._promises[name] = { name,promise}
    }

    static delete(name) {
        delete NamedPromise._promises[name]
    }

    static exists(name) {
        return NamedPromise._promises[name]!==undefined && NamedPromise._promises[name]!==null
    }

    static async exec(name,timeout) {
        const {promise} = NamedPromise._promises[name]||{}
        if (!promise)
            throw new Error(`Promise ${name} does not exist` )

        if (timeout) {
            let to;
            let hasTimedOut=false;

            const toPromise =  (ms) => { 
                return new Promise( (_resolve,reject) => { 
                    to = setTimeout(()=>{                        
                        hasTimedOut = true;
                        reject(new Error('timeout'))            
                }, ms)})
            }            

            const res = await Promise.race( [ toPromise(timeout),NamedPromise.exec(name)])            
            clearTimeout(to)
            if (!hasTimedOut)
                return res;

        }
        else {
            const res = await promise      
            delete NamedPromise._promises[name]
            return res;
    
        }


    }


}

module.exports = NamedPromise