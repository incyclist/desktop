const { PeerFilter, peerKey, normalizeAddress, parseCidr, classifyAddress, isPrivateAddress } = require('./peer-filter')

describe('normalizeAddress', () => {
    test('maps IPv4-mapped IPv6 to IPv4', () => {
        expect(normalizeAddress('::ffff:192.168.1.5')).toEqual(normalizeAddress('192.168.1.5'))
        expect(normalizeAddress('::ffff:c0a8:0105')).toEqual(normalizeAddress('192.168.1.5'))
    })
    test('strips zone ids', () => {
        expect(normalizeAddress('fe80::1%en0')).toEqual(normalizeAddress('fe80::1'))
    })
    test.each([undefined, null, '', 'garbage', '999.1.1.1', 42])('rejects %p', (v) => {
        expect(normalizeAddress(v)).toBeUndefined()
    })
})

describe('parseCidr', () => {
    test.each(['10.0.0.0/33', '10.0.0.0/x', 'fe80::/129', 'nonsense', '10.0.0.0/', 42, '::ffff:10.0.0.0/64'])('rejects %p', (c) => {
        expect(parseCidr(c)).toBeUndefined()
    })
    test.each(['10.0.0.0/8', '10.1.2.3', 'fc00::/7', '::ffff:10.0.0.0/104', '0.0.0.0/0'])('accepts %p', (c) => {
        expect(parseCidr(c)).toBeDefined()
    })
})

describe('default policy', () => {
    const filter = new PeerFilter()

    test.each([
        '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.10.10', '127.0.0.1',
        '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'febf::1',
        '::ffff:192.168.1.5', '::ffff:127.0.0.1', '::ffff:c0a8:0105', 'fe80::1%wlan0',
    ])('accepts %s', (addr) => {
        expect(filter.isAllowed(addr)).toBe(true)
    })

    test.each([
        '8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1',
        '2001:db8::1', '2a00::1', 'fe00::1', 'fec0::1', '::', 'ff02::1', '::ffff:8.8.8.8',
        undefined, null, '', 'not-an-address',
    ])('refuses %p', (addr) => {
        expect(filter.isAllowed(addr)).toBe(false)
    })
})

describe('setPeerPolicy', () => {
    test('allow widens the default', () => {
        const f = new PeerFilter()
        expect(f.setPolicy({ defaultPrivate: true, allow: ['100.64.0.0/10'] })).toEqual({ ok: true })
        expect(f.isAllowed('100.100.1.1')).toBe(true)
        expect(f.isAllowed('8.8.8.8')).toBe(false)
    })

    test('deny beats allow and default', () => {
        const f = new PeerFilter()
        f.setPolicy({ defaultPrivate: true, allow: ['192.168.1.0/24'], deny: ['192.168.1.5/32', '10.0.0.0/8'] })
        expect(f.isAllowed('192.168.1.5')).toBe(false)
        expect(f.isAllowed('192.168.1.6')).toBe(true)
        expect(f.isAllowed('10.1.1.1')).toBe(false)
        expect(f.isAllowed('::ffff:192.168.1.5')).toBe(false)
    })

    test('defaultPrivate false with empty allow refuses everything', () => {
        const f = new PeerFilter()
        f.setPolicy({ defaultPrivate: false })
        expect(f.isAllowed('192.168.1.1')).toBe(false)
        expect(f.isAllowed('127.0.0.1')).toBe(false)
    })

    test('defaultPrivate false narrows to the allow list', () => {
        const f = new PeerFilter()
        f.setPolicy({ defaultPrivate: false, allow: ['192.168.1.0/24', 'fe80::/10'] })
        expect(f.isAllowed('192.168.1.9')).toBe(true)
        expect(f.isAllowed('192.168.2.9')).toBe(false)
        expect(f.isAllowed('fe80::5%en0')).toBe(true)
    })

    test('an invalid CIDR rejects the whole call and keeps the previous policy', () => {
        const f = new PeerFilter()
        f.setPolicy({ defaultPrivate: false, allow: ['192.168.1.0/24'] })
        const res = f.setPolicy({ defaultPrivate: true, allow: ['10.0.0.0/8', 'bogus'] })
        expect(res.ok).toBe(false)
        expect(typeof res.error).toBe('string')
        expect(f.isAllowed('192.168.1.9')).toBe(true)
        expect(f.isAllowed('10.0.0.1')).toBe(false)
    })

    test.each([undefined, null, {}, { defaultPrivate: 'yes' }, { defaultPrivate: true, deny: 'x' }])('rejects malformed policy %p', (p) => {
        expect(new PeerFilter().setPolicy(p).ok).toBe(false)
    })
})

