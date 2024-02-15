const { Channel} = require("incyclist-ant-plus");

class AntIpcBinding /*implements IAntDevice*/ {
    static _instance
    static api

    static getInstance() {
        if (!AntIpcBinding._instance)
            AntIpcBinding._instance = new AntIpcBinding()
        return AntIpcBinding._instance
    }

    static init ( api) {
        AntIpcBinding.api = api;
    }

    constructor(props={}) {
        const {deviceNo,debug,logger, startupTimeout} = props
        const loggerName = logger && logger.getName ? logger.getName() : undefined

        this.channels = []

        this.api = AntIpcBinding.api
        this.api.getInstance({deviceNo,debug,loggerName, startupTimeout})       
        this.api.onMessage( (channelNo,data) => this.onChannelMessage(channelNo,data) )
    }

    async open() {        
        return await this.api.open()        
    }

    async close(){
        return await this.api.close()
    }

    getMaxChannels() {
        return this.api.getMaxChannels()
    }

    getChannel() {
        const channelNo = this.api.getChannel()
        if (channelNo===undefined)
            return;

        const channel = new Channel(channelNo,this) 
        this.channels.push( {channelNo, channel})

        return channel
    }

    

    freeChannel(channel) {
        const channelNo = channel.getChannelNo()
        if (channelNo!==undefined) {
            this.api.freeChannel(channelNo)
        }

        const idx = this.channels.findIndex( c => c.channelNo===channelNo)
        if (idx!==-1)
            this.channels.splice(idx,1)
    }

    getDeviceNumber() {
        return this.api.getDeviceNumber();
    }


    write(data) {
        if (!data)
            return;
        //this.api.write(data);
        this.api.write(data.toString('hex'));
    }

    onChannelMessage(channelNo, hexstr) {
        const data = Buffer.from(hexstr,'hex')
        const channelInfo = this.channels.find( c => c.channelNo===channelNo)
        if (channelInfo) {
            const {channel} = channelInfo
            channel.onMessage(data)
        }
        
    }

}


module.exports = AntIpcBinding