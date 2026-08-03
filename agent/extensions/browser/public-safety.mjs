import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan"];
const dnsCache = new Map();

function blockedIpv4(address) {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

export function isBlockedAddress(input) {
  const address = String(input || "").toLowerCase().replace(/^\[|\]$/gu, "").split("%", 1)[0];
  const family = isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family !== 6) return true;
  if (address === "::" || address === "::1") return true;
  if (/^f[cd]/u.test(address) || /^fe[89ab]/u.test(address) || /^ff/u.test(address) || /^2001:db8(?::|$)/u.test(address)) return true;
  const mapped = address.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  return mapped ? blockedIpv4(mapped[1]) : false;
}

async function publicDnsAddresses(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = lookup(hostname, { all: true, verbatim: true }).then((records) => {
    if (!records.length || records.some((record) => isBlockedAddress(record.address))) {
      throw new Error("Destination resolves to a private, local, or reserved network");
    }
    return records;
  });
  dnsCache.set(hostname, { expiresAt: Date.now() + 60_000, promise });
  try {
    return await promise;
  } catch (error) {
    dnsCache.delete(hostname);
    throw error;
  }
}

export async function assertPublicHttpUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error("Public browser mode requires a valid absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Public browser mode permits credential-free HTTP(S) URLs only");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!hostname || hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error("Local and private hostnames are blocked in public browser mode");
  }
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error("Private, local, and reserved IP addresses are blocked in public browser mode");
  } else {
    await publicDnsAddresses(hostname);
  }
  return url;
}

export async function installPublicNetworkGuard(context) {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (/^(?:data|blob|about):/iu.test(requestUrl)) {
      await route.continue();
      return;
    }
    try {
      await assertPublicHttpUrl(requestUrl);
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });

  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket("**/*", async (socket) => {
      try {
        const websocketUrl = new URL(socket.url());
        if (!["ws:", "wss:"].includes(websocketUrl.protocol)) throw new Error("Unsupported WebSocket protocol");
        websocketUrl.protocol = websocketUrl.protocol === "wss:" ? "https:" : "http:";
        await assertPublicHttpUrl(websocketUrl.href);
        socket.connectToServer();
      } catch {
        socket.close({ code: 1008, reason: "Private destination blocked" });
      }
    });
  }
}
