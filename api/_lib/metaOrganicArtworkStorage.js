import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import crypto from 'node:crypto';
import { getSupabaseServiceConfig } from './supabaseAuth.js';
import { META_ORGANIC_MAX_SOURCE_BYTES } from './metaOrganicArtworkExport.js';

const POD_ASSETS_BUCKET = 'pod-assets';
const READ_TIMEOUT_MS = 10_000;
const SOURCE_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

function cleanString(value, max = 1000) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function encodeObjectPath(path) {
  return String(path || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}

function assertPodAssetPath({ userId, podId, storagePath }) {
  const user = cleanString(userId, 120);
  const pod = cleanString(podId, 120);
  const path = cleanString(storagePath, 1200);
  if (!user || !pod || !path || path.includes('..') || path.startsWith('/') || path.includes('//') || !path.startsWith(`${user}/${pod}/`)) {
    throw Object.assign(new Error('Artwork source is outside this pod.'), { code: 'EXPORT_SOURCE_TENANT_MISMATCH' });
  }
  return path;
}

function assertExportPath(path) {
  const objectPath = cleanString(path, 1400);
  if (!/^meta-organic-exports\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[a-f0-9]{64}\.jpg$/.test(objectPath)) {
    throw Object.assign(new Error('Export object path is not canonical.'), { code: 'EXPORT_OBJECT_PATH_INVALID' });
  }
  return objectPath;
}

function objectVersionFromHeaders(headers) {
  return cleanString(headers.get('etag') || headers.get('x-supabase-version') || headers.get('last-modified'), 200);
}

function serviceHeaders(config, contentType = '') {
  const { serviceRoleKey } = config;
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

async function boundedBytes(response, maxBytes = META_ORGANIC_MAX_SOURCE_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error('Artwork source is too large.'), { code: 'EXPORT_SOURCE_TOO_LARGE' });
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > maxBytes) throw Object.assign(new Error('Artwork source is too large.'), { code: 'EXPORT_SOURCE_TOO_LARGE' });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(new Error('Artwork source is too large.'), { code: 'EXPORT_SOURCE_TOO_LARGE' });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  if (!bytes.byteLength) throw Object.assign(new Error('Artwork source is empty.'), { code: 'EXPORT_SOURCE_UNAVAILABLE' });
  return bytes;
}

function assertNoRedirect(response) {
  if (response.status >= 300 && response.status < 400) {
    const error = new Error('Storage redirected unexpectedly.');
    error.status = response.status;
    error.code = 'EXPORT_STORAGE_UNAVAILABLE';
    throw error;
  }
}

async function readStorageObject({ baseUrl, config, fetchImpl, objectPath, code = 'EXPORT_STORAGE_UNAVAILABLE' }) {
  const response = await fetchImpl(`${baseUrl}/storage/v1/object/${POD_ASSETS_BUCKET}/${encodeObjectPath(objectPath)}`, {
    method: 'GET',
    redirect: 'manual',
    headers: serviceHeaders(config),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  assertNoRedirect(response);
  if (!response.ok) {
    const error = new Error(response.status === 404 ? 'Storage object is unavailable.' : 'Private pod asset storage denied the read.');
    error.status = response.status;
    error.code = response.status === 404 ? 'EXPORT_SOURCE_UNAVAILABLE' : code;
    throw error;
  }
  return {
    bytes: await boundedBytes(response, META_ORGANIC_MAX_SOURCE_BYTES),
    contentType: cleanString(response.headers.get('content-type'), 120).split(';')[0],
    objectVersion: objectVersionFromHeaders(response.headers),
  };
}

export function createSupabasePodAssetStorage({ fetchImpl = fetch, config = getSupabaseServiceConfig() } = {}) {
  const baseUrl = config.url.replace(/\/$/, '');
  return {
    async readPodAsset({ userId, podId, storagePath }) {
      const path = assertPodAssetPath({ userId, podId, storagePath });
      return readStorageObject({ baseUrl, config, fetchImpl, objectPath: path });
    },

    async putImmutableObject(path, bytes, options = {}) {
      const objectPath = assertExportPath(path);
      const body = Buffer.from(bytes || []);
      if (!body.byteLength) throw Object.assign(new Error('Export bytes are required.'), { code: 'EXPORT_BYTES_REQUIRED' });
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/${POD_ASSETS_BUCKET}/${encodeObjectPath(objectPath)}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...serviceHeaders(config, options.contentType || 'image/jpeg'),
          'Cache-Control': options.cacheControl || 'public, max-age=31536000, immutable',
          'x-upsert': 'false',
        },
        body,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      assertNoRedirect(response);
      if (!response.ok) {
        if (response.status === 409 || response.status === 400) {
          const existing = await readStorageObject({ baseUrl, config, fetchImpl, objectPath, code: 'EXPORT_OBJECT_IMMUTABLE' });
          if (sha256Hex(existing.bytes) === sha256Hex(body) && existing.bytes.byteLength === body.byteLength && existing.contentType === (options.contentType || 'image/jpeg')) {
            return { path: objectPath, objectVersion: existing.objectVersion };
          }
        }
        const error = new Error(response.status === 409 || response.status === 400 ? 'Immutable export object already exists or was refused.' : 'Private pod asset storage denied the export.');
        error.status = response.status;
        error.code = response.status === 409 || response.status === 400 ? 'EXPORT_OBJECT_IMMUTABLE' : 'EXPORT_STORAGE_UNAVAILABLE';
        throw error;
      }
      return { path: objectPath, objectVersion: objectVersionFromHeaders(response.headers) };
    },

    async createReadOnlySignedUrl(path, ttlSeconds) {
      const objectPath = assertExportPath(path);
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/sign/${POD_ASSETS_BUCKET}/${encodeObjectPath(objectPath)}`, {
        method: 'POST',
        redirect: 'manual',
        headers: serviceHeaders(config, 'application/json'),
        body: JSON.stringify({ expiresIn: ttlSeconds }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      assertNoRedirect(response);
      if (!response.ok) {
        const error = new Error('Private pod asset storage could not create a bounded signed URL.');
        error.status = response.status;
        error.code = 'EXPORT_SIGNED_URL_UNAVAILABLE';
        throw error;
      }
      const payload = await response.json().catch(() => ({}));
      const signed = cleanString(payload.signedURL || payload.signedUrl || payload.url, 2000);
      const url = signed.startsWith('http')
        ? signed
        : signed.startsWith('/storage/v1/')
          ? `${baseUrl}${signed}`
          : `${baseUrl}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
      const parsed = new URL(url);
      const base = new URL(baseUrl);
      const expectedPath = `/storage/v1/object/sign/${POD_ASSETS_BUCKET}/${encodeObjectPath(objectPath)}`;
      if (parsed.origin !== base.origin || parsed.pathname !== expectedPath || !parsed.search) {
        throw Object.assign(new Error('Private pod asset storage returned an invalid signed URL.'), { code: 'EXPORT_SIGNED_URL_INVALID' });
      }
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    },
  };
}

function unsafeIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0) || a >= 224;
}