describe('classifyAddress', () => {
    test.each([
        ['8.8.8.8', 'public-v4'], ['::ffff:8.8.8.8', 'public-v4'], ['2001:db8::1', 'public-v6'],
        ['100.64.1.1', 'cgnat'], ['224.0.0.1', 'other'], ['ff02::1', 'other'], ['192.168.1.1', 'other'],
        [undefined, 'other'], ['junk', 'other'],
    ])('%s -> %s', (addr, cls) => {
        expect(classifyAddress(addr)).toBe(cls)
    })
    test('isPrivateAddress', () => {
        expect(isPrivateAddress('192.168.0.1')).toBe(true)
        expect(isPrivateAddress('8.8.8.8')).toBe(false)
    })
})

describe('guard', () => {
    const socketFor = (remoteAddress) => ({ remoteAddress, destroy: jest.fn(), write: jest.fn() })

    test('accepts allowed peers without touching the socket', () => {
        const f = new PeerFilter()
        const s = socketFor('192.168.1.2')
        expect(f.guard('media', s)).toBe(true)
        expect(s.destroy).not.toHaveBeenCalled()
    })

    test('destroys refused sockets without writing, including undefined remoteAddress', () => {
        const f = new PeerFilter({ flushIntervalMs: 100000 })
        for (const addr of ['8.8.8.8', undefined]) {
            const s = socketFor(addr)
            expect(f.guard('control', s)).toBe(false)
            expect(s.destroy).toHaveBeenCalledTimes(1)
            expect(s.write).not.toHaveBeenCalled()
        }
        f.dispose()
    })

    test('aggregates refusals per listener and class, without addresses', () => {
        const onRefused = jest.fn()
        const f = new PeerFilter({ onRefused, flushIntervalMs: 100000 })
        f.guard('media', socketFor('8.8.8.8'))
        f.guard('media', socketFor('1.1.1.1'))
        f.guard('media', socketFor('100.64.0.9'))
        f.guard('control', socketFor('2001:db8::1'))
        expect(onRefused).not.toHaveBeenCalled()

        f.flush()
        expect(onRefused).toHaveBeenCalledTimes(3)
        expect(onRefused).toHaveBeenCalledWith('media', 'public-v4', 2)
        expect(onRefused).toHaveBeenCalledWith('media', 'cgnat', 1)
        expect(onRefused).toHaveBeenCalledWith('control', 'public-v6', 1)
        for (const call of onRefused.mock.calls)
            expect(call.join(' ')).not.toMatch(/\d+\.\d+\.\d+\.\d+|2001/)

        onRefused.mockClear()
        f.flush()
        expect(onRefused).not.toHaveBeenCalled()
    })

    test('flushes on its own timer', () => {
        jest.useFakeTimers()
        try {
            const onRefused = jest.fn()
            const f = new PeerFilter({ onRefused, flushIntervalMs: 1000 })
            f.guard('media', socketFor('8.8.8.8'))
            jest.advanceTimersByTime(1000)
            expect(onRefused).toHaveBeenCalledWith('media', 'public-v4', 1)
        }
        finally {
            jest.useRealTimers()
        }
    })
})

describe('peerKey', () => {
    test('IPv6 addresses in the same /64 share a key, other /64s differ', () => {
        expect(peerKey('fe80::1')).toBe(peerKey('fe80::ffff:1:2:3'))
        expect(peerKey('2001:db8:0:1::1')).toBe(peerKey('2001:db8:0:1:aaaa:bbbb:cccc:dddd'))
        expect(peerKey('2001:db8:0:1::1')).not.toBe(peerKey('2001:db8:0:2::1'))
    })
    test('zone ids are ignored', () => {
        expect(peerKey('fe80::1%eth0')).toBe(peerKey('fe80::2'))
    })
    test('IPv4 uses the full address and IPv4-mapped equals plain IPv4', () => {
        expect(peerKey('192.168.1.5')).not.toBe(peerKey('192.168.1.6'))
        expect(peerKey('::ffff:192.168.1.5')).toBe(peerKey('192.168.1.5'))
    })
    test('unparsable address maps to unknown', () => {
        expect(peerKey(undefined)).toBe('unknown')
        expect(peerKey('nonsense')).toBe('unknown')
    })
})
