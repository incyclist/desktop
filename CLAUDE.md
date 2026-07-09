# Desktop (Electron Shell)

This is the Electron main-process shell for the Incyclist app. It loads the `web-ui` renderer bundle and bridges the renderer to native platform capabilities (ANT+, BLE, Serial, File System, etc.) via IPC.

## Key Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start in debug mode — picks up web-ui from `settings.json` (local bundle or remote URL) |
| `npm start` | Start in production mode |
| `npm test` | Run unit tests (Jest) — run this after every change |
| `npm run coverage` | Generate test coverage report |
| `npm run make-linux` | Build Linux AppImage (x64) |
| `npm run make-linux-arm` | Build Linux AppImage (ARM64) |
| `npm run make-windows-dist` | Build Windows installer |
| `npm run make-mac-dist` | Build macOS distribution |

Integration tests (`npm run test:integration`) and Playwright e2e tests (`npm run app-test`) are not maintained as part of the regular workflow — leave them alone.

## Development Workflow

- After any code change: run `npm test`
- To verify Electron-feature bindings (dialog boxes, OS interactions): run `npm run dev` — no additional setup needed, `settings.json` controls where the renderer bundle comes from

## Language

**JavaScript only.** Do not introduce TypeScript files. TypeScript migration is a future task that requires its own build infrastructure (tsconfig, compile step, ts-jest). Until that task is started, all new code must be `.js`.

## Directory Map

```
src/
├── main.js          # Electron entry point
├── app.js           # App lifecycle (IncyclistApp class)
├── features/        # Bindings — Electron implementations of platform capabilities
│   ├── utils/       # IPC utility functions (always use these, never raw IPC)
│   │   ├── index.js     # Core IPC helpers
│   │   └── observer.js  # Observer-pattern IPC helpers
│   ├── base.js      # Feature base class
│   └── index.js     # Feature registration (initFeaturesApp + initFeaturesWeb)
├── web/             # Window management and preload scripts
│   ├── manager.js   # WindowManager
│   ├── pages/       # BrowserWindow subclasses (main, loading, oauth)
│   └── api.js       # Renderer-side API initialisation — calls initFeaturesWeb
└── modules/         # AutoUpdate, logging adapters, zip utilities
build/               # ⚠ Generated — never edit (web-ui bundle, used only during packaging)
config/              # Build and packaging configuration
```

## Features = Bindings

The workspace CLAUDE.md describes platform capabilities as **bindings** (e.g. `fs`, `ble`, `ant`, `serial`). In this repo, those Electron implementations live in `src/features/` and are called **features**. The two terms mean the same thing. Naming harmonisation is planned for the future.

Each feature:
- Runs in the **main process** (full Node.js and native access)
- Exposes its API to the **renderer** via Electron IPC
- Is registered explicitly in `src/features/index.js`

## Adding a New Feature

### 1. Create the feature class

Create `src/features/<name>/feature.js`. Extend `Feature` and use the singleton pattern. The example below shows all IPC variants — use only the ones your feature needs.

```javascript
const { ipcMain } = require('electron')
const {
    ipcHandle, ipcHandleSync, ipcHandleNoResponse,
    ipcCall, ipcCallSync, ipcCallNoResponse,
    ipcRegisterBroadcast, ipcSendEvent
} = require('../utils')
const Feature = require('../base')

class MyFeature extends Feature {
    static _instance

    static getInstance() {
        if (!MyFeature._instance)
            MyFeature._instance = new MyFeature()
        return MyFeature._instance
    }

    // --- implementation methods (tested directly in unit tests) ---

    async myAsync(arg) { /* ... */ return result }

    mySync(arg) { /* ... */ return result }

    fireAndForget(arg) { /* ... */ }

    // Call this from inside the feature whenever you need to push an event to the renderer
    notifyRenderer(data) {
        ipcSendEvent('myfeature-event', data)
    }

    // --- IPC wiring ---

    register(_props) {
        ipcHandle('myfeature-async',         this.myAsync.bind(this),       ipcMain)
        ipcHandleSync('myfeature-sync',      this.mySync.bind(this),        ipcMain)
        ipcHandleNoResponse('myfeature-fire', this.fireAndForget.bind(this), ipcMain)
    }

    registerRenderer(spec, ipcRenderer) {
        spec.myfeature = {}

        spec.myfeature.async = ipcCall('myfeature-async',          ipcRenderer)  // returns Promise
        spec.myfeature.sync  = ipcCallSync('myfeature-sync',       ipcRenderer)  // returns value
        spec.myfeature.fire  = ipcCallNoResponse('myfeature-fire', ipcRenderer)  // no return

        // EventEmitter: renderer subscribes via spec.myfeature.onMessage(callback)
        ipcRegisterBroadcast(spec.myfeature, 'myfeature-event', ipcRenderer)

        // Announce capabilities to the web-ui (see Capability Announcements below)
        spec.registerFeatures(['myfeature'])
    }
}

module.exports = MyFeature
```

