import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { Socket, isIP } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { fetchWebsiteText, validatePublicWebsiteUrl } from '../api/_lib/webSource.js';
import { key, cert } from './fixtures/webSourceTls.js';

function writeChunkedBody(response, body, encoding, finish = true) {
  response.writeHead(200, {
    'content-type': 'text/plain', 'transfer-encoding': 'chunked',
    ...(encoding ? { 'content-encoding': encoding } : {}),
  });
  let offset = 0;
  const writeNext = () => {
    if (response.destroyed) return;
    const end = Math.min(offset + 65_537, body.byteLength);
    response.write(body.subarray(offset, end));
    offset = end;
    if (offset < body.byteLength) setImmediate(writeNext);
    else if (finish) response.end();
  };
  writeNext();
}

function responseClosed(response) {
  return Promise.all([
    new Promise((resolve) => response.once('close', resolve)),
    new Promise((resolve) => response.socket.once('close', resolve)),
  ]);
}

async function assertClosedWithin(closed) {
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The response and socket did not close')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function mockDns(t, resolveAddresses) {
  const lookups = [];
  t.mock.method(dns.promises, 'lookup', async (hostname, options) => {
    lookups.push(hostname);
    assert.deepEqual(options, { all: true, verbatim: true });
    return resolveAddresses(hostname);
  });
  const originalDnsLookup = dns.lookup;
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    if (isIP(hostname)) return originalDnsLookup(hostname, options, callback);
    callback(new Error('The transport must not perform another DNS lookup'));
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return lookups;
}

async function localWire(t, handler, { secure = false, trustCertificate = true } = {}) {
  const requests = [];
  const selectedAddresses = [];
  const connections = [];
  const serve = (request, response) => {
    requests.push({ host: request.headers.host, path: request.url, servername: request.socket.servername });
    handler(request, response);
  };
  const server = secure ? https.createServer({ key, cert }, serve) : http.createServer(serve);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  // Observe the actual transport-selected addresses, then replace only the
  // external wire with a local TCP server. HTTP and TLS themselves stay real.
  const originalConnect = Socket.prototype.connect;
  t.mock.method(Socket.prototype, 'connect', function (...args) {
    const normalized = Array.isArray(args[0]);
    const options = { ...(normalized ? args[0][0] : args[0]) };
    connections.push({ hostname: options.host, port: Number(options.port), signal: options.signal });
    options.port = server.address().port;
    if (isIP(options.host)) {
      selectedAddresses.push([{ address: options.host, family: isIP(options.host) }]);
      options.host = '127.0.0.1';
    } else {
      const transportLookup = options.lookup || dns.lookup;
      options.lookup = (hostname, lookupOptions, callback) => {
        transportLookup(hostname, lookupOptions, (error, address, family) => {
          if (error) return callback(error);
          selectedAddresses.push(lookupOptions.all ? address : [{ address, family }]);
          if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
          else callback(null, '127.0.0.1', 4);
        });
      };
    }
    const mappedArgs = normalized ? [options, ...args[0].slice(1), ...args.slice(1)] : [options, ...args.slice(1)];
    return originalConnect.apply(this, mappedArgs);
  });
  if (secure && trustCertificate) {
    const originalTlsConnect = tls.connect;
    t.mock.method(tls, 'connect', function (options, ...args) {
      // Trust only this test fixture; hostname verification remains enabled.
      return originalTlsConnect.call(this, { ...options, ca: cert }, ...args);
    });
  }
  return { requests, selectedAddresses, connections };
}

