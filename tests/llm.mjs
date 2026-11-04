// Protocol regressions: streamed text/tools, interruption, JSON proxies and bounded context.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabagent-llm-test-'));
for (const name of ['diagnostics', 'streaming', 'context', 'openai', 'anthropic']) {
  const source = await fs.readFile(new URL(`../lib/llm/${name}.ts`, import.meta.url), 'utf8');
  let output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  output = output.replace(/from ['"]\.\/([^'"]+)['"]/g, 'from "./$1.mjs"').replace(/from ['"]@anthropic-ai\/sdk['"]/g, `from ${JSON.stringify(import.meta.resolve('@anthropic-ai/sdk'))}`);
  await fs.writeFile(path.join(dir, `${name}.mjs`), output);
}
const { OpenAISession } = await import(pathToFileURL(path.join(dir, 'openai.mjs')));
const { AnthropicSession } = await import(pathToFileURL(path.join(dir, 'anthropic.mjs')));
const { compactHistory, contextNotice, clipText, CONTEXT_CHAR_BUDGET } = await import(pathToFileURL(path.join(dir, 'context.mjs')));
const { fetchModelResponse } = await import(pathToFileURL(path.join(dir, 'diagnostics.mjs')));
const { readOpenAIResponse } = await import(pathToFileURL(path.join(dir, 'streaming.mjs')));
const seen = [];
const imageBytes = (value) => {
  if (!value || typeof value !== 'object') return [];
  if (value.type === 'image_url') return [value.image_url.url.split(',')[1]];
  if (value.type === 'image') return [value.source.data];
  return Object.values(value).flatMap(imageBytes);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let serial = 0;
const frame = (event) => `${event?.type ? `event: ${event.type}\r\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const anthropicEvents = (id) => [
  { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private-thought' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-value' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '，世界' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id, name: 'read_page', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"text_' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'only":true}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
  { type: 'message_stop' },
];

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (part) => { raw += part; });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const [, provider, scenario] = req.url.split('/');
    seen.push({ provider, scenario, body });
    const id = `call_${++serial}`;
    const native = provider === 'anthropic';
    if (scenario.startsWith('vision')) {
      const images = imageBytes(body);
      if (images.length && scenario === 'vision-reject') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'image not supported secret-key' } }));
        return;
      }
      const done = images.length > 0 || JSON.stringify(body.messages).includes('TEXT_ONLY_NEXT_TASK') || JSON.stringify(body.messages).includes('已分析当前截图');
      const names = ['capture_page', 'read_page', 'capture_page', 'capture_page'];
      const calls = names.map((name, i) => ({ id: `${id}_${i}`, name, input: scenario === 'vision-huge' ? { context: 'x'.repeat(60000) } : {} }));
      const content = done ? '已分析当前截图' : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(native
        ? { id, type: 'message', role: 'assistant', model: 'mock', stop_reason: done ? 'end_turn' : 'tool_use', content: done ? [{ type: 'text', text: content }] : calls.map((call) => ({ type: 'tool_use', ...call })), usage: { input_tokens: 1, output_tokens: 1 } }
        : { choices: [{ message: { content, ...(!done ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}) }, finish_reason: done ? 'stop' : 'tool_calls' }] }));
      return;
    }
    if (scenario === 'json' || scenario === 'context') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(native ? { id, type: 'message', role: 'assistant', model: 'mock', stop_reason: scenario === 'json' ? 'end_turn' : 'tool_use', content: scenario === 'json' ? [{ type: 'text', text: 'JSON兼容' }] : [{ type: 'tool_use', id, name: 'read_page', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } : { choices: [{ message: scenario === 'json' ? { content: 'JSON兼容' } : { content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_page', arguments: '{}' } }] } }] }));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    if (scenario === 'stall') { res.write(': waiting\n\n'); return; }
    let events = native ? anthropicEvents(id) : [
      chunk({ content: '你好' }), chunk({ content: '，世界' }),
      chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'read_', arguments: '{"text_' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'page', arguments: 'only":true}' } }] }),
      chunk({}, 'tool_calls'), '[DONE]',
    ];
    if (scenario === 'incomplete') events = events.slice(0, -2);
    if (scenario === 'bad-args') {
      if (native) events[11].delta.partial_json = 'bad}';
      else events[3].choices[0].delta.tool_calls[0].function.arguments = 'bad}';
    }
    if (scenario === 'length') {
      if (native) events[13].delta.stop_reason = 'max_tokens';
      else events[4].choices[0].finish_reason = 'length';
    }
    for (const event of events) {
      const bytes = Buffer.from(frame(event));
      // Split protocol lines and multibyte characters across transport chunks.
      for (let offset = 0; offset < bytes.length; offset += 7) res.write(bytes.subarray(offset, offset + 7));
      await pause(3);
      if (res.destroyed) return;
    }
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const options = { system: 'System: respect the current user goal.', tools: [{ name: 'read_page', description: 'Read the page', input_schema: { type: 'object', properties: { text_only: { type: 'boolean' } } } }] };
const make = (provider, scenario) => {
  const settings = { provider, openaiBaseUrl: `${base}/openai/${scenario}`, openaiApiKey: 'secret-key', openaiModel: 'mock', anthropicBaseUrl: `${base}/anthropic/${scenario}`, anthropicApiKey: 'secret-key', anthropicModel: 'mock', effort: 'medium', maxSteps: 40 };
  const session = provider === 'openai' ? new OpenAISession(settings, options) : new AnthropicSession(settings, options);
  session.addUserMessage('CURRENT_GOAL 请读取网页');
  return session;
};
const signal = () => new AbortController().signal;
const paired = (messages, native) => {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (native) {
      const calls = Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_use') : [];
      if (calls.length) {
        const results = messages[i + 1]?.content;
        assert.ok(Array.isArray(results), 'tool_use must be followed by tool results');
        assert.deepEqual(results.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id), calls.map((block) => block.id));
      }
      if (Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result')) assert.ok(messages[i - 1]?.content.some((block) => block.type === 'tool_use'));
    } else {
      if (message.tool_calls) assert.deepEqual(messages.slice(i + 1, i + 1 + message.tool_calls.length).map((next) => next.tool_call_id), message.tool_calls.map((call) => call.id));
      if (message.role === 'tool') assert.ok(messages.slice(0, i).some((prior) => prior.tool_calls?.some((call) => call.id === message.tool_call_id)));
    }
  }
};

try {
  for (const provider of ['openai', 'anthropic']) {
    const streamed = make(provider, 'stream');
    const deltas = [];
    let returned = false;
    const result = await streamed.step(signal(), (delta) => { assert.equal(returned, false); deltas.push(delta); });
    returned = true;
    assert.equal(result.text, '你好，世界');
    assert.deepEqual(deltas, ['你好', '，世界']);
    assert.equal(result.toolCalls[0].name, 'read_page');
    assert.deepEqual(result.toolCalls[0].input, { text_only: true });
    assert.equal(seen.at(-1).body.stream, true);
    streamed.addToolResults([{ id: result.toolCalls[0].id, content: 'page result', isError: false }]);
    await streamed.step(signal());
    if (provider === 'anthropic') {
      const previous = seen.at(-1).body.messages.find((message) => message.role === 'assistant');
      assert.equal(previous.content[0].thinking, 'private-thought');
      assert.equal(previous.content[0].signature, 'signed-value');
    }
    const fallback = [];
    assert.equal((await make(provider, 'json').step(signal(), (text) => fallback.push(text))).text, 'JSON兼容');
    assert.deepEqual(fallback, ['JSON兼容']);
    for (const scenario of ['incomplete', 'bad-args', 'length']) {
      await assert.rejects(make(provider, scenario).step(signal()), (error) => {
        assert.equal(error.message.includes('secret-key'), false);
        return true;
      }, `${provider} ${scenario} must reject before exposing tool calls`);
    }
    const cancel = new AbortController();
    await assert.rejects(make(provider, 'stream').step(cancel.signal, () => cancel.abort()), (error) => error.code === 'cancelled');
    const before = seen.length;
    await assert.rejects(make(provider, 'stream').step(cancel.signal), (error) => error.code === 'cancelled');
    assert.equal(seen.length, before, 'already cancelled calls do not reach the server');

    const long = make(provider, 'context');
    for (let i = 0; i < 12; i++) {
      const step = await long.step(signal());
      const request = seen.at(-1).body;
      assert.ok(JSON.stringify(request).length < CONTEXT_CHAR_BUDGET, 'request fits the configured character budget');
      assert.ok(JSON.stringify(request).includes('CURRENT_GOAL'), 'latest goal survives many tool iterations');
      paired(request.messages, provider === 'anthropic');
      long.addToolResults([{ id: step.toolCalls[0].id, content: `PAGE_${i}_START ${'网页内容'.repeat(3000)} PAGE_${i}_END`, isError: false }]);
    }
    const compacted = JSON.stringify(seen.at(-1).body);
    assert.ok(compacted.includes('早期会话已按长度预算压缩'));
    assert.ok(compacted.includes('PAGE_10_END'), 'most recent page tail survives compaction');
    long.restoreHistory(Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i} ${'历史'.repeat(6000)}` })));
    long.addUserMessage('最新目标 LAST_USER_GOAL');
    await long.step(signal());
    assert.ok(JSON.stringify(seen.at(-1).body).length < CONTEXT_CHAR_BUDGET);
    assert.ok(JSON.stringify(seen.at(-1).body).includes('LAST_USER_GOAL'));

    const screenshots = [0, 1, 2].map((n) => ({ mediaType: 'image/png', data: Buffer.alloc(70_000, n + 1).toString('base64'), width: 1280, height: 720 }));
    const resultsFor = (calls) => calls.map((call, i) => ({ id: call.id, content: i === 1 ? 'PAGE_START ' + '页面文字'.repeat(15000) + ' PAGE_END' : `截图 ${i}`, isError: false, ...(i === 1 ? {} : { image: screenshots[i > 1 ? i - 1 : i] }) }));
    const vision = make(provider, 'vision');
    const visionStep = await vision.step(signal());
    assert.equal(imageBytes(seen.at(-1).body).length, 0, 'plain tasks never acquire images implicitly');
    vision.addToolResults(resultsFor(visionStep.toolCalls));
    assert.equal((await vision.step(signal())).text, '已分析当前截图');
    const multimodal = seen.at(-1).body;
    assert.deepEqual(imageBytes(multimodal), screenshots.slice(1).map((image) => image.data), 'latest two complete screenshots survive the text budget');
    paired(multimodal.messages, provider === 'anthropic');
    assert.ok(JSON.stringify(multimodal).includes('CURRENT_GOAL'), 'image evidence cannot replace the real user-goal anchor');
    assert.equal(JSON.stringify(multimodal).includes(screenshots[0].data), false, 'older pending image is discarded');
    if (provider === 'openai') {
      assert.equal(multimodal.messages.at(-1).role, 'user');
      assert.equal(multimodal.messages.filter((message) => Array.isArray(message.content)).length, 1, 'one image evidence message follows every tool result');
      assert.ok(multimodal.messages.filter((message) => message.role === 'tool').every((message) => typeof message.content === 'string'));
    } else {
      const blocks = multimodal.messages.at(-1).content;
      assert.equal(blocks.filter((block) => block.type === 'tool_result' && Array.isArray(block.content)).length, 2);
    }
    await vision.step(signal());
    assert.equal(imageBytes(seen.at(-1).body).length, 0, 'screenshots are released after the first request even within one task');
    vision.addUserMessage('TEXT_ONLY_NEXT_TASK 继续文字分析');
    await vision.step(signal());
    assert.equal(imageBytes(seen.at(-1).body).length, 0, 'subsequent task never resends earlier screenshots');

    const cleared = make(provider, 'vision');
    const pending = await cleared.step(signal());
    cleared.addToolResults(resultsFor(pending.toolCalls));
    cleared.addUserMessage('TEXT_ONLY_NEXT_TASK 放弃此前截图');
    await cleared.step(signal());
    assert.equal(imageBytes(seen.at(-1).body).length, 0, 'new task clears images not yet sent');
    const replay = await make(provider, 'vision').step(signal());
    cleared.addToolResults(resultsFor(replay.toolCalls));
    cleared.restoreHistory([{ role: 'user', text: 'TEXT_ONLY_NEXT_TASK 恢复文字历史' }]);
    await cleared.step(signal());
    assert.equal(imageBytes(seen.at(-1).body).length, 0, 'restoring history clears pending screenshots');

    const rejected = make(provider, 'vision-reject');
    const rejectedStep = await rejected.step(signal());
    rejected.addToolResults(resultsFor(rejectedStep.toolCalls));
    await assert.rejects(rejected.step(signal()), (error) => error.message.includes('图片识别') && !error.message.includes('secret-key'));
    rejected.addUserMessage('TEXT_ONLY_NEXT_TASK 已关闭图片');
    await rejected.step(signal());
    assert.equal(imageBytes(seen.at(-1).body).length, 0, 'failed image request leaves no image state behind');

    const oversized = make(provider, 'vision-huge');
    const oversizedStep = await oversized.step(signal());
    oversized.addToolResults(resultsFor(oversizedStep.toolCalls));
    await oversized.step(signal());
    assert.deepEqual(imageBytes(seen.at(-1).body), screenshots.slice(1).map((image) => image.data), 'images survive a whole exchange being summarized');
    paired(seen.at(-1).body.messages, provider === 'anthropic');

    const invalid = make(provider, 'vision');
    assert.throws(() => invalid.addToolResults([{ id: 'invalid', content: 'invalid', isError: false, image: { ...screenshots[0], data: 'data:image/png;base64,invalid' } }]), /截图格式/);
    assert.throws(() => invalid.addToolResults([{ id: 'huge', content: 'huge', isError: false, image: { ...screenshots[0], data: 'AAAA'.repeat(700001) } }]), /截图格式/);
  }
  await assert.rejects(fetchModelResponse(`${base}/openai/stall`, { method: 'POST', body: '{}' }, signal(), (response, requestSignal) => readOpenAIResponse(response, requestSignal), 25), (error) => error.code === 'timeout');
  const unicode = clipText('😀'.repeat(10000), 700);
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(unicode), 'compaction must not split Unicode pairs');
  const original = [{ role: 'user', content: 'HEAD ' + 'x'.repeat(100000) + ' TAIL' }];
  const compacted = compactHistory(original, '', 8000);
  assert.equal(original[0].content.length, 100010, 'stored history is not mutated');
  assert.ok(JSON.stringify(compacted.messages).length + contextNotice(compacted.summary).length <= 8000);
  assert.ok(compacted.messages[0].content.includes('内容过长'));
  assert.ok(compacted.messages[0].content.endsWith('TAIL'));
  const controls = compactHistory([{ role: 'user', content: 'HEAD' + '\u0001'.repeat(50000) + 'TAIL' }], 'prior '.repeat(600), 8000);
  assert.ok(JSON.stringify(controls.messages).length + contextNotice(controls.summary).length <= 8000, 'escaped characters also obey the serialized budget');
  const hugeCall = compactHistory([{ role: 'user', content: '最新用户目标' }, { role: 'assistant', content: null, tool_calls: [{ id: 'huge', type: 'function', function: { name: 'type_text', arguments: JSON.stringify({ text: 'x'.repeat(100000) }) } }] }, { role: 'tool', tool_call_id: 'huge', content: '已经填写完成' }], '', 8000);
  assert.ok(JSON.stringify(hugeCall.messages).length + contextNotice(hugeCall.summary).length <= 8000);
  paired(hugeCall.messages, false);
  assert.ok(hugeCall.summary.includes('已经填写完成'), 'oversized native tool arguments become a complete historical exchange');
  console.log('✓ 模型回归通过：双接口流式/JSON、取消/超时、thinking、历史预算与工具配对、图片输入/用量限制/失败提示/不重放');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const target = path.resolve(dir);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('tabagent-llm-test-')) await fs.rm(target, { recursive: true, force: true });
}
