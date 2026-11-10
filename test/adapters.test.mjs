import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSize, resolveAdapter, describeAdapters,
  dataUrlToBytes, extensionForMime, sniffMimeType
} from '../adapters.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = 'data:image/png;base64,' + PNG_1PX;

const arkProvider = {
  id: 'ark', kind: 'ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/',
  apiKey: 'test-key', model: 'doubao-seedream-5-0-flash-260915', size: '2K', watermark: false
};

test('normalizeSize 认令牌、认宽高、拒绝乱写', () => {
  assert.equal(normalizeSize('2k'), '2K');
  assert.equal(normalizeSize(' 4K '), '4K');
  assert.equal(normalizeSize('1024x1536'), '1024x1536');
  assert.equal(normalizeSize('1024×1536'), '1024x1536');
  assert.equal(normalizeSize('1024*1536'), '1024x1536');
  assert.equal(normalizeSize('auto'), 'auto');
  assert.equal(normalizeSize(''), '');
  assert.equal(normalizeSize(undefined), '');
  assert.throws(() => normalizeSize('2K 高清'), /无法识别的尺寸/);
  assert.throws(() => normalizeSize('big'), /无法识别的尺寸/);
});

test('resolveAdapter 未知类型报错并列出可用项', () => {
  assert.equal(resolveAdapter('ark').id, 'ark');
  assert.equal(resolveAdapter('OPENAI').id, 'openai');
  assert.throws(() => resolveAdapter('midjourney'), /不支持的接口类型.*ark \/ openai \/ gemini/s);
  assert.deepEqual(describeAdapters().map((item) => item.id), ['ark', 'openai', 'gemini']);
});

test('ark 请求：URL 拼接、鉴权头、默认字段', () => {
  const adapter = resolveAdapter('ark');
  const request = adapter.request(arkProvider, { prompt: '一只苹果', size: '2K', watermark: false });
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'doubao-seedream-5-0-flash-260915');
  assert.equal(body.prompt, '一只苹果');
  assert.equal(body.size, '2K');
  assert.equal(body.watermark, false);
  assert.equal(body.response_format, 'url');
  assert.equal(body.stream, false);
  assert.equal(body.image, undefined);
});

test('ark 请求：参考图走 body.image 数组，seed 透传', () => {
  const adapter = resolveAdapter('ark');
  const request = adapter.request(arkProvider, { prompt: '改成夜景', size: '2K', images: [DATA_URL], seed: 42 });
  const body = JSON.parse(request.body);
  assert.deepEqual(body.image, [DATA_URL]);
  assert.equal(body.seed, 42);
});

test('ark 请求：缺 key 或模型时给出可操作的报错', () => {
  const adapter = resolveAdapter('ark');
  assert.throws(() => adapter.request({ ...arkProvider, apiKey: '' }, { prompt: 'x' }), /没有配置 apiKey/);
  assert.throws(() => adapter.request({ ...arkProvider, model: '' }, { prompt: 'x' }), /没有填写模型 id/);
});

test('ark 解析：url 与 b64_json 两种回法都认', () => {
  const adapter = resolveAdapter('ark');
  const A = adapter.parse({ model: 'm', data: [{ url: 'https://x/a.png' }] });
  assert.equal(A.model, 'm');
  assert.equal(A.images[0].url, 'https://x/a.png');
  const B = adapter.parse({ data: [{ b64_json: PNG_1PX }] });
  assert.equal(B.images[0].base64, PNG_1PX);
  assert.deepEqual(adapter.parse({}), { model: '', images: [] });
});

test('ark 错误信息提取', () => {
  const adapter = resolveAdapter('ark');
  assert.match(adapter.describeError({ error: { code: 'SetLimitExceeded', message: '额度上限' } }), /额度上限（SetLimitExceeded）/);
  assert.equal(adapter.describeError({}), '');
});

