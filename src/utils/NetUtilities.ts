/**
 * NetUtilities — IP-literal classification for SSRF guards.
 *
 * Classifies IP literals only; resolving hostnames remains the caller's job.
 * It covers the alternate IPv6 spellings a naive "dotted-quad or ::1" check
 * misses: IPv4-mapped (`::ffff:127.0.0.1`, `::ffff:7f00:1`), IPv4-compatible
 * (`::127.0.0.1`), NAT64 (`64:ff9b::7f00:1`), 6to4 (`2002:7f00:1::`),
 * unique-local (`fc00::/7`), link-local (`fe80::/10`), multicast (`ff00::/8`)
 * and the unspecified address.
 */

export type IpHostClass = 'blocked' | 'public' | 'not-ip';

/** Private, loopback, link-local and otherwise non-routable IPv4 octets. */
export function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 ||                            // "this network"
    a === 10 ||                           // private
    a === 127 ||                          // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT shared address space (RFC 6598)
    (a === 172 && b >= 16 && b <= 31) ||  // private
    (a === 192 && b === 168) ||           // private
    (a === 192 && b === 0 && c === 0) ||  // IETF protocol assignments (incl. 192.0.0.9/10 anycast)
    (a === 192 && b === 0 && c === 2) ||  // TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||  // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||   // TEST-NET-3
    (a === 169 && b === 254) ||           // link-local, incl. cloud metadata
    a >= 224                              // multicast, reserved and broadcast
  );
}

function parseGroups(segment: string): number[] | null {
  if (segment === '') return [];
  const groups: number[] = [];
  for (const piece of segment.split(':')) {
    if (piece.includes('.')) {
      const octets = piece.split('.').map(Number);
      if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
      groups.push(((octets[0] << 8) | octets[1]) & 0xffff, ((octets[2] << 8) | octets[3]) & 0xffff);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    groups.push(parseInt(piece, 16));
  }
  return groups;
}

/** Expand an IPv6 literal into its eight 16-bit groups; null when malformed. */
export function expandIpv6(host: string): number[] | null {
  const clean = host.split('%')[0];
  if (!clean.includes(':')) return null;
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1]);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function embeddedIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0, g1, g2, , , g5, g6, g7] = groups;
  const zeroPrefix = (count: number): boolean => groups.slice(0, count).every(group => group === 0);
  if (groups.every(group => group === 0)) return true;                        // :: unspecified
  if (zeroPrefix(7) && g7 === 1) return true;                                 // ::1 loopback
  if ((g0 & 0xfe00) === 0xfc00) return true;                                  // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true;                                  // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true;                                  // ff00::/8 multicast
  // ::ffff:0:0/96 IPv4-mapped and ::/96 IPv4-compatible carry a full IPv4 address.
  if (zeroPrefix(5) && g5 === 0xffff && isPrivateIpv4(embeddedIpv4(g6, g7))) return true;   // ::ffff:a.b.c.d mapped
  if (zeroPrefix(5) && g5 === 0 && isPrivateIpv4(embeddedIpv4(g6, g7))) return true;        // ::a.b.c.d compatible
  // 64:ff9b::/96 NAT64
  if (g0 === 0x64 && g1 === 0xff9b && groups.slice(2, 6).every(group => group === 0) && isPrivateIpv4(embeddedIpv4(g6, g7))) return true;
  // 2002::/16 6to4 embeds the IPv4 address in groups 1-2
  if (g0 === 0x2002 && isPrivateIpv4(embeddedIpv4(g1, g2))) return true;
  return false;
}

/** Classify an IP-literal host: 'not-ip' means the host is a name, not an address. */
export function classifyIpHost(rawHost: string): IpHostClass {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (host === '') return 'not-ip';
  if (host.includes(':')) {
    const groups = expandIpv6(host);
    if (!groups) return 'blocked';  // malformed literal: fail closed
    return isBlockedIpv6(groups) ? 'blocked' : 'public';
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return 'not-ip';
  const octets = match.slice(1).map(Number);
  if (octets.some(octet => octet > 255)) return 'blocked';
  return isPrivateIpv4(octets) ? 'blocked' : 'public';
}