test('DNS rebinding cannot open a private connection or request after public validation', async (t) => {
  let privateConnections = 0;
  let privateRequests = 0;
  const sentinel = http.createServer((_request, response) => {
    privateRequests += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('PRIVATE SENTINEL: must never be requested');
  });
  sentinel.on('connection', () => { privateConnections += 1; });
  await new Promise((resolve, reject) => {
    sentinel.once('error', reject);
    sentinel.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    sentinel.closeAllConnections();
    await new Promise((resolve) => sentinel.close(resolve));
  });

  let validationLookups = 0;
  t.mock.method(dns.promises, 'lookup', async (hostname) => {
    assert.equal(hostname, 'rebind-safe.test');
    validationLookups += 1;
    return [{ address: '93.184.216.34', family: 4 }];
  });
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    assert.equal(hostname, 'rebind-safe.test');
    queueMicrotask(() => {
      if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
    });
  });
  syncBuiltinESMExports();

  // Map only the port to an ephemeral sentinel. DNS and the HTTP socket are real;
  // the unsafe address still comes from the transport's second DNS resolution.
  const originalConnect = Socket.prototype.connect;
  t.mock.method(Socket.prototype, 'connect', function (...args) {
    const socketOptions = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (socketOptions?.host === 'rebind-safe.test') {
      socketOptions.port = sentinel.address().port;
      this.on('lookup', (_error, address) => {
        // A pinned public connection is stopped before touching an external network.
        if (address !== '127.0.0.1') this.destroy(new Error('Public test connection stopped'));
      });
    }
    return originalConnect.apply(this, args);
  });

  const result = await fetchWebsiteText('http://rebind-safe.test', { timeoutMs: 500 }).catch((error) => error);
  assert.equal(validationLookups, 1);
  assert.equal(privateConnections, 0, 'public validation must never lead to a private socket');
  assert.equal(privateRequests, 0, 'the private HTTP sentinel must never receive a request');
  assert.ok(result instanceof Error, 'the stopped public test connection must fail closed');
});

test('public IPv6 literals do not require DNS and mapped private IPv6 is rejected', async (t) => {
  const lookups = mockDns(t, () => { throw new Error('Literal addresses must not use DNS'); });
  assert.equal((await validatePublicWebsiteUrl('https://[2606:4700:4700::1111]')).href, 'https://[2606:4700:4700::1111]/');
  for (const address of ['::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'ff02::1']) {
    await assert.rejects(() => validatePublicWebsiteUrl(`http://[${address}]`), /public website/i);
  }
  assert.deepEqual(lookups, []);
});

test('DNS answers containing a private IPv6-mapped address are rejected before transport', async (t) => {
  mockDns(t, () => [
    { address: '8.8.8.8', family: 4 },
    { address: '::ffff:7f00:1', family: 6 },
  ]);
  await assert.rejects(() => validatePublicWebsiteUrl('https://mixed-private.test'), /public website/i);
});

test('an injected fetch cannot silently return a different final target', async () => {
  const response = new Response('Wrong target', { headers: { 'content-type': 'text/plain' } });
  Object.defineProperty(response, 'url', { value: 'https://outside.test/admin' });
  await assert.rejects(() => fetchWebsiteText('https://8.8.8.8', {
    fetchImpl: async () => response,
  }), /redirected|target|public website/i);
});

test('HTTP connects to all and only validated public addresses and retains Host and request path', async (t) => {
  const publicAddresses = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
  const lookups = mockDns(t, () => publicAddresses);
  const wire = await localWire(t, (request, response) => {
    assert.equal(request.headers['user-agent'], 'DovroynWebsiteAnalyzer/1.0');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Public page</title><main>Readable public evidence</main>');
  });
  const page = await fetchWebsiteText('http://public-wire.test/about?from=home#section');
  assert.equal(page.title, 'Public page');
  assert.match(page.text, /Readable public evidence/);
  assert.deepEqual(wire.requests.map(({ host, path }) => ({ host, path })), [{ host: 'public-wire.test', path: '/about?from=home' }]);
  assert.deepEqual(wire.selectedAddresses, [publicAddresses]);
  assert.deepEqual(lookups, ['public-wire.test']);
});

for (const [rawUrl, hostname, port, secure] of [
  ['http://public-wire.test:80', 'public-wire.test', 80, false],
  ['http://public-wire.test:443', 'public-wire.test', 443, false],
  ['https://public-wire.test', 'public-wire.test', 443, true],
  ['https://public-wire.test:443', 'public-wire.test', 443, true],
  ['https://public-wire.test:80', 'public-wire.test', 80, true],
  ['http://8.8.8.8', '8.8.8.8', 80, false],
  ['http://[2606:4700:4700::1111]', '2606:4700:4700::1111', 80, false],
  ['https://8.8.8.8', '8.8.8.8', 443, true],
  ['https://[2606:4700:4700::1111]', '2606:4700:4700::1111', 443, true],
]) {
  test(`the pinned transport preserves protocol, port, and authority for ${rawUrl}`, async (t) => {
    mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
    const wire = await localWire(t, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('Public wire content');
    }, { secure });
    assert.equal((await fetchWebsiteText(rawUrl)).text, 'Public wire content');
    assert.deepEqual(wire.connections.map(({ hostname, port }) => ({ hostname, port })), [{ hostname, port }]);
    assert.equal(wire.requests[0].host, new URL(rawUrl).host);
    if (secure) assert.equal(wire.requests[0].servername, isIP(hostname) ? false : hostname);
  });
}

