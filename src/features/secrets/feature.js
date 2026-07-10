const { safeStorage, app, powerMonitor, net, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { EventLogger } = require('gd-eventlog')
const Feature = require('../base')
const { ipcHandleSync, ipcCallSync } = require('../utils/index.js')

const AppSettings = require('../AppSettings');

const TTL_DAYS = 30;
const RETRY_INTERVAL_MS = 60 * 1000;
const STATUS_TIMEOUT_MS = 3000;
const PROVISION_TIMEOUT_MS = 5000;
const DEFAULT_SECRETS_BASE_URL = 'https://dlws.incyclist.com';

class SecretsFeature extends Feature {
    static _instance;

    constructor() {
        super();
        this.logger = new EventLogger('Secrets');
        this.currentStatus = 'missing';
        this.currentSecrets = null;
        this.initPromise = null;
        this.retryIv = null;
        this._pendingVerification = false;
    }

    static getInstance() {
        if (!SecretsFeature._instance)
            SecretsFeature._instance = new SecretsFeature();
        return SecretsFeature._instance;
    }

    _isProd() {
        return (process.env.ENVIRONMENT ?? 'prod') === 'prod';
    }

    _getBaseUrl() {
        const fromSettings = AppSettings.getInstance().settings?.SECRET_SERVER_URL;
        return fromSettings ?? process.env.SECRETS_BASE_URL ?? DEFAULT_SECRETS_BASE_URL;
    }

    getSecret(key) {
        if (!this._isProd())
            return this._getDevSecret(key);
        return this.currentSecrets ? (this.currentSecrets[key] ?? '') : '';
    }

    getStatus() {
        if (!this._isProd()) return 'ok';
        return this.currentStatus;
    }

    async init({ timeout = 5000 } = {}) {
        if (!this._isProd()) {
            this.logger.logEvent({ message: 'skipping secret update', reason: 'non-prod build' });
            this._logDevSecretsSource();
            return 'ok';
        }

        this.logger.logEvent({ message: 'secrets server', url: this._getBaseUrl() });

        if (!this.initPromise)
            this.initPromise = this.performInit();

        const result = await Promise.race([
            this.initPromise,
            new Promise(resolve => setTimeout(() => resolve(this.currentStatus), timeout)),
        ]);
        this.initPromise = null;
        this._startRetry();
        return result;
    }

    async performInit() {
        try {
            if (!safeStorage.isEncryptionAvailable()) {
                this.logger.logEvent({ message: 'safeStorage not available' });
                this.currentStatus = 'missing';
                return this.currentStatus;
            }

            const cache = this._readCache();
            const isOnline = net.isOnline();
            const expired = !cache || this._isExpired(cache.fetchedAt);

            this.logger.logEvent({ message: 'secret cache status', cacheStatus: cache ? 'found' : 'null', expired });

            if (expired || !cache) {
                if (!isOnline) {
                    this.currentStatus = 'missing';
                    return this.currentStatus;
                }
                return await this._runProvisioning();
            }

            if (!isOnline) {
                this.currentSecrets = cache.secrets;
                this.currentStatus = 'ok';
                this._pendingVerification = true;
                return this.currentStatus;
            }

            return await this._runStatusCheck(cache);
        } catch (err) {
            this.logger.logEvent({ message: 'error', fn: 'performInit', error: err.message, stack: err.stack });
            this.currentStatus = 'missing';
            return this.currentStatus;
        }
    }

    async _runStatusCheck(cache) {
        try {
            this.logger.logEvent({ message: 'check secret status' });
            const apiKey = cache.secrets?.INCYCLIST_API_KEY;
            const headers = apiKey ? { 'x-api-key': apiKey } : {};
            const response = await this._fetchWithTimeout(
                `${this._getBaseUrl()}/api/v1/secrets/status`,
                { headers },
                STATUS_TIMEOUT_MS
            );

            if (response.status === 401)
                return await this._runProvisioning();

            if (response.ok) {
                const data = response.data;
                if (data.valid) {
                    this.currentSecrets = cache.secrets;
                } else {
                    this._writeCache({ secrets: data.secrets, expiresAt: data.expiresAt });
                    this.currentSecrets = data.secrets;
                }
                this.currentStatus = 'ok';
                this._pendingVerification = false;
            } else {
                this.currentSecrets = cache.secrets;
                this.currentStatus = 'ok';
                this._pendingVerification = true;
            }
        } catch (err) {
            this.logger.logEvent({ message: 'check secret status failed', reason: err.message });
            this.currentSecrets = cache.secrets;
            this.currentStatus = 'ok';
            this._pendingVerification = true;
        }
        return this.currentStatus;
    }

    _generateAppId(version, osInfo, uuid) {
        return crypto.createHash('sha256').update(`${version}|${osInfo}|${uuid}`).digest('hex').slice(0, 32);
    }

    async _runProvisioning() {
        try {
            this.logger.logEvent({ message: 'provisioning desktop secrets' });
            const version = app.getVersion();
            const osInfo = `${os.platform()}-${os.arch()}`;
            const uuid = AppSettings.getInstance().settings?.uuid;
            const appId = this._generateAppId(version, osInfo, uuid);

            const headers = {
                'x-app-id': appId,
                'x-app-version': version,
                'x-os': osInfo,
                'x-uuid': uuid,
            };

            const response = await this._fetchWithTimeout(
                `${this._getBaseUrl()}/api/v1/secrets/desktop`,
                { method: 'POST', headers },
                PROVISION_TIMEOUT_MS
            );

            if (response.ok) {
                const data = response.data;
                this._writeCache({ secrets: data.secrets, expiresAt: data.expiresAt });
                this.currentSecrets = data.secrets;
                this.currentStatus = 'ok';
                this._pendingVerification = false;
            } else {
                this.logger.logEvent({ message: 'provisioning failed', status: response.status });
                this.currentStatus = 'missing';
            }
        } catch (err) {
            this.logger.logEvent({ message: 'provisioning failed', reason: err.message });
            this.currentStatus = 'missing';
        }
        this.logger.logEvent({ message: 'provisioning result', secretsStatus: this.currentStatus });
        return this.currentStatus;
    }

    _startRetry() {
        if (this.retryIv) return;
        this.retryIv = setInterval(async () => {
            if (this.currentStatus === 'ok' && !this._pendingVerification) return;
            await this.performInit();
        }, RETRY_INTERVAL_MS);

        powerMonitor.on('resume', async () => {
            await this.performInit();
        });
    }

    _isExpired(fetchedAt) {
        if (!fetchedAt) return true;
        const time = new Date(fetchedAt).getTime();
        return (Date.now() - time) >= (TTL_DAYS * 24 * 60 * 60 * 1000);
    }

    _getCacheFilePath() {
        return path.join(app.getPath('userData'), 'secrets.enc');
    }

    _readCache() {
        try {
            const filePath = this._getCacheFilePath();
            if (!fs.existsSync(filePath)) return null;
            const base64 = fs.readFileSync(filePath, 'utf8');
            const buffer = Buffer.from(base64, 'base64');
            const decrypted = safeStorage.decryptString(buffer);
            return JSON.parse(decrypted);
        } catch (err) {
            this.logger.logEvent({ message: 'cache read failed', reason: err.message });
            return null;
        }
    }

    _writeCache(data) {
        try {
            const cacheData = { ...data, fetchedAt: new Date().toISOString() };
            const encrypted = safeStorage.encryptString(JSON.stringify(cacheData));
            fs.writeFileSync(this._getCacheFilePath(), encrypted.toString('base64'), 'utf8');
        } catch (err) {
            this.logger.logEvent({ message: 'cache write failed', reason: err.message });
        }
    }

    async _fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            let data = null;
            try { data = await response.json(); } catch {}
            return { ok: response.ok, status: response.status, data };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    _getDevSecretsPath() {
        return path.join(__dirname, '../../secrets.json');
    }

    _logDevSecretsSource() {
        const secretsPath = this._getDevSecretsPath();
        try {
            if (fs.existsSync(secretsPath)) {
                const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
                this.logger.logEvent({ message: 'dev secrets', source: 'secrets.json', availableKeys: Object.keys(secrets) });
            } else {
                this.logger.logEvent({ message: 'dev secrets', source: 'env vars only', note: 'secrets.json not found at ' + secretsPath });
            }
        } catch (err) {
            this.logger.logEvent({ message: 'dev secrets', source: 'none', error: err.message });
        }
    }

    _getDevSecret(key) {
        if (process.env[key]) return process.env[key];
        try {
            const secretsPath = this._getDevSecretsPath();
            if (fs.existsSync(secretsPath)) {
                const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
                return secrets[key] ?? null;
            }
        } catch {}
        return null;
    }

    register(_props) {
        ipcHandleSync('secrets-getSecret', (key) => SecretsFeature.getInstance().getSecret(key), ipcMain);
        ipcHandleSync('secrets-getStatus', () => SecretsFeature.getInstance().getStatus(), ipcMain);
    }

    registerRenderer(spec, ipcRenderer) {
        spec.secrets = {};
        spec.secrets.getSecret = ipcCallSync('secrets-getSecret', ipcRenderer);
        spec.secrets.getStatus = ipcCallSync('secrets-getStatus', ipcRenderer);
        spec.registerFeatures(['secrets']);
    }
}

module.exports = SecretsFeature;