### 2. Register in `src/features/index.js`

```javascript
const MyFeature = require('./myfeature/feature').getInstance()

function initFeaturesApp(props) {
    // ... existing registrations ...
    MyFeature.register(props)
}

function initFeaturesWeb(electron, ipcRenderer) {
    // ... existing registrations ...
    MyFeature.registerRenderer(electron, ipcRenderer)
}
```

## IPC Pattern Reference

All IPC must use the utility wrappers from `src/features/utils/index.js` (and `utils/observer.js` for the Observer pattern). **Never use raw `ipcMain.on()` / `ipcRenderer.send()` directly.** The only legacy raw calls are in `src/features/ble/index.js` — do not copy that pattern.

### Async (request → response)

```javascript
// Main process (register)
ipcHandle('key', async (...args) => result, ipcMain)

// Renderer (registerRenderer)
spec.x.method = ipcCall('key', ipcRenderer)   // returns Promise
```

### Sync (blocking)

```javascript
// Main process
ipcHandleSync('key', (...args) => result, ipcMain)

// Renderer
spec.x.method = ipcCallSync('key', ipcRenderer)   // returns value directly
```

### Fire-and-forget (no response)

```javascript
// Main process
ipcHandleNoResponse('key', (...args) => { /* ... */ }, ipcMain)

// Renderer
spec.x.method = ipcCallNoResponse('key', ipcRenderer)
```

### EventEmitter (main → renderer push)

Use when the feature needs to push events to the renderer unprompted (not in response to a call).

```javascript
// Main process: call ipcSendEvent whenever the feature wants to notify the renderer
ipcSendEvent('feature-eventname', ...args)

// Renderer (registerRenderer)
ipcRegisterBroadcast(spec.myfeature, 'feature-eventname', ipcRenderer)
// Exposes: spec.myfeature.onMessage(callback) and spec.myfeature.stopListening()
```

### Observer (long-running operation with typed progress events)

Use when a single call kicks off a long-running async operation that emits multiple typed events over time (e.g. video conversion progress). The main process returns an observer object; the renderer receives an `EventEmitter`-like `Observer` it can subscribe to.

```javascript
// Main process
const { ipcHandleObserver } = require('../utils/observer')

ipcHandleObserver('key', (...args) => observerInstance, ipcMain)
// observerInstance must implement .getMessageKey() and push events via ipcSendEvent

// Renderer
const { ipcCallObserver } = require('../utils/observer')

spec.x.longOp = ipcCallObserver('key', ipcRenderer)
// Returns an Observer (EventEmitter) — caller does: const obs = await spec.x.longOp(...); obs.on('progress', cb)
```

Reference implementation: `src/features/VideoScheme/VideoScheme.js`

## Capability Announcements

Every `registerRenderer` must call `spec.registerFeatures([...])` with the capability names this feature provides. The web-ui uses `electron.hasFeature('name')` to adapt its behaviour for the installed desktop version, which may be ahead of or behind the renderer bundle.

Rules:
- **Always call `spec.registerFeatures`** in every new feature's `registerRenderer`
- **Add a new name** when you add new functionality to an existing feature
- **Never remove or rename** existing capability names — older renderer bundles may depend on them

```javascript
// Initial release of a feature
spec.registerFeatures(['myfeature'])

// After adding new methods in a later release
spec.registerFeatures(['myfeature', 'myfeature-v2'])
```

## Testing

- Run `npm test` after every change
- Test the **feature implementation class** directly — assume the IPC layer works
- Mock native dependencies (hardware, file system) and test the business logic of the feature methods
- New features must have good unit test coverage
- Do not write tests that cover IPC routing (`ipcHandle`/`ipcCall` wiring) — that layer is assumed correct
- Integration tests (`npm run test:integration`) and Playwright e2e tests (`npm run app-test`) are not part of the regular development workflow

## Electron Security Configuration

`src/web/pages/main.js` sets `nodeIntegration: true` and `contextIsolation: false`. This is a legacy configuration. Do not change it proactively — a dedicated security binding replacement task will address it.

## Dependency Updates

When updating dependencies (including Electron itself):
1. Read the release notes for breaking changes
2. Identify which parts of this codebase are affected
3. Apply necessary code changes
4. Validate with a full app launch via `npm run dev`
