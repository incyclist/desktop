/**
 * pauses the execution for a given time
 *
 * @param {number}  ms - the time (in ms) to be paused
 */
const sleep = async (ms) => new Promise( resolve => setTimeout(resolve,ms))

module.exports = {
    sleep
}