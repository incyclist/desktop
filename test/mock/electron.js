const ipcRenderer = {
    on: jest.fn()
};
const ipcMain = {
    on: jest.fn()
};
const app = {
    getPath: jest.fn( ()=> './test/out')
}

module.exports = {ipcRenderer,ipcMain,app}