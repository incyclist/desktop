#!/usr/bin/env node
/**
 * Dev-only integration check of the local-link transport: a scripted "phone" speaks the wire
 * protocol (TCP control channel + HTTP media) against a running computer, or against the real
 * desktop transport hosted in-process (--self-host). Not part of `npm test`.
 *
 *   npm run g1 -- --self-host                 fully automatic, no Electron needed
 *   npm run g1 -- --host 192.168.1.10 --control-port 5555 --pin 123456
 *   npm run g1                                full app: discover via mDNS, prompt for steps
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadWire } = require('./lib/loader')
const { Reporter, createPrompter } = require('./lib/harness')
const { Context } = require('./lib/context')

const HELP = `Usage: npm run g1 -- [options]

Target (default: full app, found by mDNS browse for _incyclist._tcp)
  --self-host              host the real desktop transport + services host logic in this process
  --host <ip>              address of the computer under test (with --control-port skips discovery)
  --control-port <port>
  --name <text>            pick the announced computer whose name contains <text>

Pairing in full-app mode
  --pin <6 digits>         code shown in "Connect your phone" (or env G1_PIN, or typed when prompted)
  --pin-file <file>        file that always holds the current code (the code changes with every pair-request)
  --creds <file>           keep credentials of the paired test phone between runs (0600)

Serving a computer for the harness (a stand-in for the full app, e.g. to try full-app mode on one machine)
  --serve                  host the transport in-process, open pairing, print the control port and write the
                           current code to --pin-file; stays up until Ctrl+C

Run control
  --groups <list>          comma separated subset of: i,ii,iii,iv,v,vi,vii (default: all)
  --slow                   include real-time waits (120 s pairing expiry, 60 s idle timeout, rate-limit windows)
  --no-wait                never wait for a human: manual steps are reported as MANUAL
  --keep                   keep the self-host work directory (fixtures, 48 MB)
  --help

Groups: i route serving | ii bidirectional TCP | iii pairing + auth | iv peer filter |
        v start at launch + port reuse | vi mDNS | vii firewall prompts (checklist)
Exit code is 1 when any check FAILs; MANUAL and SKIP do not fail the run.
`

function parseArgs(argv) {
    const opts = { groups: undefined }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        const next = () => argv[++i]
        switch (a) {
            case '--self-host': opts.selfHost = true; break
            case '--host': opts.host = next(); break
            case '--control-port': opts.controlPort = Number(next()); break
            case '--name': opts.name = next(); break
            case '--pin': opts.pin = next(); break
            case '--pin-file': opts.pinFile = next(); break
            case '--serve': opts.serve = true; opts.selfHost = true; break
            case '--creds': opts.creds = next(); break
            case '--groups': opts.groups = next().split(',').map(s => s.trim().toLowerCase()); break
            case '--slow': opts.slow = true; break
            case '--no-wait': opts.noWait = true; break
            case '--keep': opts.keep = true; break
            case '--help': case '-h': opts.help = true; break
            default: throw new Error(`unknown option ${a}`)
        }
    }
    return opts
}

async function serve(host, opts) {
    await host.service.openPairing()
    const status = await host.status()
    console.log(`serving: control port ${status.ports.control}, media port ${status.ports.media}, announced as "${status.announced?.instanceName}"`)
    let last
    host.service.on('pairing-changed', props => {
        const pin = props.connectWindow?.pin
        if (pin && pin !== last) {
            last = pin
            console.log(`pairing code: ${pin}`)
            if (opts.pinFile)
                fs.writeFileSync(opts.pinFile, pin)
        }
    })
    await new Promise(resolve => process.once('SIGINT', resolve))
    await host.dispose()
    fs.rmSync(host.workDir, { recursive: true, force: true })
}

async function main() {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.help) {
        console.log(HELP)
        return 0
    }

    const wire = loadWire()
    const reporter = new Reporter()
    const prompt = createPrompter({ interactive: process.stdin.isTTY === true && !opts.noWait })

    let host
    let workDir
    if (opts.selfHost) {
        const { SelfHost } = require('./lib/self-host')
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incyclist-g1-'))
        console.log(`self-host: real desktop transport + services host logic in-process (work dir ${workDir})`)
        host = new SelfHost({ workDir })
        host.boot()
    }
    else
        console.log('full-app mode: target discovered by mDNS or given with --host/--control-port')

    if (opts.serve) {
        await serve(host, opts)
        return 0
    }

    const ctx = new Context({ wire, reporter, prompt, opts, host })
    const groups = {
        iii: () => require('./groups/pairing').run(ctx),
        ii: () => require('./groups/tcp').run(ctx),
        i: () => require('./groups/routes').run(ctx),
        iv: () => require('./groups/peer-filter').run(ctx),
        vi: () => require('./groups/mdns').run(ctx),
        v: () => require('./groups/startup').run(ctx),
        vii: () => require('./groups/firewall').run(ctx),
    }
    const order = ['iii', 'ii', 'i', 'iv', 'vi', 'v', 'vii']
    const selected = order.filter(g => !opts.groups || opts.groups.includes(g))

    try {
        if (selected.includes('vi'))
            await require('./groups/mdns').pre(ctx)
        for (const g of selected)
            await groups[g]()
    }
    finally {
        ctx.cleanup()
        await host?.dispose()
        if (workDir && !opts.keep)
            fs.rmSync(workDir, { recursive: true, force: true })
    }
    return reporter.summary() > 0 ? 1 : 0
}

main().then(code => process.exit(code), err => {
    console.error(err)
    process.exit(2)
})
