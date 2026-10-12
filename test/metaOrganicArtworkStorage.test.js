import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createReviewedSourceFetcher, createSupabasePodAssetStorage, fetchPinnedImage } from '../api/_lib/metaOrganicArtworkStorage.js';

const config = { url: 'https://supabase.example', serviceRoleKey: 'service-role' };

function headers(values = {}) {
  return new Headers(values);
}

test('Supabase storage signs realistic relative URLs with storage prefix and rejects redirects', async () => {
  const calls = [];
  const objectPath = 'meta-organic-exports/u/p/post/a/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg';
  const storage = createSupabasePodAssetStorage({
    config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, 'Bearer service-role');
      return new Response(JSON.stringify({ signedURL: `/object/sign/pod-assets/${objectPath}?token=abc` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const signed = await storage.createReadOnlySignedUrl(objectPath, 14400);
  assert.equal(signed.url, `https://supabase.example/storage/v1/object/sign/pod-assets/${objectPath}?token=abc`);
  assert.equal(calls.length, 1);

  const wrongObject = createSupabasePodAssetStorage({
    config,
    fetchImpl: async () => new Response(JSON.stringify({ signedURL: '/object/sign/pod-assets/meta-organic-exports/u/p/post/a/c/hash.jpg?token=abc' }), { status: 200 }),
  });
  await assert.rejects(() => wrongObject.createReadOnlySignedUrl(objectPath, 14400), /invalid signed URL/i);

  const redirecting = createSupabasePodAssetStorage({
    config,
    fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }),
  });
  await assert.rejects(() => redirecting.readPodAsset({ userId: 'u', podId: 'p', storagePath: 'u/p/file.jpg' }), /redirected|denied/i);
});

test('storage reads stream with a hard byte cap even when content-length lies', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.close();
    },
  });
  const storage = createSupabasePodAssetStorage({
    config,
    fetchImpl: async () => new Response(stream, { status: 200, headers: headers({ 'Content-Type': 'image/jpeg', 'Content-Length': '1', ETag: 'v1' }) }),
  });
  await assert.rejects(() => storage.readPodAsset({ userId: 'u', podId: 'p', storagePath: 'u/p/file.jpg' }), /too large/i);
});

test('immutable storage retry accepts only an existing exact object', async () => {
  const objectPath = 'meta-organic-exports/u/p/post/a/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg';
  const bytes = Buffer.from('same-rendered-jpeg');
  const calls = [];
  const storage = createSupabasePodAssetStorage({
    config,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === 'POST') return new Response(JSON.stringify({ message: 'Asset Already Exists' }), { status: 400 });
      return new Response(bytes, { status: 200, headers: headers({ 'Content-Type': 'image/jpeg', ETag: 'existing-version' }) });
    },
  });
  const result = await storage.putImmutableObject(objectPath, bytes, { contentType: 'image/jpeg' });
  assert.equal(result.objectVersion, 'existing-version');
  assert.equal(calls.map((call) => call.method).join(','), 'POST,GET');

  const changed = createSupabasePodAssetStorage({
    config,
    fetchImpl: async (_url, options) => (options.method === 'POST'
      ? new Response(JSON.stringify({ message: 'Asset Already Exists' }), { status: 409 })
      : new Response(Buffer.from('different'), { status: 200, headers: headers({ 'Content-Type': 'image/jpeg', ETag: 'different-version' }) })),
  });
  await assert.rejects(() => changed.putImmutableObject(objectPath, bytes, { contentType: 'image/jpeg' }), /already exists|refused/i);
});

test('reviewed source fetcher uses pinned target transport and stable hash revision fallback', async () => {
  const calls = [];
  const bytes = Buffer.from('fake-image-bytes');
  const fetcher = createReviewedSourceFetcher({
    fetchImpl: async (target, options) => {
      calls.push({ target, options });
      assert.equal(target.hostname, '93.184.216.34');
      assert.ok(target.addresses.length, 'validated addresses are pinned into the fetch call');
      return {
        status: 200,
        ok: true,
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'image/jpeg' : null },
        bytes,
      };
    },
  });
  const result = await fetcher.fetchReviewedSourceImage({ url: 'http://93.184.216.34/photo.jpg' });
  assert.equal(result.revision, 'b0423673071359e7ff62ec7f2766b1bfe8682ee426b8d6672f8aab0619ba7648');
  assert.deepEqual(result.bytes, bytes);
  assert.equal(calls[0].options.headers.Accept.includes('image/jpeg'), true);
});

test('pinned source transport rejects oversized real responses without unhandled stream errors', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    for (let index = 0; index < 16; index += 1) res.write(Buffer.alloc(1024 * 1024));
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  await assert.rejects(() => fetchPinnedImage({
    url: new URL(`http://127.0.0.1:${port}/image.jpg`),
    hostname: '127.0.0.1',
    addresses: [{ address: '127.0.0.1', family: 4 }],
  }, { headers: { Accept: 'image/jpeg' } }), /too large/i);
});
