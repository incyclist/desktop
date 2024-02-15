const yauzl = require("yauzl");
const fs = require('fs')
const path = require('path');

const DEFAULT_TIMEOUT = 5000;

function checkDir(p) {
    if (p===undefined || p=='' )
     return false;

    try {
        if (!fs.existsSync(p)){
            fs.mkdirSync(p);
        }
        return true;    
    }
    catch (e) {
        return false
    }
}



class ZipData {

    constructor( source, opts ) {
        if (source==undefined)
            return;
        
        this.data = source;
        this.zipfile = undefined;
        this.openCount = 0;
        this.callbacks = {}
        this.iv = undefined;
        this.timeoutVal = (opts!==undefined && opts.timeout!==undefined) ? opts.timeout : DEFAULT_TIMEOUT;
        this.files = [];
    }

    _extract(exportTo) {
        return new Promise ( async (resolve,reject) => {
            this.callbacks = {resolve,reject};

            yauzl.fromBuffer( this.data,{lazyEntries: true},(err, zipfile) => {
                if (err) return reject(err);

                try {
                    this.zipfile = zipfile;
                    this.zipfile.on('entry',(entry) => { this.onZipEntry(entry,exportTo) });
                    this.zipfile.on('end', () =>{ this.onZipEnd()})
                    this.zipfile.on('error', (error) =>{this.reject(error);})        
    
                    this.zipfile.readEntry();
                    this.checkForTimeout();
                }
                catch(error){
                    reject( error );
                }
    
            } );    
        })

    }

    async extract( exportTo) {

        try {

            if (this.iv!==undefined)
                throw new Error('no concurrent call allowed')

            await this._extract(exportTo);
            return { success:true, files:this.files };
        }
        catch(err) {
            return { success:false};
        }
    }


    checkForTimeout(timeout) {
        let tsStart = Date.now();
        this.iv = setInterval( ()=>{
            let ts = Date.now();
            if (ts-tsStart>timeout) {
                this.reject(new Error('timeout'))
            }
        } ,50 )        
    }

    clearTimeout() {
        if ( this.iv!==undefined)
            clearInterval(this.iv);
        this.iv = undefined;
    }

    resolve(result) {
        this.clearTimeout();
        if ( this.callbacks.resolve!==undefined)
            this.callbacks.resolve(result)
    }

    reject(error) {
        this.clearTimeout();
        if ( this.callbacks.reject!==undefined)
            this.callbacks.reject(error)
    }

    onZipEntry(entry,exportTo) {

        let fname = path.join(exportTo,entry.fileName)
        checkDir( path.dirname(fname));
        if (entry.uncompressedSize==0)  {
            this.zipfile.readEntry();
            return;
        }
        
        let self = this;
        this.zipfile.openReadStream(entry, (err,stream)=>{
            if ( err) self.reject(err);

            stream.on("end", function() { self.zipfile.readEntry(); });

            try {
                self.openCount++;
                let writeStream = fs.createWriteStream(fname);
                writeStream.on('close',()=> { 
                    self.openCount--; 
                    self.files.push(entry.fileName);
                    //console.log('done:',fname,count)
                })
                stream.pipe(writeStream);
            }
            catch(err) {
                self.reject(err)
            }
        })

        

    }

    onZipEnd() {
        let tsStart = Date.now();
        let iv = setInterval( ()=>{
            if ( this.openCount===0) {
                clearInterval(iv);
                this.resolve(true);
                return;
            }
            let ts = Date.now();
            if (ts-tsStart>2000) {
                this.reject(new Error('timeout'))
            }
        } ,50 )        
    }

    
    
}


module.exports = {
    ZipData
}