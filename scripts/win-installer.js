const installer = require('electron-installer-windows');
const fs = require('fs');
const path = require('path');
__dirname = path.join(__dirname,'..')

console.log(__dirname)
let argv = process.argv.slice(2);
const options = require( path.join(__dirname,argv[0]));
const package = require( path.join(__dirname,'./package.json'));

if (options.debug) {
    options.logger = console.log
}

async function main (options) {

    console.log('Creating installer (this may take a while)...')

    try {
        await installer(options)
        console.log(`Successfully created package at ${options.dest}`)
    } catch (err) {
        console.error(err, err.stack)
        process.exit(1)
    }
}

main(options)