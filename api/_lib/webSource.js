import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable, Transform, pipeline } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { X509Certificate } from 'node:crypto';

const MAX_PAGE_BYTES = 1_000_000;
const MAX_READABLE_CHARS = 14_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const validatedTargets = new WeakMap();

function unsafeIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

function unsafeIpv6(address) {
  // URL parsing canonicalizes expanded and dotted IPv4-mapped IPv6 alike.
  const value = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = value.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return unsafeIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // Only global unicast space is eligible; exclude documentation addresses too.
  return !/^[23]/.test(value) || value.startsWith('2001:db8:');
}

function isUnsafeAddress(address) {
  if (typeof address !== 'string') return true;
  const version = isIP(address);
  return version === 4 ? unsafeIpv4(address) : version === 6 ? unsafeIpv6(address) : true;
}

function publicWebsiteError() {
  const error = new Error('Use a public website URL that Dovroyn can safely analyse.');
  error.status = 400;
  return error;
}

export async function validatePublicWebsiteUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw publicWebsiteError();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw publicWebsiteError();
  if (url.port && !['80', '443'].includes(url.port)) throw publicWebsiteError();

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw publicWebsiteError();

  let addresses;
  if (isIP(hostname)) {
    if (isUnsafeAddress(hostname)) throw publicWebsiteError();
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      const error = new Error('Dovroyn could not find that website.');
      error.status = 422;
      throw error;
    }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => isUnsafeAddress(entry?.address))) throw publicWebsiteError();
  }
  validatedTargets.set(url, {
    href: url.toString(),
    hostname,
    addresses: addresses.map(({ address }) => ({ address, family: isIP(address) })),
  });
  return url;
}

