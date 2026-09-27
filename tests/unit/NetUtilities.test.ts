import { classifyIpHost, expandIpv6, isPrivateIpv4 } from '../../src/utils/NetUtilities.js';

describe('isPrivateIpv4', () => {
  it('flags this-network, private, loopback and link-local octets', () => {
    expect(isPrivateIpv4([0, 0, 0, 0])).toBe(true);
    expect(isPrivateIpv4([0, 1, 2, 3])).toBe(true);
    expect(isPrivateIpv4([10, 1, 2, 3])).toBe(true);
    expect(isPrivateIpv4([127, 0, 0, 1])).toBe(true);
    expect(isPrivateIpv4([172, 16, 0, 1])).toBe(true);
    expect(isPrivateIpv4([172, 31, 255, 255])).toBe(true);
    expect(isPrivateIpv4([192, 168, 1, 1])).toBe(true);
    expect(isPrivateIpv4([169, 254, 169, 254])).toBe(true);
  });

  it('leaves public addresses and the ranges adjacent to the private blocks alone', () => {
    expect(isPrivateIpv4([8, 8, 8, 8])).toBe(false);
    expect(isPrivateIpv4([172, 15, 255, 255])).toBe(false);
    expect(isPrivateIpv4([172, 32, 0, 0])).toBe(false);
    expect(isPrivateIpv4([192, 167, 1, 1])).toBe(false);
    expect(isPrivateIpv4([169, 255, 0, 1])).toBe(false);
  });

  it('blocks the remaining non-routable blocks, not just RFC1918', () => {
    expect(isPrivateIpv4([100, 64, 0, 1])).toBe(true);        // CGNAT 100.64/10
    expect(isPrivateIpv4([100, 127, 255, 255])).toBe(true);
    expect(isPrivateIpv4([192, 0, 0, 1])).toBe(true);         // IETF protocol assignments
    expect(isPrivateIpv4([192, 0, 2, 1])).toBe(true);         // TEST-NET-1
    expect(isPrivateIpv4([198, 18, 0, 1])).toBe(true);        // benchmarking
    expect(isPrivateIpv4([198, 19, 255, 255])).toBe(true);
    expect(isPrivateIpv4([198, 51, 100, 1])).toBe(true);      // TEST-NET-2
    expect(isPrivateIpv4([203, 0, 113, 1])).toBe(true);       // TEST-NET-3
    expect(isPrivateIpv4([224, 0, 0, 1])).toBe(true);         // multicast
    expect(isPrivateIpv4([240, 0, 0, 1])).toBe(true);         // reserved
    expect(isPrivateIpv4([255, 255, 255, 255])).toBe(true);   // broadcast
  });
});

