import { test, expect } from '@playwright/test';
import { _electron } from 'playwright';
import { prepareSettings } from './utils/settings.mjs';
import fs from 'fs'

let electronApp
let settings

test.skip('App Launches', async () => {

    console.log('#### App Launches ####')

    test.setTimeout(50000)
    settings = prepareSettings('new-user')

    electronApp = await _electron.launch({
        args: ['./'],
        recordVideo: {dir: 'test-results/videos'}    
    });


  // Evaluation expression in the Electron context.
    await electronApp.evaluate(async ({ app }) => {
        // This runs in the main Electron process, parameter here is always
        // the result of the require('electron') in the main app script.
        return app.getAppPath();
    });
    electronApp.on('console', console.log)

    // Get the first window that the app opens, wait if necessary.
    const loading = await electronApp.firstWindow();
    const loadingTitle = await loading.title();
    expect(loadingTitle).toBe('Incyclist');

    // wait for loading window to close
    await new Promise( (done)=> {
      loading.on('close',done)  
    })

    // get main window  
    const mainWindow = electronApp.windows()[0]
    const mainTitle = await mainWindow.title();
    expect(mainTitle).toBe('Incyclist');   
});

test.afterAll(async () => {
    if (electronApp)
        await electronApp.close();
    console.log('#### App Launches Done ####')

});
