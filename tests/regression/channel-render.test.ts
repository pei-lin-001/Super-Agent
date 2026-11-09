/**
 * 渲染：模型给的是 Markdown，平台能显示的是受控 HTML 或纯文本。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { toPlainText, toTelegramHtml } from '../../src/channels/render.ts';

test('渲染：加粗、行内代码、标题、链接转成受控标签', () => {
  const html = toTelegramHtml('## 标题\n这是 **重点** 和 `code`\n[文档](https://example.com/a)');
  assert.match(html, /<b>标题<\/b>/);
  assert.match(html, /<b>重点<\/b>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a">文档<\/a>/);
  assert.doesNotMatch(html, /\*\*/, '不能把星号原样丢给用户');
});

test('渲染：围栏代码块保持原样，内部标记不被二次转换', () => {
  const html = toTelegramHtml('```python\nprint("**不是加粗**")\n```');
  assert.match(html, /<pre>print\("\*\*不是加粗\*\*"\)<\/pre>/);
  assert.doesNotMatch(html, /<b>/, '代码块里的星号不能被当成加粗');
});

test('渲染：内容里的尖括号与 & 必须转义，不能注入标签', () => {
  const html = toTelegramHtml('<script>alert(1)</script> & **粗**');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/, '不能把用户内容当标签');
  assert.match(html, /&amp;/);
  assert.match(html, /<b>粗<\/b>/);
});

test('渲染：单个星号不当作斜体，避免误伤自然语言', () => {
  const html = toTelegramHtml('2*3*4 = 24');
  assert.equal(html, '2*3*4 = 24');
});

test('渲染：纯文本去掉标记但保留内容', () => {
  const plain = toPlainText('## 结论\n**重要** 和 `code` 和 [链接](https://a.b)\n```\n区块\n```');
  assert.doesNotMatch(plain, /\*\*/);
  assert.doesNotMatch(plain, /`/);
  assert.match(plain, /重要/);
  assert.match(plain, /链接（https:\/\/a\.b）/);
  assert.match(plain, /区块/);
});

test('渲染：空输入与未闭合标记不抛错', () => {
  assert.equal(toTelegramHtml(''), '');
  assert.equal(toPlainText(''), '');
  assert.doesNotThrow(() => toTelegramHtml('**没闭合'));
  assert.doesNotThrow(() => toTelegramHtml('```\n没闭合的代码块'));
});