for (const [label, rawUrl, trustCertificate, expectedAddress] of [
  ['mismatched hostname', 'https://wrong-wire.test', true, { address: '8.8.8.8', family: 4 }],
  ['mismatched IPv6 IP SAN', 'https://[2606:4700:4700::1001]', true, { address: '2606:4700:4700::1001', family: 6 }],
  ['untrusted certificate', 'https://public-wire.test', false, { address: '8.8.8.8', family: 4 }],
]) {
  test(`HTTPS rejects a ${label} before sending any HTTP request`, async (t) => {
    mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
    const wire = await localWire(t, (_request, response) => response.end('Must not be read'), { secure: true, trustCertificate });
    await assert.rejects(() => fetchWebsiteText(rawUrl), { status: 422 });
    assert.equal(wire.requests.length, 0);
    assert.deepEqual(wire.selectedAddresses, [[expectedAddress]]);
  });
}

test('relative and root cross-origin redirect hops each resolve and pin their own address snapshot', async (t) => {
  let hop = 0;
  const lookups = mockDns(t, () => [{ address: ['8.8.8.8', '8.8.4.4', '1.1.1.1'][hop++], family: 4 }]);
  const wire = await localWire(t, (request, response) => {
    if (request.url === '/') response.writeHead(302, { location: '/next' }).end();
    else if (request.url === '/next') response.writeHead(302, { location: 'http://redirect-wire.test/final' }).end();
    else response.writeHead(200, { 'content-type': 'text/plain' }).end('Final public evidence');
  });
  const page = await fetchWebsiteText('http://public-wire.test');
  assert.equal(page.url, 'http://redirect-wire.test/final');
  assert.equal(page.text, 'Final public evidence');
  assert.deepEqual(lookups, ['public-wire.test', 'public-wire.test', 'redirect-wire.test']);
  assert.deepEqual(wire.selectedAddresses, [
    [{ address: '8.8.8.8', family: 4 }], [{ address: '8.8.4.4', family: 4 }], [{ address: '1.1.1.1', family: 4 }],
  ]);
});

for (const [label, fetchOptions, location, destinationAddresses] of [
  ['private literal', {}, 'http://127.0.0.1/private', []],
  ['private DNS answer', {}, 'http://redirect-wire.test/private', [{ address: '127.0.0.1', family: 4 }]],
  ['redirect policy rejection', { redirectPolicy: () => false }, 'http://redirect-wire.test/blocked', [{ address: '1.1.1.1', family: 4 }]],
  ['redirect limit', { maxRedirects: 0 }, '/next', []],
]) {
  test(`a ${label} never causes a destination connection or request`, async (t) => {
    let hop = 0;
    mockDns(t, () => hop++ ? destinationAddresses : [{ address: '8.8.8.8', family: 4 }]);
    const wire = await localWire(t, (_request, response) => response.writeHead(302, { location }).end());
    await assert.rejects(() => fetchWebsiteText('http://public-wire.test', fetchOptions), /public website|redirected/i);
    assert.equal(wire.connections.length, 1);
    assert.equal(wire.requests.length, 1);
    assert.deepEqual(wire.selectedAddresses, [[{ address: '8.8.8.8', family: 4 }]]);
  });
}

