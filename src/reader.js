"use strict";

/* ============================================================================
   Reading a linked page

   A model cannot open a link. Asked to summarise a URL it reads the words in
   the address and writes plausible prose around them -- convincing, and often
   wrong. Tested with an invented Reuters URL, phi-4 produced a detailed
   summary of an event that never happened.

   So Horizon can fetch the page itself and hand the real text to the model.
   The model still has no network access; the request comes from here, where
   it is visible in the Traffic panel and under the user's control.

   Off by default. This is the one part of Horizon that leaves the machine, so
   it is a deliberate choice rather than a default.
   ========================================================================== */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const dns = require("dns/promises");
const net = require("net");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// A pasted link must never be able to reach the machine it is pasted on, or
// anything else on the local network. This is not about restricting the user:
// it stops a hostile URL turning Horizon into a way to probe a router admin
// page, a database bound to localhost, or a cloud metadata endpoint.
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 0 || a >= 224) return true;            // this-network, multicast, reserved
    return false;
  }

  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("fe80")) return true;       // link-local
    if (value.startsWith("fc") || value.startsWith("fd")) return true; // unique local
    // An IPv4 address wearing an IPv6 hat still needs the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  return true; // unknown form: refuse rather than guess
}

// Resolved before connecting, so a public hostname cannot point at a private
// address. Checked again on every redirect.
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("That address is on this machine or your local network, so Horizon will not fetch it.");
    }
    return;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not find ${hostname}.`);
  }

  if (records.some(record => isPrivateAddress(record.address))) {
    throw new Error("That name points to your local network, so Horizon will not fetch it.");
  }
}

function requestOnce(target, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;

    const request = client.get(target, {
      timeout: 15000,
      headers: {
        // Honest about what is asking. Some sites serve different content to
        // unknown agents, and pretending to be a browser would be worse.
        "User-Agent": "Horizon/1.0 (local AI assistant; +https://127.0.0.1)",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "en"
      }
    }, response => {
      const status = response.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error("That link redirected too many times."));
        const next = new URL(response.headers.location, target);
        return assertPublicHost(next.hostname)
          .then(() => resolve(requestOnce(next, redirectsLeft - 1)))
          .catch(reject);
      }

      if (status >= 400) {
        response.resume();
        return reject(new Error(
          status === 403 || status === 401
            ? "That page refused the request. It may need a sign-in."
            : status === 404 ? "That page was not found."
            : `That page returned an error (${status}).`
        ));
      }

      const type = String(response.headers["content-type"] || "");
      if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
        response.resume();
        return reject(new Error("That link is not a web page Horizon can read."));
      }

      let size = 0;
      const chunks = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          request.destroy();
          return reject(new Error("That page is too large to read."));
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        url: target.toString(),
        html: Buffer.concat(chunks).toString("utf8")
      }));
    });

    request.on("timeout", () => { request.destroy(); reject(new Error("That page took too long to respond.")); });
    request.on("error", error => reject(new Error(`Could not reach that page: ${error.message}`)));
  });
}

// Deliberately simple: scripts and styles removed, tags stripped, whitespace
// collapsed. Not a browser -- a page that needs JavaScript to render will come
// back empty, and saying so is better than pretending otherwise.
function toText(html) {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const entities = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&quot;": '"', "&#39;": "'", "&apos;": "'", "&mdash;": "\u2014",
    "&ndash;": "\u2013", "&hellip;": "\u2026", "&rsquo;": "\u2019", "&lsquo;": "\u2018"
  };
  text = text.replace(/&[#\w]+;/g, match => entities[match.toLowerCase()] ?? " ");

  return text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map(line => line.trim())
    .join("\n")
    .trim();
}

function titleOf(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? toText(match[1]).slice(0, 200) : null;
}

async function fetchPage(rawUrl, maxChars) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("That does not look like a web address.");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Horizon can only read http and https links.");
  }

  await assertPublicHost(target.hostname);

  const { url, html } = await requestOnce(target, MAX_REDIRECTS);
  const title = titleOf(html);
  const full = toText(html);

  if (!full || full.length < 200) {
    throw new Error("That page had no readable text. It may need JavaScript or a sign-in.");
  }

  const truncated = full.length > maxChars;
  return {
    url,
    title,
    text: truncated ? full.slice(0, maxChars) : full,
    characters: truncated ? maxChars : full.length,
    originalCharacters: full.length,
    truncated
  };
}

module.exports = { fetchPage, isPrivateAddress, toText };
