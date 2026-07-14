const WinrtBindings = require('./bleserver-binding')

const deferred = () => {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

const newBinding = () => {
    const binding = new WinrtBindings('./test/out', { bleServerDebug: false })
    // normally populated by init(), which spawns the native process — set up manually for unit tests
    binding._deviceMap = {}
    binding._requestId = 0
    binding._requests = {}
    binding._subscriptions = {}
    return binding
}

// ── discoverServices / discoverCharacteristics coalescing + caching ────────────

describe('WinrtBindings — discoverServices coalescing & caching', () => {

    let binding

    beforeEach(() => {
        binding = newBinding()
        binding._deviceMap['AA:BB'] = 'device-handle'
    })

    test('concurrent discoverServices calls for the same address share one round-trip', async () => {
        const pending = deferred()
        jest.spyOn(binding, '_sendRequest').mockReturnValue(pending.promise)

        binding.discoverServices('AA:BB')
        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        expect(binding._sendRequest).toHaveBeenCalledTimes(1)
    })

    test('both concurrent callers receive the discovered services', async () => {
        const pending = deferred()
        jest.spyOn(binding, '_sendRequest').mockReturnValue(pending.promise)
        const events = []
        binding.on('servicesDiscover', (address, services) => events.push(services))

        binding.discoverServices('AA:BB')
        binding.discoverServices('AA:BB')

        pending.resolve(['{1800}', '{1801}'])
        await new Promise(r => setImmediate(r))

        expect(events).toHaveLength(2)
        expect(events[0]).toEqual(['1800', '1801'])
        expect(events[1]).toEqual(['1800', '1801'])
    })

    test('a later discoverServices call reuses the cached result — no second round-trip', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValue(['{1800}'])

        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        expect(binding._sendRequest).toHaveBeenCalledTimes(1)
    })

    test('filters are applied per-call against the shared cached result', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValue(['{1800}', '{1801}'])
        const events = []
        binding.on('servicesDiscover', (address, services) => events.push(services))

        binding.discoverServices('AA:BB', ['1800'])
        await new Promise(r => setImmediate(r))

        expect(events[0]).toEqual(['1800'])
    })

    test('disconnect() clears the cache so a subsequent discoverServices triggers a new round-trip', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValue(['{1800}'])
        const servicesCalls = () => binding._sendRequest.mock.calls.filter(([msg]) => msg.cmd === 'services').length

        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))
        expect(servicesCalls()).toBe(1)

        binding.disconnect('AA:BB')
        await new Promise(r => setImmediate(r))

        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        expect(servicesCalls()).toBe(2)
    })

    test('a failed round-trip is not cached — next call retries', async () => {
        jest.spyOn(binding, '_sendRequest').mockRejectedValueOnce(new Error('busy'))
        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        binding._sendRequest.mockResolvedValueOnce(['{1800}'])
        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        expect(binding._sendRequest).toHaveBeenCalledTimes(2)
    })

    test('an empty result (WinRT busy) is not cached — next call retries instead of getting stuck', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValueOnce([])
        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        binding._sendRequest.mockResolvedValueOnce(['{1800}'])
        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        expect(binding._sendRequest).toHaveBeenCalledTimes(2)
    })

    test('once a non-empty result is cached, no later round-trip can ever overwrite it with an empty one', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValue(['{1800}'])
        const events = []
        binding.on('servicesDiscover', (address, services) => events.push(services))

        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        // even if the mock were to start returning [] from here on, it can never be
        // reached again — the cached non-empty result is served forever until disconnect
        binding._sendRequest.mockResolvedValue([])
        binding.discoverServices('AA:BB')
        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))

        expect(binding._sendRequest).toHaveBeenCalledTimes(1)
        expect(events.every(services => services.length > 0)).toBe(true)
    })

})