test('real HTTP streaming stops at the one-megabyte ceiling and closes the response', async (t) => {
  mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  let closed;
  const wire = await localWire(t, (_request, response) => {
    closed = new Promise((resolve) => response.once('close', resolve));
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write(Buffer.alloc(1_000_001, 65));
  });
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test', { maxPageBytes: 2_000_000 }), /too large/i);
  await closed;
  assert.equal(wire.requests.length, 1);
});

test('real HTTP rejects an oversized declared length without waiting for the full body', async (t) => {
  mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  let closed;
  await localWire(t, (_request, response) => {
    closed = new Promise((resolve) => response.once('close', resolve));
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000001' });
    response.write('Prefix only');
  });
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test'), /too large/i);
  await closed;
});

for (const phase of ['headers', 'stream']) {
  test(`request timeout aborts an actual connection stalled at ${phase}`, async (t) => {
    mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
    let closed;
    await localWire(t, (_request, response) => {
      closed = new Promise((resolve) => response.once('close', resolve));
      if (phase === 'stream') response.writeHead(200, { 'content-type': 'text/plain' }).write('Incomplete body');
    });
    await assert.rejects(() => fetchWebsiteText('http://public-wire.test', { timeoutMs: 50 }), { status: 422 });
    await closed;
  });
}

