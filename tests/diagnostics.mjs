// Run with Node.js 22.18+ (native TypeScript stripping): node tests/diagnostics.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { testModelConnection, asModelError, ModelRequestError } from '../lib/llm/diagnostics.ts';

const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push({ url: req.url, body, headers: req.headers });
    const scenario = req.url.split('/')[1];
    const send = () => {
      if (res.destroyed) return;
      if (/^\d+$/.test(scenario)) {
        res.writeHead(Number(scenario), { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'tool unsupported, leaked-key-123' } }));
      } else if (scenario === 'invalid-json') {
        res.end('<html>leaked-key-123</html>');
      } else {
        res.setHeader('content-type', 'application/json');
        if (scenario === 'bad-shape') res.end('{}');
        else if (scenario === 'no-tool') res.end(JSON.stringify({ choices: [{ message: { content: 'Hello' } }] }));
        else if (scenario === 'bad-args') res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'tabagent_connection_probe', arguments: '{bad}' } }] } }] }));
        else if (req.url.endsWith('/v1/messages')) res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'tabagent_connection_probe', input: { value: 'tabagent-ok' } }] }));
        else res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'tabagent_connection_probe', arguments: '{"value":"tabagent-ok"}' } }] } }] }));
      }
    };
    if (scenario === 'slow') setTimeout(send, 150);
    else send();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const settings = {
  provider: 'openai', openaiBaseUrl: `${base}/good`, openaiApiKey: '', openaiModel: 'mock',
  anthropicBaseUrl: `${base}/good`, anthropicApiKey: 'test-key', anthropicModel: 'mock-anthropic',
  effort: 'medium', maxSteps: 40,
};
const probe = (scenario, signal = new AbortController().signal, timeout = 1000) =>
  testModelConnection({ ...settings, openaiBaseUrl: `${base}/${scenario}` }, signal, timeout);

try {
  const result = await probe('good');
  assert.equal(result.model, 'mock');
  assert.ok(result.elapsedMs >= 0);
  assert.equal(seen.at(-1).headers.authorization, undefined, 'Local services may omit a key');
  assert.equal(seen.at(-1).body.tools.length, 1);
  assert.equal(seen.at(-1).body.messages.length, 1);
  assert.equal(seen.at(-1).body.messages[0].role, 'user');
  assert.equal(seen.at(-1).body.tool_choice.function.name, 'tabagent_connection_probe');

  const claude = await testModelConnection({ ...settings, provider: 'anthropic' }, new AbortController().signal);
  assert.equal(claude.model, 'mock-anthropic');
  assert.equal(seen.at(-1).headers['x-api-key'], 'test-key');
  assert.equal(seen.at(-1).body.tool_choice.name, 'tabagent_connection_probe');

  for (const [scenario, code] of [['401', 'auth'], ['403', 'auth'], ['404', 'not_found'], ['429', 'rate_limit'], ['400', 'tools'], ['503', 'server'], ['invalid-json', 'format'], ['bad-shape', 'format'], ['no-tool', 'tools'], ['bad-args', 'tools']]) {
    await assert.rejects(probe(scenario), (error) => {
      assert.ok(error instanceof ModelRequestError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('leaked-key-123'), false, 'Remote response must not expose keys');
      return true;
    });
  }
  const beforeTimeout = seen.length;
  await assert.rejects(probe('slow', undefined, 20), (error) => error.code === 'timeout');
  assert.equal(seen.length, beforeTimeout + 1, 'Probe must not automatically retry');
  const controller = new AbortController();
  const pending = probe('slow', controller.signal);
  const cancelTimer = setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
  clearTimeout(cancelTimer);
  const beforeCancelled = seen.length;
  await assert.rejects(probe('good', controller.signal), (error) => error.code === 'cancelled');
  assert.equal(seen.length, beforeCancelled, 'An already-cancelled probe sends no request');
  assert.equal(asModelError({ status: 401, message: 'secret' }).code, 'auth');
  assert.equal(asModelError({ name: 'APIConnectionTimeoutError' }).code, 'timeout');
  assert.equal(asModelError(new TypeError('secret')).code, 'network');
  console.log('✓ 连接诊断测试通过（OpenAI/Claude、鉴权、模型/地址、限流、格式、工具能力、超时、取消、错误脱敏）');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