describe('expandIpv6', () => {
  it('expands compressed, full and IPv4-embedded literals into eight groups', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expandIpv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandIpv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('rejects malformed and non-IPv6 input', () => {
    expect(expandIpv6('1:2:3:4:5:6:7')).toBeNull();
    expect(expandIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(expandIpv6('gggg::1')).toBeNull();
    expect(expandIpv6('1::2::3')).toBeNull();
    expect(expandIpv6('127.0.0.1')).toBeNull();
    expect(expandIpv6('')).toBeNull();
  });
});

describe('classifyIpHost IPv4 literals', () => {
  it('blocks private, loopback, link-local and cloud-metadata addresses', () => {
    expect(classifyIpHost('10.1.2.3')).toBe('blocked');
    expect(classifyIpHost('172.16.0.1')).toBe('blocked');
    expect(classifyIpHost('192.168.1.1')).toBe('blocked');
    expect(classifyIpHost('127.0.0.1')).toBe('blocked');
    expect(classifyIpHost('0.0.0.0')).toBe('blocked');
    expect(classifyIpHost('169.254.169.254')).toBe('blocked');
  });

  it('allows public addresses and tolerates surrounding whitespace', () => {
    expect(classifyIpHost('8.8.8.8')).toBe('public');
    expect(classifyIpHost('1.1.1.1')).toBe('public');
    expect(classifyIpHost('172.32.0.1')).toBe('public');
    expect(classifyIpHost(' 8.8.8.8 ')).toBe('public');
  });

  it('fails closed on out-of-range octets and reports short quads as names', () => {
    expect(classifyIpHost('999.1.1.1')).toBe('blocked');
    expect(classifyIpHost('256.1.1.1')).toBe('blocked');
    expect(classifyIpHost('1.2.3')).toBe('not-ip');
    expect(classifyIpHost('1.2.3.4.5')).toBe('not-ip');
  });
});

describe('classifyIpHost IPv6 literals', () => {
  it('blocks loopback, unspecified, unique-local, link-local and multicast', () => {
    expect(classifyIpHost('::1')).toBe('blocked');
    expect(classifyIpHost('::')).toBe('blocked');
    expect(classifyIpHost('fc00::1')).toBe('blocked');
    expect(classifyIpHost('fd00::1')).toBe('blocked');
    expect(classifyIpHost('fe80::1')).toBe('blocked');
    expect(classifyIpHost('ff02::1')).toBe('blocked');
    expect(classifyIpHost('ff00::1')).toBe('blocked');
  });

  it('blocks the alternate spellings that embed a private IPv4 address', () => {
    expect(classifyIpHost('::ffff:127.0.0.1')).toBe('blocked');
    expect(classifyIpHost('::ffff:7f00:1')).toBe('blocked');
    expect(classifyIpHost('::ffff:169.254.169.254')).toBe('blocked');
    expect(classifyIpHost('::127.0.0.1')).toBe('blocked');
    expect(classifyIpHost('64:ff9b::7f00:1')).toBe('blocked');
    expect(classifyIpHost('2002:7f00:1::')).toBe('blocked');
  });

  it('allows public IPv6 and the spellings that embed a public IPv4 address', () => {
    expect(classifyIpHost('2606:4700:4700::1111')).toBe('public');
    expect(classifyIpHost('::ffff:8.8.8.8')).toBe('public');
    expect(classifyIpHost('64:ff9b::8.8.8.8')).toBe('public');
    expect(classifyIpHost('2002:808:808::')).toBe('public');
  });

  it('accepts bracketed literals and a zone id', () => {
    expect(classifyIpHost('[::1]')).toBe('blocked');
    expect(classifyIpHost('[::ffff:127.0.0.1]')).toBe('blocked');
    expect(classifyIpHost('fe80::1%eth0')).toBe('blocked');
    expect(classifyIpHost('[2001:db8::1]')).toBe('public');
  });

  it('fails closed on malformed IPv6 literals', () => {
    expect(classifyIpHost('gggg::1')).toBe('blocked');
    expect(classifyIpHost('1::2::3')).toBe('blocked');
    expect(classifyIpHost('1:2:3:4:5:6:7')).toBe('blocked');
  });
});

describe('classifyIpHost IPv4-compatible zero addresses', () => {
  it('blocks the IPv4-compatible spellings of 0.0.0.0 and 0.0.0.1', () => {
    expect(classifyIpHost('0.0.0.0')).toBe('blocked');
    expect(classifyIpHost('0.0.0.1')).toBe('blocked');
    expect(classifyIpHost('::0.0.0.0')).toBe('blocked');
    expect(classifyIpHost('::0.0.0.1')).toBe('blocked');
  });
});

describe('classifyIpHost hostnames', () => {
  it('reports names and empty input as not-ip so the caller resolves them', () => {
    expect(classifyIpHost('example.com')).toBe('not-ip');
    expect(classifyIpHost('localhost')).toBe('not-ip');
    expect(classifyIpHost('a.b.c.d')).toBe('not-ip');
    expect(classifyIpHost('')).toBe('not-ip');
    expect(classifyIpHost('   ')).toBe('not-ip');
  });
});

// Regression guard: the embedded-IPv4 guard used to be `(g6 !== 0 || g7 > 1)`,
// which gated the IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96)
// prefixes with the same condition. For the compatible prefix the two excluded
// values, 0.0.0.0 and 0.0.0.1, were caught earlier by the unspecified /
// loopback rules, but for the mapped prefix nothing else caught them, so
// `::ffff:0.0.0.0` and `::ffff:0.0.0.1` came back 'public' even though the bare
// dotted-quads are 'blocked'.
describe('classifyIpHost IPv4-mapped zero addresses', () => {
  it('blocks the IPv4-mapped spellings of 0.0.0.0 and 0.0.0.1 like the bare dotted-quads', () => {
    expect(['::ffff:0.0.0.0', '::ffff:0.0.0.1'].map(classifyIpHost)).toEqual(['blocked', 'blocked']);
  });
});
