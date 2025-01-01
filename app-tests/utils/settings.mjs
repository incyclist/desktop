import path, {dirname} from 'path'
import { fileURLToPath } from 'url';
import fs from 'fs'
import os from 'os'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const prepareSettings = (key) => {

    console.log('Dir',__dirname)
    const fName = path.join(__dirname,`../settings/${key}/settings.json`)    

    const target = path.join(os.tmpdir(), 'settings.json')

    if (target && fs.existsSync(target))
        fs.unlinkSync(target)  

    fs.copyFileSync(fName,target)
    process.env.SETTINGS_FILE = target


    return target
}