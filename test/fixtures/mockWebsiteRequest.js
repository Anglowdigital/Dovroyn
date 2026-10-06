import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

// Endpoint fixtures retain their provider/database fetch mocks. Only website
// requests are adapted to the new built-in transport; no real socket is opened.
export function mockWebsiteRequest() {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const request = (url, options, onResponse) => {
    const pending = new EventEmitter();
    let body;
    const removeListener = () => options.signal?.removeEventListener('abort', abort);
    const abort = () => {
      if (body) body.destroy();
      else pending.emit('error', options.signal.reason);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    pending.end = () => {
      Promise.resolve().then(() => {
        options.signal?.throwIfAborted();
        return globalThis.fetch(url, { ...options, redirect: 'manual' });
      }).then((response) => {
        if (options.signal?.aborted) {
          response.body?.cancel().catch(() => undefined);
          return;
        }
        body = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
        body.statusCode = response.status;
        body.headers = Object.fromEntries(response.headers);
        body.once('close', removeListener);
        onResponse(body);
      }).catch((error) => {
        removeListener();
        pending.emit('error', error);
      });
    };
    return pending;
  };
  http.request = request;
  https.request = request;
  syncBuiltinESMExports();
  return () => {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    syncBuiltinESMExports();
  };
}