test('a pre-aborted caller never triggers DNS validation or a transport connection', async (t) => {
  const lookups = mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  const wire = await localWire(t, (_request, response) => response.end('Must not be requested'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test', { signal: controller.signal }), { status: 422 });
  assert.deepEqual(lookups, []);
  assert.equal(wire.connections.length, 0);
  assert.equal(wire.requests.length, 0);
});

test('DNS resolution is bounded by the request timeout and cannot schedule a late connection', async (t) => {
  let finishLookup;
  mockDns(t, () => new Promise((resolve) => { finishLookup = resolve; }));
  const wire = await localWire(t, (_request, response) => response.end('Must not be requested'));
  const pendingFetch = fetchWebsiteText('http://public-wire.test', { timeoutMs: 20 }).catch((error) => error);
  const result = await Promise.race([
    pendingFetch,
    new Promise((resolve) => { const timer = setTimeout(() => resolve('UNBOUNDED DNS'), 200); timer.unref(); }),
  ]);
  finishLookup([{ address: '8.8.8.8', family: 4 }]);
  await pendingFetch;
  await new Promise(setImmediate);
  assert.ok(result instanceof Error, 'DNS validation must respect the configured timeout');
  assert.equal(result.status, 422);
  assert.equal(wire.connections.length, 0);
});

test('compressed website text is decoded with the same bounded readable semantics', async (t) => {
  mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  await localWire(t, (_request, response) => response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end(gzipSync('Public compressed evidence')));
  assert.equal((await fetchWebsiteText('http://public-wire.test')).text, 'Public compressed evidence');
});

test('chunked gzip empty members cannot bypass the encoded one-megabyte ceiling', async (t) => {
  mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  const encoded = Buffer.concat([
    ...Array(55_000).fill(gzipSync('')),
    gzipSync('Public wire evidence'),
  ]);
  assert.equal(encoded.byteLength, 1_100_040);
  let closed;
  await localWire(t, (_request, response) => {
    closed = responseClosed(response);
    response.writeHead(200, {
      'content-type': 'text/plain', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked',
    });
    response.write(encoded.subarray(0, 500_003));
    response.end(encoded.subarray(500_003));
  });
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test'), /too large/i);
  await assertClosedWithin(closed);
});

for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
  for (const byteLength of [1_000_000, 1_000_001]) {
    test(`${encoding} encoded ${byteLength} bytes are ${byteLength === 1_000_000 ? 'accepted' : 'rejected'} across HTTP chunks`, async (t) => {
      mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
      const content = compress('Public wire evidence');
      // Node's decoders accept zero padding; decoded content stays only 20 bytes.
      const encoded = Buffer.concat([content, Buffer.alloc(byteLength - content.byteLength)]);
      let closed;
      await localWire(t, (_request, response) => {
        closed = responseClosed(response);
        // Over-limit responses deliberately never end: the cap must close them.
        writeChunkedBody(response, encoded, encoding, byteLength === 1_000_000);
      });
      const pending = fetchWebsiteText('http://public-wire.test', { timeoutMs: 1_500 });
      if (byteLength === 1_000_000) assert.equal((await pending).text, 'Public wire evidence');
      else await assert.rejects(() => pending, /too large/i);
      await assertClosedWithin(closed);
    });

    test(`${encoding} decoded ${byteLength} bytes are ${byteLength === 1_000_000 ? 'accepted' : 'rejected'} without an encoded limit breach`, async (t) => {
      mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
      const encoded = compress(Buffer.alloc(byteLength, 65));
      assert.ok(encoded.byteLength < 1_000_000);
      let closed;
      await localWire(t, (_request, response) => {
        closed = responseClosed(response);
        writeChunkedBody(response, encoded, encoding, byteLength === 1_000_000);
      });
      const pending = fetchWebsiteText('http://public-wire.test', { timeoutMs: 1_500 });
      if (byteLength === 1_000_000) assert.equal((await pending).text, 'A'.repeat(14_000));
      else await assert.rejects(() => pending, /too large/i);
      await assertClosedWithin(closed);
    });
  }

  test(`${encoding} encoded bytes respect a caller's lower page limit`, async (t) => {
    mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
    const encoded = compress('Public wire evidence');
    assert.ok(encoded.byteLength > 20, 'this fixture isolates the encoded limit from the smaller decoded content');
    const closed = [];
    await localWire(t, (_request, response) => {
      closed.push(responseClosed(response));
      writeChunkedBody(response, encoded, encoding);
    });
    assert.equal((await fetchWebsiteText('http://public-wire.test', { maxPageBytes: encoded.byteLength })).text, 'Public wire evidence');
    await assert.rejects(() => fetchWebsiteText('http://public-wire.test', { maxPageBytes: encoded.byteLength - 1 }), /too large/i);
    await assertClosedWithin(Promise.all(closed));
  });
}

for (const byteLength of [1_000_000, 1_000_001]) {
  test(`uncompressed ${byteLength} bytes are ${byteLength === 1_000_000 ? 'accepted' : 'rejected'} across HTTP chunks`, async (t) => {
    mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
    let closed;
    await localWire(t, (_request, response) => {
      closed = responseClosed(response);
      writeChunkedBody(response, Buffer.alloc(byteLength, 65), '', byteLength === 1_000_000);
    });
    const pending = fetchWebsiteText('http://public-wire.test', { timeoutMs: 1_500 });
    if (byteLength === 1_000_000) assert.equal((await pending).text, 'A'.repeat(14_000));
    else await assert.rejects(() => pending, /too large/i);
    await assertClosedWithin(closed);
  });
}

test('the one-megabyte ceiling also applies to decompressed website bytes', async (t) => {
  mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  await localWire(t, (_request, response) => response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end(gzipSync(Buffer.alloc(1_000_001, 65))));
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test'), /too large/i);
});

for (const encoding of ['constructor', '__proto__', 'unsupported']) {
  test(`untrusted content encoding ${encoding} fails closed without escaping the transport handler`, async (t) => {
    mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
    await localWire(t, (_request, response) => response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding }).end('Untrusted encoding'));
    await assert.rejects(() => fetchWebsiteText('http://public-wire.test', { timeoutMs: 50 }), { status: 422 });
  });
}