function fetchPinnedWebsite(url, { signal, headers, maxPageBytes = MAX_PAGE_BYTES }) {
  const target = validatedTargets.get(url);
  if (!target || target.href !== url.toString() || !target.addresses.length) throw publicWebsiteError();

  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      // A fresh connection per hop cannot reuse a socket validated for another DNS answer.
      agent: false,
      signal,
      headers: { ...headers, Host: url.host, 'Accept-Encoding': 'identity' },
      ...(url.protocol === 'https:' ? {
        servername: isIP(target.hostname) ? '' : target.hostname,
        rejectUnauthorized: true,
        // Native IPv6 certificate matching is inconsistent across Node versions.
        // Match the original literal against IP SANs without relaxing CA checks.
        ...(isIP(target.hostname) === 6 ? {
          checkServerIdentity(_hostname, certificate) {
            try {
              if (new X509Certificate(certificate.raw).checkIP(target.hostname)) return undefined;
            } catch {
              // Missing or malformed certificate identity must fail closed.
            }
            return new Error('The website certificate does not match its IP address.');
          },
        } : {}),
      } : {}),
      lookup(hostname, options, callback) {
        if (hostname.toLowerCase().replace(/\.$/, '') !== target.hostname) {
          callback(publicWebsiteError());
          return;
        }
        const family = typeof options === 'number' ? options : options.family;
        const addresses = target.addresses.filter((entry) => !family || entry.family === family);
        if (!addresses.length) callback(publicWebsiteError());
        else if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, (response) => {
      const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
      const decompress = encoding === 'gzip' ? createGunzip : encoding === 'deflate' ? createInflate : encoding === 'br' ? createBrotliDecompress : null;
      if (encoding && encoding !== 'identity' && !decompress) {
        response.destroy();
        reject(Object.assign(new Error('That URL is not a readable website page.'), { status: 422 }));
        return;
      }
      let encodedBytes = 0;
      const boundedWire = new Transform({
        transform(chunk, _encoding, callback) {
          encodedBytes += chunk.byteLength;
          if (encodedBytes > maxPageBytes) callback(pageTooLargeError());
          else callback(null, chunk);
        },
      });
      const stream = decompress ? decompress() : boundedWire;
      const body = Readable.toWeb(stream);
      // Bound encoded bytes before decompression; pipeline tears down the response
      // and socket on this cap or cancellation at the separate decoded-byte cap.
      pipeline(decompress ? [response, boundedWire, stream] : [response, boundedWire], (error) => {
        if (error) stream.destroy(error);
      });
      resolve({
        url: url.toString(),
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: {
          get(name) {
            const value = response.headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value ?? null;
          },
        },
        body,
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function withAbort(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const removeListener = () => signal.removeEventListener('abort', abort);
    const abort = () => { removeListener(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then((value) => {
      removeListener();
      resolve(value);
    }, (error) => {
      removeListener();
      reject(error);
    });
  });
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function stripInertContent(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|noscript|template|svg|textarea|iframe|object|xmp)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
}

function cleanInlineText(value, maxLength = 1000) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function getAttribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function findMetaDescription(html) {
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    if (getAttribute(tag, 'name').toLowerCase() === 'description') return cleanInlineText(getAttribute(tag, 'content'), 2000);
  }
  return '';
}

function findCanonicalUrl(html, baseUrl) {
  for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
    const rel = getAttribute(tag, 'rel').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical')) continue;
    try {
      const url = new URL(getAttribute(tag, 'href'), baseUrl);
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  }
  return '';
}

function discoverDocumentLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  for (const tag of String(html || '').match(/<a\b[^>]*>/gi) || []) {
    const href = getAttribute(tag, 'href');
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const value = url.toString();
      if (!seen.has(value)) {
        seen.add(value);
        links.push(value);
      }
    } catch {
      // Malformed page links are untrusted data and are ignored.
    }
  }
  return links;
}

function extractDocumentMetadata(html, finalUrl) {
  const documentHtml = stripInertContent(html);
  const titleMatch = documentHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = documentHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return {
    title: cleanInlineText(titleMatch?.[1], 1000),
    description: findMetaDescription(documentHtml),
    canonicalUrl: findCanonicalUrl(documentHtml, finalUrl),
    h1: cleanInlineText(h1Match?.[1], 1000),
    links: discoverDocumentLinks(documentHtml, finalUrl),
  };
}

function pageTooLargeError() {
  return Object.assign(new Error('That website page is too large to analyse safely.'), { status: 422 });
}

async function readBoundedResponse(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw pageTooLargeError();
    return new TextDecoder().decode(bytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw pageTooLargeError();
      }
      body += decoder.decode(bytes, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

export function extractReadableText(html) {
  return decodeHtmlEntities(stripInertContent(html))
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|header|footer|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_READABLE_CHARS);
}

export async function fetchWebsiteText(rawUrl, options = {}) {
  const validateUrl = options.validateUrl || validatePublicWebsiteUrl;
  // Explicit injection is a trusted test seam, never a request-controlled option.
  const fetchImpl = options.fetchImpl || fetchPinnedWebsite;
  const redirectPolicy = typeof options.redirectPolicy === 'function' ? options.redirectPolicy : null;
  const maxPageBytes = Math.min(MAX_PAGE_BYTES, Math.max(1, Number(options.maxPageBytes) || MAX_PAGE_BYTES));
  const maxReadableChars = Math.min(MAX_READABLE_CHARS, Math.max(1, Number(options.maxReadableChars) || MAX_READABLE_CHARS));
  const maxRedirects = Math.min(MAX_REDIRECTS, Math.max(0, Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS));
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, Math.max(1, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS));
  let nextRawUrl = rawUrl;
  let previousUrl = null;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort(options.signal.reason);
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const currentUrl = await withAbort(() => validateUrl(nextRawUrl), controller.signal);
      if (previousUrl && redirectPolicy && !await withAbort(() => redirectPolicy(currentUrl, previousUrl), controller.signal)) {
        throw Object.assign(new Error('That website redirected outside the allowed crawl area.'), { status: 422 });
      }
      const response = await withAbort(() => fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        maxPageBytes,
        headers: { 'User-Agent': 'DovroynWebsiteAnalyzer/1.0' },
      }), controller.signal);
      if (response.url) {
        const responseUrl = new URL(response.url);
        const requestedUrl = new URL(currentUrl);
        responseUrl.hash = '';
        requestedUrl.hash = '';
        if (responseUrl.href !== requestedUrl.href) {
          throw Object.assign(new Error('That website returned an unexpected final target.'), { status: 422 });
        }
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirectCount === maxRedirects) throw Object.assign(new Error('The website redirected too many times.'), { status: 422 });
        nextRawUrl = new URL(location, currentUrl).toString();
        previousUrl = currentUrl;
        continue;
      }
      if (!response.ok) throw Object.assign(new Error('Dovroyn could not read that website.'), { status: 422 });

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml') && !contentType.includes('text/plain')) {
        throw Object.assign(new Error('That URL is not a readable website page.'), { status: 422 });
      }
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > maxPageBytes) throw pageTooLargeError();

      const body = await readBoundedResponse(response, maxPageBytes);
      const isPlainText = contentType.includes('text/plain');
      const text = isPlainText ? body.trim().slice(0, maxReadableChars) : extractReadableText(body).slice(0, maxReadableChars);
      if (!text) throw Object.assign(new Error('Dovroyn could not find readable text on that page.'), { status: 422 });
      return {
        url: currentUrl.toString(),
        text,
        ...(isPlainText ? { title: '', description: '', canonicalUrl: '', h1: '', links: [] } : extractDocumentMetadata(body, currentUrl)),
      };
    } catch (error) {
      if (error?.status) throw error;
      throw Object.assign(new Error('Dovroyn could not read that website.'), { status: 422 });
    } finally {
      controller.abort();
      options.signal?.removeEventListener('abort', abortFromCaller);
      clearTimeout(timeout);
    }
  }
  throw Object.assign(new Error('Dovroyn could not read that website.'), { status: 422 });
}