test('openai 文生图：令牌尺寸退回 auto，默认要 b64_json', () => {
  const adapter = resolveAdapter('openai');
  const request = adapter.request({ ...arkProvider, kind: 'openai', baseUrl: 'https://api.openai.com/v1', size: '2K' }, { prompt: 'cat', size: '2K' });
  assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
  const body = JSON.parse(request.body);
  assert.equal(body.size, 'auto');
  assert.equal(body.response_format, 'b64_json');
  assert.equal(body.n, 1);
});

test('openai 文生图：显式宽高原样透传', () => {
  const adapter = resolveAdapter('openai');
  const request = adapter.request({ ...arkProvider, kind: 'openai', size: '' }, { prompt: 'cat', size: '1536x1024' });
  assert.equal(JSON.parse(request.body).size, '1536x1024');
});

test('openai 改图：走 multipart，content-type 交给 fetch', () => {
  const adapter = resolveAdapter('openai');
  const request = adapter.request({ ...arkProvider, kind: 'openai', baseUrl: 'https://api.openai.com/v1', size: '1024x1024' }, { prompt: '换背景', size: '1024x1024', images: [DATA_URL] });
  assert.equal(request.url, 'https://api.openai.com/v1/images/edits');
  assert.ok(request.body instanceof FormData);
  assert.equal(request.body.get('model'), 'doubao-seedream-5-0-flash-260915');
  assert.equal(request.body.get('prompt'), '换背景');
  assert.equal(request.headers['content-type'], undefined);
});

test('gemini 请求：模型进 URL、key 进请求头、参考图进 inline_data', () => {
  const adapter = resolveAdapter('gemini');
  const request = adapter.request({ id: 'g', kind: 'gemini', apiKey: 'g-key', model: 'gemini-2.5-flash-image' }, { prompt: '画一只猫', images: [DATA_URL] });
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
  assert.equal(request.headers['x-goog-api-key'], 'g-key');
  assert.equal(request.headers.authorization, undefined);
  const body = JSON.parse(request.body);
  assert.equal(body.contents[0].parts[0].text, '画一只猫');
  assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'image/png');
  assert.equal(body.contents[0].parts[1].inline_data.data, PNG_1PX);
  assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
});

test('gemini 解析：inlineData 与 inline_data 两种写法都认', () => {
  const adapter = resolveAdapter('gemini');
  const snake = adapter.parse({ candidates: [{ content: { parts: [{ text: '好的' }, { inlineData: { mimeType: 'image/png', data: PNG_1PX } }] } }] });
  assert.equal(snake.images.length, 1);
  assert.equal(snake.images[0].mimeType, 'image/png');
  const camel = adapter.parse({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'abc' } }] } }] });
  assert.equal(camel.images[0].base64, 'abc');
  assert.equal(camel.images[0].mimeType, 'image/jpeg');
  assert.deepEqual(adapter.parse({ candidates: [{ content: { parts: [{ text: '没有图' }] } }] }).images, []);
});

test('dataUrlToBytes 解析 base64 与百分号编码', () => {
  const png = dataUrlToBytes(DATA_URL);
  assert.equal(png.mimeType, 'image/png');
  assert.equal(png.bytes.length > 0, true);
  const text = dataUrlToBytes('data:text/plain,hello%20world');
  assert.equal(text.bytes.toString('utf8'), 'hello world');
  assert.throws(() => dataUrlToBytes('not-a-data-url'), /不是 data URL/);
});

test('sniffMimeType 按字节头判断真实格式', () => {
  assert.equal(sniffMimeType(Buffer.from(PNG_1PX, 'base64')), 'image/png');
  assert.equal(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffMimeType(Buffer.from('RIFF0000WEBPVP8 ', 'ascii')), 'image/webp');
  assert.equal(sniffMimeType(Buffer.from('GIF89a______', 'ascii')), 'image/gif');
  assert.equal(sniffMimeType(Buffer.alloc(0)), 'image/png');
});

test('extensionForMime 给落盘用的扩展名', () => {
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/webp'), 'webp');
  assert.equal(extensionForMime('image/gif'), 'gif');
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime(''), 'png');
});
