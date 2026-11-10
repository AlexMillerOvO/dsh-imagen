/**
 * 本地模拟的方舟生图接口，只用来验证插件的完整链路（请求 → 解析 → 落盘 → 预览路由）。
 * 不联网、不花钱，返回的是一张真实的 PNG。
 *
 * 用法：
 *   node scripts/mock-ark.mjs [port] [pngPath]
 * 然后配置里加一个 provider：
 *   { "id": "mock", "kind": "ark", "baseUrl": "http://127.0.0.1:18080/api/v3",
 *     "apiKey": "mock", "model": "mock-image", "size": "2K" }
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] || 18080);
const imagePath = process.argv[3] || path.join(process.cwd(), '..', '..', 'pelican-bicycle-preview.png');

const png = readFileSync(imagePath);

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/v3/images/generations')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_error) { parsed = {}; }
      console.log('[mock] generate model=' + parsed.model + ' size=' + parsed.size + ' watermark=' + parsed.watermark);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: parsed.model || 'mock-image',
        created: Math.floor(Date.now() / 1000),
        data: [{ url: 'http://127.0.0.1:' + port + '/api/v3/images/mock.png' }]
      }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/v3/images/mock.png') {
    console.log('[mock] served image ' + png.length + ' bytes');
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NotFound', message: 'mock: ' + req.method + ' ' + req.url } }));
});

server.listen(port, '127.0.0.1', () => {
  console.log('[mock] listening on http://127.0.0.1:' + port + ' (image: ' + imagePath + ', ' + png.length + ' bytes)');
});
