// Download boundaries and chunk continuity, using the production helpers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const code = ts.transpileModule((await fs.readFile('lib/pdf.ts', 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
let parsed = 0;
let fetcher;
const context = vm.createContext({ URL, Uint8Array, TextDecoder, fetch: (...args) => fetcher(...args),
  parsePdfBytes: async () => { parsed++; return { text: '[第 1 页]\nhello', pages: 1, emptyPages: [] }; } });
vm.runInContext(code + '\nglobalThis.subject = { readOnlinePdf, pdfTextSegment };', context);
const { readOnlinePdf, pdfTextSegment } = context.subject;
const signal = new AbortController().signal;
const text = '[第 1 页]\n你好😀 第一页\n\n[第 2 页]\n第二页结束';
let offset = 0, joined = '';
do {
  const chunk = pdfTextSegment({ text, pages: 2, emptyPages: [] }, offset, 1);
  joined += chunk.text;
  assert.ok(chunk.nextOffset === null || chunk.nextOffset > offset);
  offset = chunk.nextOffset;
} while (offset !== null);
assert.equal(joined, text, '分段应保留每个字符和完整Unicode字符');
assert.throws(() => pdfTextSegment({ text }, text.length + 1), /偏移/);
await assert.rejects(readOnlinePdf('file:///secret.pdf', signal), /在线 PDF/);
fetcher = async (_url, options) => {
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'include');
  return new Response('%PDF-1.4 fixture');
};
await readOnlinePdf('https://example.test/document#page=2', signal);
assert.equal(parsed, 1);
fetcher = async () => new Response('<html>login</html>');
await assert.rejects(readOnlinePdf('https://example.test/document', signal), /不是有效 PDF/);
fetcher = async () => new Response('', { status: 403 });
await assert.rejects(readOnlinePdf('https://example.test/document', signal), /403/);
fetcher = async () => new Response('%PDF', { headers: { 'content-length': String(21 * 1024 * 1024) } });
await assert.rejects(readOnlinePdf('https://example.test/document', signal), /20 MB/);
fetcher = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(21 * 1024 * 1024)); controller.close(); } }));
await assert.rejects(readOnlinePdf('https://example.test/document', signal), /20 MB/);
assert.equal(parsed, 1, '无效或超限下载不能送入解析器');
console.log('✓ PDF下载边界：文件类型、权限、重定向策略、声明/实际大小限制、分段Unicode连续性');
