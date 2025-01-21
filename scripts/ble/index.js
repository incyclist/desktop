const readline = require('node:readline');
const {onInit, onConnect,onScan, onStopScan,onDisconnect,onServices,onSubscribe, onCharacteristics} = require('./commands')
const {EventLogger,ConsoleAdapter,FileAdapter}= require('gd-eventlog')

const handlers = {}

handlers['exit'] = ()=>{process.exit()}
handlers['init'] = onInit
handlers['scan'] = onScan
handlers['stopScan'] = onStopScan
handlers['stop'] = onStopScan
handlers['connect'] = onConnect
handlers['disconnect'] = onDisconnect
handlers['services'] = onServices
handlers['characteristics'] = onCharacteristics
handlers['subscribe'] = onSubscribe

handlers['srv'] = onServices
handlers['char'] = onCharacteristics

const nextCommand = () => new Promise ( done=> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
          
      rl.question(`> `, cmd => {  
        rl.close();
        done(cmd)
      });
})

const processCommand = async (input)=>{
    const parts = input?.split(' ')??[]
    const cmd = parts[0]
    parts.splice(0,1)
    const args = parts

    console.log(cmd,args)
    const handler = handlers[cmd]
    if (!handler) 
        printUsage()
    else 
        await handler(...args)
}

const printUsage = () => {
    console.log( 'please enter a valid command or `exit` to close the process')
}

const main = async ()=>{
    
    EventLogger.registerAdapter( new ConsoleAdapter({depth:1}))        

    let cmd = ''
    while (cmd!=='exit') {
        cmd = await nextCommand()
        await processCommand(cmd)
    }
    
}

main()