describe('WinrtBindings — discoverCharacteristics coalescing & caching', () => {

    let binding

    beforeEach(() => {
        binding = newBinding()
        binding._deviceMap['AA:BB'] = 'device-handle'
    })

    const rawChar = { uuid: '{2a37}', properties: { notify: true, read: false } }

    test('concurrent discoverCharacteristics calls for the same address+service share one round-trip', async () => {
        const pending = deferred()
        jest.spyOn(binding, '_sendRequest').mockReturnValue(pending.promise)

        binding.discoverCharacteristics('AA:BB', '180d')
        binding.discoverCharacteristics('AA:BB', '180d')
        await new Promise(r => setImmediate(r))

        expect(binding._sendRequest).toHaveBeenCalledTimes(1)
    })

    test('different services for the same address run concurrently, not queued behind each other', async () => {
        const first = deferred()
        jest.spyOn(binding, '_sendRequest')
            .mockReturnValueOnce(first.promise) // '180d' — left pending on purpose
            .mockResolvedValueOnce([rawChar])   // '1818'

        binding.discoverCharacteristics('AA:BB', '180d')
        binding.discoverCharacteristics('AA:BB', '1818')
        await new Promise(r => setImmediate(r))

        // both round-trips fire immediately, in parallel — WinRT handles these as
        // independent async operations; the still-pending '180d' request must not
        // block '1818' from being sent
        expect(binding._sendRequest).toHaveBeenCalledTimes(2)

        first.resolve([rawChar])
    })

    test('emits mapped characteristics to all concurrent callers', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValue([rawChar])
        const events = []
        binding.on('characteristicsDiscover', (address, service, chars) => events.push(chars))

        binding.discoverCharacteristics('AA:BB', '180d')
        binding.discoverCharacteristics('AA:BB', '180d')
        await new Promise(r => setImmediate(r))

        expect(events).toHaveLength(2)
        expect(events[0]).toEqual([{ uuid: '2a37', properties: ['notify'] }])
    })

    test('an empty result (busy service) is not cached — next call retries instead of getting stuck', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValueOnce([])
        binding.discoverCharacteristics('AA:BB', '180d')
        await new Promise(r => setImmediate(r))

        binding._sendRequest.mockResolvedValueOnce([rawChar])
        binding.discoverCharacteristics('AA:BB', '180d')
        await new Promise(r => setImmediate(r))

        expect(binding._sendRequest).toHaveBeenCalledTimes(2)
    })

    test('once a non-empty result is cached, no later round-trip can ever overwrite it with an empty one', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValue([rawChar])
        const events = []
        binding.on('characteristicsDiscover', (address, service, chars) => events.push(chars))

        binding.discoverCharacteristics('AA:BB', '180d')
        await new Promise(r => setImmediate(r))

        binding._sendRequest.mockResolvedValue([])
        binding.discoverCharacteristics('AA:BB', '180d')
        binding.discoverCharacteristics('AA:BB', '180d')
        await new Promise(r => setImmediate(r))

        expect(binding._sendRequest).toHaveBeenCalledTimes(1)
        expect(events.every(chars => chars.length > 0)).toBe(true)
    })

    test('disconnect clears characteristics cache for the address', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValue([rawChar])
        const charCalls = () => binding._sendRequest.mock.calls.filter(([msg]) => msg.cmd === 'characteristics').length

        binding.discoverCharacteristics('AA:BB', '180d')
        await new Promise(r => setImmediate(r))
        expect(charCalls()).toBe(1)

        binding.disconnect('AA:BB')
        await new Promise(r => setImmediate(r))

        binding.discoverCharacteristics('AA:BB', '180d')
        await new Promise(r => setImmediate(r))

        expect(charCalls()).toBe(2)
    })

})

// ── mixed GATT operations for the same address run concurrently, not queued ───
// WinRT handles concurrent async GATT operations against the same device fine —
// the app deliberately fires multiple commands (e.g. characteristics discovery
// for several services) in parallel. Only identical/duplicate requests are
// coalesced (see the caching describe blocks above); nothing here serializes
// across different operations or keys.

describe('WinrtBindings — GATT operations for the same address run concurrently', () => {

    let binding

    beforeEach(() => {
        binding = newBinding()
        binding._deviceMap['AA:BB'] = 'device-handle'
    })

    test('read fires immediately alongside a still in-flight discoverServices for the same address', async () => {
        const pending = deferred()
        jest.spyOn(binding, '_sendRequest')
            .mockReturnValueOnce(pending.promise) // discoverServices — left pending
            .mockResolvedValueOnce(Buffer.from('ok')) // read

        binding.discoverServices('AA:BB')
        binding.read('AA:BB', '180d', '2a37')

        await Promise.resolve()
        // both round-trips are sent right away — read must not wait behind discoverServices
        expect(binding._sendRequest).toHaveBeenCalledTimes(2)

        pending.resolve(['{1800}'])
    })

    test('disconnect() fires immediately alongside a still in-flight GATT op for the same address', async () => {
        const pending = deferred()
        jest.spyOn(binding, '_sendRequest')
            .mockReturnValueOnce(pending.promise) // discoverCharacteristics — left pending
            .mockResolvedValueOnce('device-handle') // disconnect

        binding.discoverCharacteristics('AA:BB', '180d')
        binding.disconnect('AA:BB')

        await Promise.resolve()
        // disconnect does not wait behind the in-flight characteristics discovery
        expect(binding._sendRequest).toHaveBeenCalledTimes(2)

        pending.resolve([])
    })

})

// ── processDisconnectEvent clears caches on a physical disconnect ──────────────

describe('WinrtBindings — processDisconnectEvent cache invalidation', () => {

    let binding

    beforeEach(() => {
        binding = newBinding()
        binding._deviceMap['AA:BB'] = 'device-handle'
        binding._requests = {}
    })

    test('an unsolicited disconnect clears the services cache for that address', async () => {
        jest.spyOn(binding, '_sendRequest').mockResolvedValue(['{1800}'])
        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))
        expect(binding._sendRequest).toHaveBeenCalledTimes(1)

        binding.processDisconnectEvent({ device: 'device-handle' })

        binding.discoverServices('AA:BB')
        await new Promise(r => setImmediate(r))
        expect(binding._sendRequest).toHaveBeenCalledTimes(2)
    })

})

describe('WinrtBindings — write', () => {

    let binding

    beforeEach(() => {
        binding = newBinding()
        binding._deviceMap['AA:BB'] = 'device-handle'
    })

    test('write fires immediately alongside a still in-flight GATT op for the same address', async () => {
        const pending = deferred()
        jest.spyOn(binding, '_sendRequest')
            .mockReturnValueOnce(pending.promise) // discoverServices — left pending
            .mockResolvedValueOnce('write-result')

        binding.discoverServices('AA:BB')
        const writePromise = binding.write('AA:BB', '180d', '2a37', Buffer.from([1]), false)

        await Promise.resolve()
        // write does not wait behind the in-flight discoverServices call
        expect(binding._sendRequest).toHaveBeenCalledTimes(2)

        pending.resolve(['{1800}'])
        await writePromise
    })

})
