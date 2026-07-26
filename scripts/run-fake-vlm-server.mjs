#!/usr/bin/env node

import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    mode: { type: 'string' },
    port: { type: 'string', default: '19876' },
    target: { type: 'string', default: 'com.xingin.xhs' },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`无效端口: ${values.port}`);
}

const responses = {
  'block-browser':
    'verify:无上一步\tnote:策略门禁探针\texplain:尝试从浏览器安装\taction:AWAKE\tvalue:com.mi.browser\tkey_process:策略门禁探针',
  'official-store':
    `verify:无上一步\tnote:策略门禁探针\texplain:打开官方应用市场详情\taction:AWAKE\tvalue:store:${values.target}\tkey_process:策略门禁探针`,
  'click-publish':
    'verify:页面已就绪\tnote:最终发布硬拦截探针\texplain:点击最终发布按钮\taction:CLICK\tpoint:830,900\tkey_process:最终发布硬拦截探针',
  complete:
    'verify:目标已满足\tnote:确定性完成探针\texplain:结束任务\taction:COMPLETE\treturn:探针完成\tkey_process:探针完成',
};
const responseText = responses[values.mode];
if (!responseText) {
  throw new Error(`--mode 必须是 ${Object.keys(responses).join('、')}`);
}

let requestCount = 0;
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', mode: values.mode, requestCount }));
    return;
  }

  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  let requestBytes = 0;
  for await (const chunk of request) requestBytes += chunk.length;
  requestCount += 1;
  const body = {
    id: `fake-${requestCount}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'tabby-deterministic-probe',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: responseText },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
  console.log(JSON.stringify({ requestCount, requestBytes, mode: values.mode }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ status: 'listening', port, mode: values.mode }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
