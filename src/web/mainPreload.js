const {electron} =  require('./api')


window.api = electron;
window.electron = electron  

let canClose = false
window.addEventListener('beforeunload', (e)=>{
    console.log('# before unload')

    if (!canClose)
        e.preventDefault()
    
    

    if (window.electron?.ant?.close) {

        window.electron?.ant?.close().then( ()=> {
            canClose = true;
            window.close()

        })
        .catch( ()=>{
            canClose = true;
            window.close()

        })

    }
    else {
        process.nextTick( ()=>{
            canClose = true;
            window.close()
        })
    }

    
})
