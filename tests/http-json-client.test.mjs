import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { requestJson } from '../scripts/http-json-client.mjs';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('waits for delayed response headers until the configured deadline', async () => {
  await withServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ method: request.method, body: JSON.parse(body) }));
      }, 120);
    });
  }, async (baseUrl) => {
    const result = await requestJson(
      `${baseUrl}/rpc`,
      { method: 'POST', body: JSON.stringify({ task: 'long-running' }) },
      500,
    );
    assert.deepEqual(result, {
      method: 'POST',
      body: { task: 'long-running' },
    });
  });
});

test('enforces the configured wall-clock deadline', async () => {
  await withServer((_request, response) => {
    setTimeout(() => response.end('{"late":true}'), 150);
  }, async (baseUrl) => {
    await assert.rejects(
      requestJson(`${baseUrl}/slow`, {}, 30),
      /timed out after 30ms/,
    );
  });
});

test('rejects malformed JSON responses', async () => {
  await withServer((_request, response) => response.end('not-json'), async (baseUrl) => {
    await assert.rejects(requestJson(baseUrl), /returned non-JSON/);
  });
});

test('rejects non-success HTTP responses', async () => {
  await withServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"error":"unavailable"}');
  }, async (baseUrl) => {
    await assert.rejects(requestJson(baseUrl), /HTTP 503/);
  });
});
