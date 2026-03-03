const axios = require( 'axios')
const fs = require ( 'fs/promises');
const { EventLogger } = require('gd-eventlog');
const FormData = require('form-data');

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
        try {
            const options = {...opts}
            const url = opts.url
            delete options.url

            // Convert formData to axios-compatible format
            const formData = new FormData();
            if (options.formData) {
                for (const [key, value] of Object.entries(options.formData)) {
                    if (value.value && value.options) {
                        // Handle file uploads
                        formData.append(key, value.value, value.options);
                    } else {
                        formData.append(key, value);
                    }
                }
                delete options.formData;
            }

            const response = await axios.post(url, formData, {
                ...options,
                headers: {
                    ...options.headers,
                    ...formData.getHeaders?.()
                }
            });

            return {
                data: response.data,
                body: JSON.stringify(response.data),
                statusCode: response.status
            };

        } catch (error) {
            if (error.response) {
                // Axios error with response
                throw {
                    response: {
                        status: error.response.status,
                        message: error.response.statusText,
                        data: error.response.data,
                        body: JSON.stringify(error.response.data)
                    }
                };
            } else {
                // Other errors
                throw error;
            }
        }
    }


}

module.exports = RequestForm