import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blockedIpv4Addresses = createIpv4BlockList();
const blockedIpv6Addresses = createIpv6BlockList();

export interface SafeRemoteTarget {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  const allowPrivate = process.env.ALLOW_PRIVATE_UPSTREAMS === "true";
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new Error("Remote endpoint must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Endpoint URL must not contain credentials");
  if (allowPrivate) return url;

  const hostname = normalizeHostname(url.hostname);
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private or unresolved remote endpoints are not allowed");
  }
  return url;
}

export async function resolveSafeRemoteTarget(rawUrl: string): Promise<SafeRemoteTarget> {
  const url = new URL(rawUrl);
  const allowPrivate = process.env.ALLOW_PRIVATE_UPSTREAMS === "true";
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new Error("Remote endpoint must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Endpoint URL must not contain credentials");
  const hostname = normalizeHostname(url.hostname);
  const family = isIP(hostname);
  const resolved = family
    ? [{ address: hostname, family }]
    : await lookup(hostname, { all: true, verbatim: true });
  const addresses = resolved
    .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6)
    .map(({ address, family }) => ({ address, family }));
  if (addresses.length === 0 || (!allowPrivate && addresses.some(({ address }) => isPrivateAddress(address)))) {
    throw new Error("Private or unresolved remote endpoints are not allowed");
  }
  return { url, addresses };
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIpv4Addresses.check(address, "ipv4");
  if (family === 6) return blockedIpv6Addresses.check(address, "ipv6");
  return true;
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function createIpv4BlockList(): BlockList {
  const list = new BlockList();
  const ipv4Ranges: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  for (const [network, prefix] of ipv4Ranges) list.addSubnet(network, prefix, "ipv4");
  return list;
}

function createIpv6BlockList(): BlockList {
  const list = new BlockList();
  const ipv6Ranges: Array<[string, number]> = [
    ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["fc00::", 7],
    ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
  ];
  for (const [network, prefix] of ipv6Ranges) list.addSubnet(network, prefix, "ipv6");
  return list;
}
