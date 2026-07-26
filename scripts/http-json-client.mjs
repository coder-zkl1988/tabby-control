import http from 'node:http';
import https from 'node:https';

export function requestJson(url, options = {}, timeoutMs = 10_000) {
  const target = new URL(url);
  const transport = target.protocol === 'https:'
    ? https
    : target.protocol === 'http:'
      ? http
      : null;

  if (transport == null) {
    return Promise.reject(new Error(`Unsupported protocol: ${target.protocol}`));
  }

  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const request = transport.request(
      target,
      {
        method: options.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...options.headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('aborted', () => {
          finish(reject, new Error(`${url} response aborted`));
        });
        response.once('error', (error) => finish(reject, error));
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body;
          try {
            body = text === '' ? {} : JSON.parse(text);
          } catch {
            finish(reject, new Error(`${url} returned non-JSON: ${text.slice(0, 200)}`));
            return;
          }

          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            finish(reject, new Error(`${url} HTTP ${statusCode}: ${JSON.stringify(body)}`));
            return;
          }
          finish(resolve, body);
        });
      },
    );

    timer = setTimeout(() => {
      request.destroy(new Error(`${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    request.once('error', (error) => finish(reject, error));

    if (options.body != null) request.write(options.body);
    request.end();
  });
}
