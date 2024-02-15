const secrets = require('../secrets.json')

const getSecret = (key) => secrets[key];


module.exports =  {
    getSecret
}