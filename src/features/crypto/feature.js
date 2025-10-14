const {ipcMain} = require('electron');
const crypto = require('node:crypto')

const Feature = require('../base');
const {ipcCallSync,ipcHandleSync} = require ('../utils');

class CryptoFeature extends Feature { 
    static _instance;
    
    hashes = []


    static getInstance() {
        if (!CryptoFeature._instance)
            CryptoFeature._instance = new CryptoFeature()
        return CryptoFeature._instance;
    }

    // -----------------------------------------------------
    // Ipc Server side (main process)
    // -----------------------------------------------------
    register( props) {
        ipcHandleSync('crypto-randomBytes', crypto.randomBytes, ipcMain )
        ipcHandleSync('crypto-createHash', this.createHash.bind(this), ipcMain )
        ipcHandleSync('crypto-generateKeyPairSync', crypto.generateKeyPairSync, ipcMain )
        ipcHandleSync('crypto-hash-copy', this.hashCopy.bind(this), ipcMain )
        ipcHandleSync('crypto-hash-update', this.hashUpdate.bind(this), ipcMain )
        ipcHandleSync('crypto-hash-digest', this.hashDigest.bind(this), ipcMain )
    }

    createHash(algorithm) {
        const hash = crypto.createHash(algorithm)
        const id = this._createId()
        this.hashes.push(hash)
        return id
    }

    _getHash(id) {
        return this.hashes[id]
    }
    _createId() {
        return this.hashes.length
    }

    hashUpdate(id, data, inputEncoding) { 
        const hash = this._getHash(id)
        if (!hash)
            return null;
        hash.update(data, inputEncoding)
        return id;
    }

    hashCopy(id,options) {
        const hash = this._getHash(id)
        if (!hash)
            return null;
        const newHash = hash.copy(options)
        const newId = this._createId()
        this.hashes.push(newHash)
        return newId
    }
    hashDigest(id, encoding) {
        const hash = this._getHash(id)
        if (!hash)
            return null;
        const digest = hash.digest(encoding)
        return digest
    }


    // -----------------------------------------------------
    // Ipc client side (renderer process)
    // -----------------------------------------------------

    registerRenderer( spec, ipcRenderer) {
        spec.crypto = {}

        spec.crypto.randomBytes = ipcCallSync('crypto-randomBytes',ipcRenderer)
        spec.crypto.createHash = ipcCallSync('crypto-createHash',ipcRenderer)
        spec.crypto.generateKeyPairSync = ipcCallSync('crypto-generateKeyPairSync',ipcRenderer)

        spec.crypto.hash = {}
        spec.crypto.hash.copy = ipcCallSync('crypto-hash-copy',ipcRenderer)
        spec.crypto.hash.update = ipcCallSync('crypto-hash-update',ipcRenderer)
        spec.crypto.hash.digest = ipcCallSync('crypto-hash-digest',ipcRenderer)

        spec.registerFeatures( [
            'crypto','crypto.randomBytes','crypto.createHash','crypto.generateKeyPairSync', 'crypto.hash'
        ] )


    }

}

module.exports = CryptoFeature