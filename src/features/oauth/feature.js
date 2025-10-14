const Feature = require('../base');
const {ipcMain,app} = require('electron');
const {ipcCall, ipcCallNoResponse, ipcHandle, ipcHandleNoResponse} = require ('../utils');
const EventEmitter = require('node:events');
const OAuthWindow = require('../../web/pages/oauth');
const { EventLogger } = require('gd-eventlog');

class OauthFeature extends Feature{

    static _instance;
    
    constructor() {
        super()
        this.oauthSessions = [];
        this.emitter = new EventEmitter;
        this.logger = new EventLogger('OauthWin')
    }

    static getInstance() {
        if (!OauthFeature._instance)
            OauthFeature._instance = new OauthFeature()
        return OauthFeature._instance;
    }

    authorize(provider) {       
        let completed = false
        return new Promise ( done => {

            const onStatus = (event) => {
                completed = true
                oauth.removeAllListeners()
                this.close(oauth) 
                if (event.user_changed) {
                    done( {success:true, user:event.user_changed})
                }
                else if (event.user_change_aborted) {
                    done( {success:false, reason: 'user aborted'})
                }
            }

            const onFailed = (event) => {
                if (completed) 
                    return;
                completed = true;
                oauth.removeAllListeners()
                this.close(oauth) 
                done({success:false,reason: event? event.reason: undefined })                
            }

            const onClosed = (event) => {
                if (completed) 
                    return;
                completed = true;
                oauth.removeAllListeners()
                this.close(oauth) 
                done({success:false,reason: 'user aborted' })                
            }

            const oauth = new OAuthWindow(app.incyclistApp,{provider,legacyApi:false});
            oauth.on('status', onStatus)
            oauth.on('failed', onFailed )
            oauth.on('closed', onClosed )
            this.oauthSessions.push (oauth)    
            
        })
        
    }

    close(session) {
        session.removeAllListeners();

        if (this.oauthSessions.length>1) {
            const idx = this.oauthSessions.findIndex( o => o.getId() ===session.getId())
            if (idx===-1)
                return; // ignore
            this.oauthSessions.splice(idx,1)
        }
        else  {
            this.oauthSessions.splice(0,1)
        }


    }

    emit( sid,event) {

        this.logger.logEvent({message:'oauth event',event})
        let oauth;
        if (this.oauthSessions.length>1) {
            const idx = this.oauthSessions.findIndex( o => o.getId() ===sid)
            if (idx===-1)
                return; // ignore
            oauth = this.oauthSessions[idx];
        }
        else  {
            oauth = this.oauthSessions.length==1 ? this.oauthSessions[0] : undefined
        }
       
        oauth.emit('status', event)        
    }

    show(service)  {
        app.incyclistApp.showAuthWindow(service)  
    }

    register( props) {
        ipcHandle('oauth-authorize',this.authorize.bind(this),ipcMain)
        ipcHandleNoResponse('oauth-emit',this.emit.bind(this),ipcMain)
        ipcHandleNoResponse('oauth-show',this.show.bind(this),ipcMain)

    }

    registerRenderer( spec, ipcRenderer) {
        spec.oauth = {}

        // legacy - can be removed once OAuth server is updated
        spec.oauth.showAuthWindow    = ipcCall('oauth-show',ipcRenderer)   

        // new 
        spec.oauth.authorize         = ipcCall('oauth-authorize',ipcRenderer)   
        spec.oauth.emit              = ipcCallNoResponse('oauth-emit',ipcRenderer)   

        spec.registerFeatures( [
            'oauth', 
        ] )
    }

}

module.exports = OauthFeature

