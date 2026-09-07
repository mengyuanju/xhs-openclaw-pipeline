import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelResponse } from '../app/workbench/model-response-presentation.mjs';

test('JSON fields stay schema-free and decode Chinese, emoji and newlines once', () => {
  const source = String.raw`{"任意字段":"\u4e2d\u6587\n第二行😀","path":"C:\\new\\test","items":[false,0,null,{},[]]}`;
  const result = parseModelResponse(source);
  assert.equal(result.format, 'json');
  assert.deepEqual(result.value, { 任意字段: '中文\n第二行😀', path: String.raw`C:\new\test`, items: [false, 0, null, {}, []] });
});

test('complete JSON fences and JSON strings inside response envelopes can be read', () => {
  const source = '```json\r\n{"stdout":"{\\"正文\\":\\"第一行\\\\n第二行\\"}"}\r\n```';
  const outer = parseModelResponse(source);
  assert.equal(outer.format, 'json');
  const inner = parseModelResponse(outer.value.stdout);
  assert.deepEqual(inner.value, { 正文: '第一行\n第二行' });
  assert.equal(parseModelResponse('"第一行\\n第二行"').value, '第一行\n第二行');
});

test('truncated or invalid JSON falls back without guessing escapes or dropping content', () => {
  for (const source of ['  {"正文":"你好\\n', '```json\n{"body":"incomplete', '{"body": bad}', '[{"a":1},', '{"a":1}\n附加说明']) {
    assert.deepEqual(parseModelResponse(source), { format: 'text', value: source });
  }
});

test('ordinary text, paths and literal escapes keep their original characters', () => {
  for (const source of ['', '  中文😀\r\n第二行  ', String.raw`C:\new\test\u4e2d`, String.raw`请保留 \n 和 \u4e2d`, '<script>alert(1)</script>']) {
    assert.deepEqual(parseModelResponse(source), { format: 'text', value: source });
  }
});

test('Markdown and mixed prose keep the full source for tolerant rendering', () => {
  for (const source of ['# 标题\n\n- **重点**\n- 第二项', '| 项目 | 内容 |\n| --- | --- |\n| 一 | 二 |', '说明：\n```json\n{"正文":"你好"}\n```\n结尾']) {
    assert.deepEqual(parseModelResponse(source), { format: 'markdown', value: source });
  }
});

test('very long responses remain readable as complete text without expensive parsing', () => {
  const source = JSON.stringify({ 正文: '中文😀'.repeat(20_000) });
  assert.deepEqual(parseModelResponse(source), { format: 'text', value: source });
});
