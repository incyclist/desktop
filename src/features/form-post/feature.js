const Feature = require('../base');
const {ipcMain} = require('electron');
const {ipcCall, ipcHandle } = require ('../utils');
const RequestForm = require('./impl-requestlib');

class FormPostFeature extends Feature{

    static _instance;

    constructor() {
        super()
        this.requests = [];
        this.impl = new RequestForm()
    }

    static getInstance() {
        if (!FormPostFeature._instance)
            FormPostFeature._instance = new FormPostFeature()
        return FormPostFeature._instance;
    }

    async createFormRequest(opts,uploadInfo) {
        const res = await this.impl.createForm(opts,uploadInfo)
        opts.id = Date.now();
        this.requests.push({id:opts.id, opts:res})

        return opts;
    }

    async postRequest(opts) {
        let res = {}
        const reqIdx = this.requests.findIndex( r => r.id===opts.id)
        if (reqIdx===-1){
            res = { error:new Error('request not found')}
            return res;
        }
        
        const req = this.requests[reqIdx];
        this.requests.splice(reqIdx,1)

        try {
            const result = await this.impl.post(req.opts)
            res = {data:result}
        }
        catch(error) {
            res = { error }
        }
        return res;
            
    }


    register( props) {
        ipcHandle('formPost-createForm',this.createFormRequest.bind(this),ipcMain)
        ipcHandle('formPost-post',this.postRequest.bind(this),ipcMain)

    }

    registerRenderer( spec, ipcRenderer) {
        spec.formPost = {}

        // methods that have to be served by the main process
        spec.formPost.createForm    = ipcCall('formPost-createForm',ipcRenderer)   
        spec.formPost.post          = ipcCall('formPost-post',ipcRenderer)   

        spec.registerFeatures( [
            'formPost', 
        ] )


    }

}


module.exports = FormPostFeature

