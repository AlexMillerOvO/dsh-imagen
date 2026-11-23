import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentRelativePath, normalizeComposerWidth } from '../index.js';

const HASH = '9c88d41558c98dc796f5d6c0a5331f7341b7ff4300832ad2c2968a166cd1fd40';

test('附件 id 按内容寻址拆成 <前2位>/<完整hex>', () => {
  assert.equal(attachmentRelativePath('sha256:' + HASH), '9c/' + HASH);
  // 大小写混写也认
  assert.equal(attachmentRelativePath('SHA256:' + HASH.toUpperCase()), '9c/' + HASH);
  // 前后空格容忍
  assert.equal(attachmentRelativePath('  sha256:' + HASH + '  '), '9c/' + HASH);
});

test('附件 id 形状不对时返回空串，交给上层报错', () => {
  assert.equal(attachmentRelativePath('sha256:'), '');
  assert.equal(attachmentRelativePath('sha256:abc'), '');
  assert.equal(attachmentRelativePath('sha256:' + 'z'.repeat(64)), '');
  assert.equal(attachmentRelativePath('sha256:' + 'a'.repeat(63)), '');
  assert.equal(attachmentRelativePath('sha256:' + 'a'.repeat(65)), '');
  assert.equal(attachmentRelativePath(''), '');
  assert.equal(attachmentRelativePath(undefined), '');
  assert.equal(attachmentRelativePath('image.png'), '');
});

test('折叠阈值接受合法数字并四舍五入', () => {
  assert.equal(normalizeComposerWidth(550), 550);
  assert.equal(normalizeComposerWidth('450'), 450);
  assert.equal(normalizeComposerWidth(449.6), 450);
  assert.equal(normalizeComposerWidth(200), 200);
  assert.equal(normalizeComposerWidth(2000), 2000);
});

test('折叠阈值夹到 200–2000，非法值回落到 550', () => {
  assert.equal(normalizeComposerWidth(2010), 2000);
  assert.equal(normalizeComposerWidth(10), 200);
  assert.equal(normalizeComposerWidth(0), 550);
  assert.equal(normalizeComposerWidth(-5), 550);
  assert.equal(normalizeComposerWidth(''), 550);
  assert.equal(normalizeComposerWidth(undefined), 550);
  assert.equal(normalizeComposerWidth(null), 550);
  assert.equal(normalizeComposerWidth('abc'), 550);
  assert.equal(normalizeComposerWidth(Infinity), 550);
});
