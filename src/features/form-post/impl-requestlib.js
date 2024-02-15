const request = require( 'request')
const fs = require ( 'fs/promises');
const { EventLogger } = require('gd-eventlog');

class RequestForm  {


    constructor() {
        this.requests = [];
        this.logger = new EventLogger('Form')
    }

    async createForm(optsRequest,uploadInfo) {
        const opts = {...optsRequest}

        try {
            opts.formData = {}
            let keys = Object.keys(uploadInfo);         
            
            for (let i=0;i<keys.length;i++) {
                const key = keys[i]
                if ( uploadInfo[key]!==undefined) {
                    let val = uploadInfo[key];
                    if ( val.type!==undefined && val.type==='file') {
                        const content = await fs.readFile(val.fileName);
                        val = { 
                            value:content,
                            options: {
                                filepath:val.fileName
                            }
                        }
                    }
                    opts.formData[key]=val
    
                }
            }
    
        }
        catch(err) {
            this.logger.logEvent({message:'error',fn:'createForm',error:err.message,stack:err.stack})
        }

        return opts;

    }

    async post (opts) {

        return new Promise( (resolve,reject) => {
            try {
                const options = {...opts}
                const url = opts.url
                delete options.url

                request.post(url,options, (err,response,body)=> {
                    if ( err) {
                        reject(err)
                    } 
                    else {


                        let data
                        try { data = JSON.parse(body) } catch {}

                        if ( response.statusCode<200 || response.statusCode>=300) {
                            let error = {
                                response: {
                                    status: response.statusCode,
                                    message: response.statusMessage,
                                    data,
                                    body
                                }
                            }
                            return reject ( error)
                        }
                        let res = {
                            data,
                            body,
                            statusCode: response.statusCode
                        }
                        
                        resolve (res)
                    }
                })

            }
            catch (error) {
                reject(error)
            }
        })

    }


}

module.exports = RequestForm