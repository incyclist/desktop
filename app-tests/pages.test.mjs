import { test, expect } from '@playwright/test';
import { _electron } from 'playwright';
import { prepareSettings } from './utils/settings.mjs';

let electronApp
let settings

test('Navigate Pages', async () => {

    let mainWindow
    test.setTimeout(50000)
    settings = prepareSettings('default')


    await test.step('Launch App', async () => {
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
        await loading.screenshot()
        expect(loadingTitle).toBe('Incyclist');
    
        // wait for loading window to close
        await new Promise( (done)=> {
          loading.on('close',done)  
        })
    
        // get main window  
        mainWindow = electronApp.windows()[0]
        const mainTitle = await mainWindow.title();
        expect(mainTitle).toBe('Incyclist');
    
    })

    await test.step('Pairing page', async () => { 
        await expect(mainWindow.getByText('Paired Devices')).toBeVisible()
        await mainWindow.screenshot()
    
    })
  
    await test.step('main page', async () => { 
        mainWindow.getByText('Skip').click()
        await mainWindow.screenshot()
    })


    await test.step('Search page', async () => { 
        mainWindow.getByText('Search').click()
        await expect(mainWindow.getByText('Search')).toBeVisible()
        await mainWindow.screenshot()
    })

    await test.step('Workouts page', async () => { 
        mainWindow.getByText('Workouts').click()
        await expect(mainWindow.getByText('Workouts')).toBeVisible()
        await mainWindow.screenshot()
    })

    await test.step('Activities page', async () => { 
        mainWindow.getByText('Activities').click()
        await expect(mainWindow.getByText('Activities')).toBeVisible()
        await mainWindow.screenshot()
    })

    await test.step('Routes page', async () => { 
        mainWindow.getByText('Routes').click()
        await expect(mainWindow.getByText('Routes')).toBeVisible()
        await mainWindow.screenshot()
    })



});

test.afterAll(async () => {
    if (electronApp)
        await electronApp.close();
});
