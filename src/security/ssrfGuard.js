const dns = require("node:dns").promises;
const net = require("node:net");

/**
 * Memeriksa apakah alamat IPv4 atau IPv6 termasuk private, loopback, link-local, atau cloud metadata.
 */
function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== "string") return true;
  const clean = ip.trim().toLowerCase();

  if (clean === "localhost") return true;

  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (clean.startsWith("::ffff:")) {
    return isPrivateOrReservedIp(clean.slice(7));
  }

  const version = net.isIP(clean);
  if (version === 4) {
    const parts = clean.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 (Private)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 (Loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (Private)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (Private)
    if (a >= 224) return true; // Multicast & Reserved
    return false;
  }

  if (version === 6) {
    if (clean === "::1" || clean === "::") return true;
    if (clean.startsWith("fc") || clean.startsWith("fd")) return true; // Unique Local (fc00::/7)
    if (clean.startsWith("fe8") || clean.startsWith("fe9") || clean.startsWith("fea") || clean.startsWith("feb")) {
      return true; // Link-local (fe80::/10)
    }
    return false;
  }

  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "0.0.0.0",
  "127.0.0.1",
  "169.254.169.254",
  "[::1]",
]);

/**
 * Validasi URL secara sinkron (format, skema HTTPS, hostname).
 */
function validateUrlFormat(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    throw new Error("Format URL tidak valid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Protokol URL tidak diizinkan (${parsed.protocol}). Wajib menggunakan https://`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("URL dengan kredensial embedded tidak diizinkan.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error(`Hostname "${hostname}" diblokir oleh SSRF Guard.`);
  }

  const bareHost = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bareHost)) {
    if (isPrivateOrReservedIp(bareHost)) {
      throw new Error(`Alamat IP "${bareHost}" diblokir oleh SSRF Guard (Private/Reserved IP).`);
    }
  }

  return parsed;
}

/**
 * Validasi URL beserta resolusi DNS untuk mencegah DNS Rebinding ke IP internal.
 */
async function assertSafeUrl(rawUrl, dnsLookupFn = dns.lookup) {
  const parsed = validateUrlFormat(rawUrl);
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, "");

  if (!net.isIP(bareHost)) {
    const records = await dnsLookupFn(bareHost, { all: true });
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error(`Gagal me-resolve DNS untuk hostname "${bareHost}".`);
    }
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        throw new Error(
          `SSRF Guard: Hostname "${bareHost}" mengarah ke IP terlarang (${rec.address}).`
        );
      }
    }
  }

  return parsed.toString();
}

/**
 * Melakukan HTTP GET dengan proteksi SSRF, batas redirect maksimal, dan batas ukuran respons.
 */
async function safeFetchText(rawUrl, options = {}) {
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 12000;
  const maxBytes = options.maxBytes ?? 512 * 1024; // 512 KB
  const fetchFn = options.fetchFn || fetch;
  const dnsLookupFn = options.dnsLookupFn || dns.lookup;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safeUrl = await assertSafeUrl(currentUrl, dnsLookupFn);
    const res = await fetchFn(safeUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": "BinanceAgenticAutomationEngine/1.0",
        Accept: "text/markdown, text/plain, application/json, text/html;q=0.8",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop === maxRedirects) {
        throw new Error("Terlalu banyak HTTP redirect.");
      }
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("Redirect tanpa header Location.");
      }
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} saat mengakses ${safeUrl}`);
    }

    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`Ukuran respons melebihi batas keamanan (${maxBytes} bytes).`);
    }

    return {
      url: safeUrl,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      etag: res.headers.get("etag") || null,
      text,
    };
  }

  throw new Error("Gagal mengambil URL.");
}

module.exports = {
  isPrivateOrReservedIp,
  validateUrlFormat,
  assertSafeUrl,
  safeFetchText,
};
