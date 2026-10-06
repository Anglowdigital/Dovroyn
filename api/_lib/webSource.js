import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_PAGE_BYTES = 1_000_000;
const MAX_READABLE_CHARS = 14_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;

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
  const value = address.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('2001:db8:')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? unsafeIpv4(mapped[1]) : false;
}

function isUnsafeAddress(address) {
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

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw publicWebsiteError();

  if (isIP(hostname)) {
    if (isUnsafeAddress(hostname)) throw publicWebsiteError();
  } else {
    let addresses;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      const error = new Error('Dovroyn could not find that website.');
      error.status = 422;
      throw error;
    }
    if (!addresses.length || addresses.some(({ address }) => isUnsafeAddress(address))) throw publicWebsiteError();
  }
  return url;
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
  const documentHtml = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
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
  return decodeHtmlEntities(String(html || ''))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
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
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const maxPageBytes = Math.min(MAX_PAGE_BYTES, Math.max(1, Number(options.maxPageBytes) || MAX_PAGE_BYTES));
  const maxReadableChars = Math.min(MAX_READABLE_CHARS, Math.max(1, Number(options.maxReadableChars) || MAX_READABLE_CHARS));
  const maxRedirects = Math.min(MAX_REDIRECTS, Math.max(0, Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS));
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, Math.max(1, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS));
  let currentUrl = await validateUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'DovroynWebsiteAnalyzer/1.0' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirectCount === maxRedirects) throw Object.assign(new Error('The website redirected too many times.'), { status: 422 });
        currentUrl = await validateUrl(new URL(location, currentUrl).toString());
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
      clearTimeout(timeout);
    }
  }
  throw Object.assign(new Error('Dovroyn could not read that website.'), { status: 422 });
}
