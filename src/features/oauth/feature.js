const Feature = require('../base');
const {ipcMain,app,shell} = require('electron');
const {ipcCall, ipcCallNoResponse, ipcHandle, ipcHandleNoResponse} = require ('../utils');
const EventEmitter = require('node:events');
const http = require('node:http');
const { EventLogger } = require('gd-eventlog');

const OAUTH_SERVER = 'https://auth.incyclist.com/';
const AUTH_TIMEOUT_MS = 5*60*1000; // give the user enough time to log in + solve a captcha

const CALLBACK_RESPONSE_HTML = '<html><body>You can close this window and return to Incyclist.</body></html>';

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

    // Opens the OAuth provider's login page in the user's real, default system
    // browser (rather than an embedded Electron BrowserWindow) and gets the
    // result back via a short-lived loopback HTTP server, the same pattern
    // used by most desktop OAuth clients (gcloud, VS Code, ...) and
    // conceptually equivalent to the redirect_uri mobile already uses
    // (incyclist://oauth/callback) - here the "redirect_uri" is
    // http://127.0.0.1:<ephemeral-port>/callback instead of a custom URL
    // scheme, so no OS-level protocol registration/packaging changes are
    // needed on any platform, and it works identically in dev and packaged
    // builds. auth-server's success.ejs/error.ejs need no changes: they
    // already just echo whatever `sid` they were given back as a redirect
    // target, so a loopback URL works exactly like the incyclist:// one does.
    //
    // Trade-off accepted: unlike the embedded-window flow (which could detect
    // the user closing the window as an explicit cancel), there is no signal
    // when the user abandons the system-browser tab without completing or
    // cancelling - the request just times out after AUTH_TIMEOUT_MS.
    authorize(provider) {
        const oauthUrl = (app.incyclistApp.settings.oauthUrl || OAUTH_SERVER).replace(/\/+$/,'')

        return new Promise( done => {
            let completed = false
            let server
            let timeoutHandle

            const finish = (result) => {
                if (completed)
                    return
                completed = true
                clearTimeout(timeoutHandle)
                if (server)
                    server.close()
                done(result)
            }

            server = http.createServer( (req,res) => {
                let url
                try {
                    url = new URL(req.url, 'http://127.0.0.1')
                }
                catch {
                    res.writeHead(400); res.end(); return
                }

                if (url.pathname !== '/callback') {
                    res.writeHead(404); res.end(); return
                }

                res.writeHead(200,{'Content-Type':'text/html'})
                res.end(CALLBACK_RESPONSE_HTML)

                const params = url.searchParams
                if (params.has('error')) {
                    const error = params.get('error')
                    finish({success:false, reason: error==='aborted' ? 'user aborted' : error})
                    return
                }

                // Mirrors success.ejs, which spreads whatever fields exist on
                // user.auth.strava/intervals into the redirect's query string -
                // pass all of them through unchanged rather than assuming a
                // fixed set of field names.
                const authData = {}
                for (const [key,value] of params.entries())
                    authData[key] = value

                finish({success:true, user:{auth:{[provider]:authData}}})
            })

            server.on('error', (err) => {
                this.logger.logEvent({message:'local oauth callback server error', error:err.message})
                finish({success:false, reason:'local callback server error'})
            })

            server.listen(0,'127.0.0.1', () => {
                const port = server.address().port
                const redirectUri = `http://127.0.0.1:${port}/callback`
                const authUrl = `${oauthUrl}/${provider}?sid=${encodeURIComponent(redirectUri)}`

                this.logger.logEvent({message:'opening system browser for oauth', provider, port})
                shell.openExternal(authUrl).catch( (err) => {
                    finish({success:false, reason: 'could not open browser: '+err.message})
                })
            })

            timeoutHandle = setTimeout( () => {
                this.logger.logEvent({message:'oauth timed out', provider})
                finish({success:false, reason:'timeout'})
            }, AUTH_TIMEOUT_MS)
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

