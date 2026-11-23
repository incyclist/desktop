/** (vii): OS firewall prompts can only be observed by a person on each OS. */
const CHECKLIST = [
    'Windows: first listen after a fresh install -> record whether the Defender Firewall prompt appears (once for both listeners? which executable?)',
    'Windows: after the user clicked Allow, restart: no second prompt; change the control port (occupy it): record whether a changed port prompts again',
    'Windows: install an app UPDATE (new Squirrel version folder) while a phone is paired, start it: record whether the prompt reappears at launch with no user click',
    'Windows: network profile set to Public: confirm the phone is blocked and note what, if anything, the desktop can observe',
    'macOS: with the system firewall on: record the "accept incoming connections" prompt, and whether the second listener or a changed port prompts again',
    'Linux: record the distro firewall behaviour (ufw/firewalld default: typically no prompt, but inbound may be blocked)',
]

async function run(ctx) {
    ctx.reporter.group('(vii)', 'OS firewall prompts (observation, not automatable)')
    CHECKLIST.forEach((text, i) => ctx.reporter.record(String(i + 1), text, 'MANUAL'))
}

module.exports = { run }
