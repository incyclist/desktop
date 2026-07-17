# CI Build Workflows

This is maintainer-facing reference for the GitHub Actions build workflows in
`.github/workflows/`. It's deliberately kept out of `README.MD` — none of this
is needed to build or contribute to the app day to day, it's only relevant
when you're touching release infrastructure or renewing a certificate.

Covers: `linux-build.yml`, `mac-build.yml`, `win-build.yml`. (`apptest.yaml`
runs Playwright e2e tests and isn't part of the release pipeline — see the
main `CLAUDE.md` note that those tests aren't part of the regular workflow.)

## Common shape

All three build workflows trigger on:
- **`release: types: [created]`** — runs automatically when a GitHub Release is created
- **`workflow_dispatch`** — manual trigger from the Actions tab, for testing a branch before cutting a release

Each writes `config/settings.json` from the `SETTINGS_FILE` repo secret before
building (this is the app's runtime settings file, unrelated to signing).

## How signing routing works

`forge.config.js` at the repo root picks a platform-specific config file based
on OS and the `BUILD_TARGET` env var:

```js
if (platform==='win32' && process.env.BUILD_TARGET==='dist')
  config = require('./config/forge.config.windows')       // signed
else if (platform==='win32')
  config = require('./config/forge.config.windows.unsigned') // unsigned
else if (platform==='darwin')
  config = require(`./config/forge.config.darwin.${process.env.BUILD_TARGET ?? 'unsigned'}`)
  // BUILD_TARGET=incyclist -> signed+notarized, unset -> forge.config.darwin.unsigned.js
```

Both workflows now default to **unsigned** builds and only flip `BUILD_TARGET`
when you explicitly ask for a signed build via a `workflow_dispatch` input.
Nothing about signing happens on a `release`-triggered run unless you've
changed that — see "Turning signing on for a release" below if you want that.

---

## Windows (`win-build.yml`)

**Toggle:** `sign_windows` (workflow_dispatch input, boolean, default `false`).

**When on**, the workflow:
1. Decodes the `CERT_WINDOWS` secret (base64 `.pfx`) to `certs\installer.pfx`
2. Sets `BUILD_TARGET=dist`, routing to `config/forge.config.windows.js`, which
   passes `certificateFile`/`certificatePassword` to `@electron-forge/maker-squirrel`

**Secrets required for signing:**
| Secret | What it is |
|---|---|
| `CERT_WINDOWS` | base64-encoded `.pfx` code-signing certificate |
| `CERTIFICATE_PASSWORD` | password for that `.pfx` |

**Runner is pinned to `windows-2022`**, not `windows-latest`. This matters:
`windows-latest` migrated from Windows Server 2022 (VS2022) to Windows Server
2025 (VS2026) in June 2026, and the bundled `@electron/node-gyp` (via
`@electron/rebuild`) couldn't detect VS2026 installations at all
([nodejs/node-gyp#3282](https://github.com/nodejs/node-gyp/issues/3282)),
breaking native module rebuilds (`@stoprocent/bluetooth-hci-socket`, etc.)
with "Could not find any Visual Studio installation to use". If native builds
start failing again after this pin, check whether that upstream issue has
been resolved and whether a newer `windows-*` label is now safe to move to.

**Known gotcha already fixed, in case it resurfaces:** `@electron-forge/maker-squirrel`
spreads its `config` object straight into `electron-winstaller`, whose
`sanitizeAuthors()` calls `.replace()` directly on `authors` — it must be a
**string** (`"Guido Doumen, Jeroen Doumen"`), not an array. An array throws
`TypeError: authors.replace is not a function` at the packaging step.

---

## Mac (`mac-build.yml`)

**Toggle:** `sign_mac` (workflow_dispatch input, boolean, default `false`).

**When on**, the workflow imports certificates into a temporary CI keychain,
writes the provisioning profile, sets `BUILD_TARGET=incyclist` (routing to
`config/forge.config.darwin.incyclist.js`), and runs `npm run make`.

**Two separate certificates are needed** — macOS signing tools enforce this,
they are not interchangeable:
- **Developer ID Application** — signs the `.app` bundle itself (used for the
  `.dmg`/`.zip` outputs). This is what `codesign` requires.
- **Developer ID Installer** — signs the `.pkg` installer. This is what
  `productsign`/`productbuild` requires. Using the wrong cert type for either
  fails outright, it doesn't degrade gracefully.

**Secrets required for signing:**
| Secret | What it is |
|---|---|
| `CERT_MAC` | base64-encoded `.p12`, exported from the **Developer ID Application** cert |
| `CERTIFICATE_PASSWORD_MAC` | password chosen when exporting that `.p12` |
| `CERT_MAC_INSTALLER` | base64-encoded `.p12`, exported from the **Developer ID Installer** cert |
| `CERTIFICATE_PASSWORD_MAC_INSTALLER` | password chosen when exporting that `.p12` |
| `PROVISION_PROFILE_MAC` | base64-encoded `.provisionprofile` file |
| `APPLE_DEVELOPER` | name embedded in both certs' identity string, e.g. `Guido Doumen` — must match exactly or `codesign`/`productsign` can't find the identity even though it imported fine |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_PASSWORD` | app-specific password for that Apple ID (generate at [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords) |

### Exporting a certificate as `.p12` (when you need to rotate)

Apple's Developer portal only ever gives you the public certificate — the
private key never leaves the Mac it was generated on. To get a usable `.p12`
(cert + private key together), use Keychain Access on that Mac:

1. Keychain Access → **login** keychain → **"My Certificates"** category
   specifically (not "Certificates" — that view can omit the private key)
2. Expand the certificate (disclosure triangle) — confirm a private key is
   nested underneath. No key nested means it's not exportable from this Mac.
3. Right-click → **Export "\<cert name\>"...** → format **Personal Information
   Exchange (.p12)**
4. It'll ask for your macOS login password (to release the key from the
   keychain) and then a **new password you choose right there** to encrypt the
   `.p12` — that's the one that goes into the `CERTIFICATE_PASSWORD_MAC*` secret.
   It's not something you'd have set previously; it's chosen fresh at export time.
5. Repeat separately for the Installer certificate — two distinct `.p12` files.

Then, in Terminal:
```bash
base64 -i DeveloperIDApplication.p12 | pbcopy   # paste into CERT_MAC
base64 -i DeveloperIDInstaller.p12 | pbcopy     # paste into CERT_MAC_INSTALLER
```

### Certificate expiration

As of mid-2026, both Mac certs expire **2027-02-01**. Note: expiration does
**not** retroactively break apps already distributed — `codesign` uses a
secure timestamp by default, so Gatekeeper validates against the cert's
validity *at the time of signing*, not the current date. What breaks after
expiration is the ability to produce *new* signed builds. Rotate before then
by generating fresh certs in the Apple Developer portal and repeating the
export steps above; no urgency otherwise.

**Runner uses `macos-latest`** (not pinned, unlike Windows). This carries the
same kind of image-drift risk that bit the Windows build — Xcode/toolchain
version bumps happening silently underneath you. Not pinned as of this
writing since it hasn't caused a problem yet; if a Mac build starts failing
for no code-related reason, check whether `macos-latest` moved to a new Xcode
version first, and consider pinning to a specific `macos-14`/`macos-15` label
the same way Windows is pinned to `windows-2022`.

---

## Testing an unsigned build without touching your main machine

If you dual-boot or otherwise don't want to reboot into Windows just to test
an installer: a disposable VM with disk snapshots works well for this. If
using libvirt/KVM with a qcow2 disk, snapshot before testing and revert after:

```bash
virsh snapshot-create-as <vm-name> clean-baseline --description "Before testing a build"
# ... test the installer ...
virsh shutdown <vm-name>
virsh snapshot-revert <vm-name> clean-baseline
```

Keep the snapshot around rather than deleting it — reverting to an existing
snapshot is instant, and you'll likely want to test the next build the same
way.

## Verifying a signed Mac build

A clean install + launch with no Gatekeeper warning ("unidentified
developer" / "app is damaged") is the real end-to-end signal that signing and
notarization worked — that's the actual experience your users will have.
Note that Gatekeeper's check happens at **first launch**, not at copy/install
time, so make sure to actually open the app, not just verify it copied to
`/Applications`. Testing the `.pkg` too exercises the Installer cert the same
way.

The one thing a normal launch test won't catch: if notarization was approved
by Apple but the ticket wasn't *stapled* to the binary, a networked Mac still
opens it fine (macOS falls back to an online check), but a machine offline at
first launch would reject it. Only worth checking if you expect users
installing without network access:

```bash
codesign --verify --deep --strict --verbose=2 /path/to/Incyclist.app
spctl --assess --type execute --verbose /path/to/Incyclist.app
xcrun stapler validate /path/to/Incyclist.app
```