for (const [encoding, compress] of [['deflate', deflateSync], ['br', brotliCompressSync]]) {
  test(`${encoding} decoding preserves website text`, async (t) => {
    mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
    await localWire(t, (_request, response) => response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding }).end(compress('Public encoded evidence')));
    assert.equal((await fetchWebsiteText('http://public-wire.test')).text, 'Public encoded evidence');
  });
}

test('malformed compressed data rejects cleanly', async (t) => {
  mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  await localWire(t, (_request, response) => response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end('Not a gzip stream'));
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test'), { status: 422 });
});

test('a caller abort during real streaming closes the connection before the timeout fires', async (t) => {
  mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  const controller = new AbortController();
  let closed;
  let timeoutCalls = 0;
  const originalSetTimeout = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => originalSetTimeout(() => {
    if (milliseconds === 500) timeoutCalls += 1;
    callback(...args);
  }, milliseconds));
  await localWire(t, (_request, response) => {
    closed = new Promise((resolve) => response.once('close', resolve));
    response.writeHead(200, { 'content-type': 'text/plain' }).write('Interrupted evidence');
    controller.abort();
  });
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test', { signal: controller.signal, timeoutMs: 500 }), { status: 422 });
  await closed;
  assert.equal(timeoutCalls, 0, 'caller cancellation must close the request before its timeout');
});

test('a validated address snapshot cannot be changed by later mutation of the resolver result', async (t) => {
  const addresses = [{ address: '8.8.8.8', family: 4 }];
  mockDns(t, () => addresses);
  const wire = await localWire(t, (_request, response) => response.writeHead(200, { 'content-type': 'text/plain' }).end('Pinned snapshot'));
  assert.equal((await fetchWebsiteText('http://public-wire.test', {
    validateUrl: async (rawUrl) => {
      const url = await validatePublicWebsiteUrl(rawUrl);
      addresses[0].address = '127.0.0.1';
      return url;
    },
  })).text, 'Pinned snapshot');
  assert.deepEqual(wire.selectedAddresses, [[{ address: '8.8.8.8', family: 4 }]]);
});

test('exact byte limits are accepted and the readable output limit remains independent', async (t) => {
  mockDns(t, () => [{ address: '2606:4700:4700::1111', family: 6 }]);
  const wire = await localWire(t, (_request, response) => response.writeHead(200, { 'content-type': 'text/plain' }).end('éééé'));
  assert.equal((await fetchWebsiteText('http://public-wire.test', { maxPageBytes: 8, maxReadableChars: 3 })).text, 'ééé');
  assert.deepEqual(wire.selectedAddresses, [[{ address: '2606:4700:4700::1111', family: 6 }]]);
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test', { maxPageBytes: 7 }), /too large/i);
});

test('unsupported schemes, credentials, unsafe ports, and absent schemes remain rejected', async (t) => {
  const lookups = mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  for (const rawUrl of ['public-wire.test', '//public-wire.test', 'file:///etc/passwd', 'ftp://public-wire.test', 'https://user:secret@public-wire.test', 'https://public-wire.test:444']) {
    await assert.rejects(() => validatePublicWebsiteUrl(rawUrl), /public website/i);
  }
  assert.deepEqual(lookups, []);
});

test('missing or mutated validation proof fails closed without a connection', async (t) => {
  mockDns(t, () => [{ address: '8.8.8.8', family: 4 }]);
  const wire = await localWire(t, (_request, response) => response.end('Must not be requested'));
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test', { validateUrl: async (rawUrl) => new URL(rawUrl) }), /public website/i);
  await assert.rejects(() => fetchWebsiteText('http://public-wire.test', {
    validateUrl: async (rawUrl) => {
      const url = await validatePublicWebsiteUrl(rawUrl);
      url.hostname = '127.0.0.1';
      return url;
    },
  }), /public website/i);
  assert.equal(wire.connections.length, 0);
  assert.equal(wire.requests.length, 0);
});