function unsafeIpv6(address) {
  const value = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = value.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return unsafeIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return !/^[23]/.test(value) || value.startsWith('2001:db8:');
}

function unsafeIp(address) {
  const version = isIP(address);
  if (version === 4) return unsafeIpv4(address);
  if (version === 6) return unsafeIpv6(address);
  return true;
}

async function validatePublicUrl(url) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || (parsed.port && !['80', '443'].includes(parsed.port))) {
    throw Object.assign(new Error('Source image URL is not eligible.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw Object.assign(new Error('Source image URL is not public.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
  }
  if (isIP(host)) {
    if (unsafeIp(host)) throw Object.assign(new Error('Source image URL is not public.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
    return { url: parsed, hostname: host, addresses: [{ address: host, family: isIP(host) }] };
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((record) => unsafeIp(record.address))) {
    throw Object.assign(new Error('Source image host resolves to a non-public address.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
  }
  return { url: parsed, hostname: host, addresses: records.map(({ address }) => ({ address, family: isIP(address) })) };
}

export function fetchPinnedImage(target, { signal, headers = {} } = {}) {
  const { url, hostname, addresses } = target;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      agent: false,
      signal,
      headers: { ...headers, Host: url.host, 'Accept-Encoding': 'identity' },
      ...(url.protocol === 'https:' ? {
        servername: isIP(hostname) ? '' : hostname,
        rejectUnauthorized: true,
        ...(isIP(hostname) === 6 ? {
          checkServerIdentity(_host, certificate) {
            try {
              if (new X509Certificate(certificate.raw).checkIP(hostname)) return undefined;
            } catch {
              // Malformed certificates fail below.
            }
            return new Error('The source image certificate does not match its IP address.');
          },
        } : {}),
      } : {}),
      lookup(requestHost, options, callback) {
        if (requestHost.toLowerCase().replace(/\.$/, '') !== hostname) {
          callback(Object.assign(new Error('Source image host changed during fetch.'), { code: 'EXPORT_SOURCE_URL_INVALID' }));
          return;
        }
        const family = typeof options === 'number' ? options : options.family;
        const eligible = addresses.filter((entry) => !family || entry.family === family);
        if (!eligible.length) callback(Object.assign(new Error('Source image host is not eligible.'), { code: 'EXPORT_SOURCE_URL_INVALID' }));
        else if (options.all) callback(null, eligible);
        else callback(null, eligible[0].address, eligible[0].family);
      },
    }, (response) => {
      let total = 0;
      const chunks = [];
      let settled = false;
      const fail = (error) => { if (!settled) { settled = true; reject(error); } };
      response.on('error', fail);
      response.on('aborted', () => fail(Object.assign(new Error('Source image response was aborted.'), { code: 'EXPORT_SOURCE_UNAVAILABLE' })));
      response.on('data', (chunk) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > META_ORGANIC_MAX_SOURCE_BYTES) {
          const error = Object.assign(new Error('Artwork source is too large.'), { code: 'EXPORT_SOURCE_TOO_LARGE' });
          fail(error);
          response.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: { get(name) {
            const value = response.headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value ?? null;
          } },
          bytes: Buffer.concat(chunks, total),
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

export function createReviewedSourceFetcher({ fetchImpl = fetchPinnedImage } = {}) {
  return {
    async fetchReviewedSourceImage({ url }) {
      let current = await validatePublicUrl(url);
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const response = await fetchImpl(current, {
          headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg;q=0.9' },
          signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = response.headers.get('location');
          if (!next || redirects === MAX_REDIRECTS) throw Object.assign(new Error('Source image redirect is not eligible.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
          current = await validatePublicUrl(new URL(next, current.url).toString());
          continue;
        }
        if (!response.ok) {
          const error = new Error('Reviewed source image could not be fetched.');
          error.status = response.status;
          error.code = 'EXPORT_SOURCE_UNAVAILABLE';
          throw error;
        }
        const bytes = response.bytes ? Buffer.from(response.bytes) : await boundedBytes(response);
        const revision = cleanString(response.headers.get('etag') || response.headers.get('last-modified'), 300) || sha256Hex(bytes);
        return {
          bytes,
          contentType: cleanString(response.headers.get('content-type'), 120).split(';')[0],
          revision,
        };
      }
      throw Object.assign(new Error('Source image redirect is not eligible.'), { code: 'EXPORT_SOURCE_URL_INVALID' });
    },
  };
}
