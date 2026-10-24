import { resolve4 } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import https from "node:https";
import { assert } from "./contracts.js";
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
export function publicIpv4(ip: string) {
  return isIP(ip) === 4 && !blocked.check(ip, "ipv4");
}
export function researchUrl(raw: string) {
  const url = new URL(raw);
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      !url.hostname.endsWith("."),
    "research_url_blocked",
  );
  return url;
}
export async function fetchPage(
  raw: string,
  redirects = 0,
): Promise<{ url: string; retrievedAt: string; text: string }> {
  assert(redirects <= 3, "research_redirect_limit");
  const url = researchUrl(raw),
    ips = await Promise.race([
      resolve4(url.hostname),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("research_dns_timeout")),
          5000,
        );
        timer.unref();
      }),
    ]);
  assert(
    ips.length && ips.every(publicIpv4),
    "research_private_network_blocked",
  );
  const response = await new Promise<{ location?: string; text?: string }>(
    (resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            accept: "text/html,text/plain",
            "accept-encoding": "identity",
          },
          lookup: (_host, _opts, callback) => callback(null, ips[0], 4),
        },
        (res) => {
          res.on("error", reject);
          if (
            res.statusCode &&
            [301, 302, 303, 307, 308].includes(res.statusCode)
          ) {
            res.destroy();
            resolve({ location: res.headers.location });
            return;
          }
          if (
            res.statusCode !== 200 ||
            !/^text\/(html|plain)/i.test(res.headers["content-type"] ?? "") ||
            (res.headers["content-encoding"] &&
              res.headers["content-encoding"] !== "identity")
          ) {
            res.destroy();
            reject(new Error("research_response_blocked"));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 1_000_000) {
              request.destroy(new Error("research_size_limit"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () =>
            resolve({ text: Buffer.concat(chunks).toString("utf8") }),
          );
          res.on("error", reject);
        },
      );
      const timer = setTimeout(
        () => request.destroy(new Error("research_timeout")),
        10_000,
      );
      request.on("close", () => clearTimeout(timer));
      request.on("error", reject);
    },
  );
  if (response.location)
    return fetchPage(new URL(response.location, url).href, redirects + 1);
  assert(response.text !== undefined, "research_response_missing");
  return {
    url: url.href,
    retrievedAt: new Date().toISOString(),
    text: response.text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .slice(0, 20_000),
  };
}
export async function searchWeb(query: string, key: string) {
  assert(key && query.length <= 500, "research_unavailable");
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: 5, type: "fast" }),
    signal: AbortSignal.timeout(10_000),
  });
  assert(res.ok, "research_provider_failed");
  assert(res.body, "research_response_missing");
  const reader = res.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= 200_000, "research_size_limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const body = JSON.parse(text) as {
    results?: { url: string; title?: string }[];
  };
  return {
    retrievedAt: new Date().toISOString(),
    results: (body.results ?? []).slice(0, 5).map((r) => ({
      url: researchUrl(r.url).href,
      title: (r.title ?? "").slice(0, 300),
    })),
  };
}
