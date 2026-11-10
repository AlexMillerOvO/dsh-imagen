/**
 * dsh-imagen —— 给 DeepSeek Harness 用的文生图插件。
 *
 * 一句话链路：
 *   模型调用 dsh-imagen 工具 → 按配置挑一家上游接口 → 拿回图片字节
 *   → 落盘到当前工作区 generated-images/ → 用一个带签名的本地 URL
 *   → 在对话里以 Markdown 图片显示。
 *
 * 为什么图片要落盘再起本地路由，而不是直接把上游 URL 丢给前端：
 * 方舟这类接口返回的是带时效的签名外链，几小时后就会失效；存一份本地的，
 * 对话记录翻回去还能看到图。
 *
 * 配置在 ~/.dsh/imagen/config.json，密钥只在那个文件里（0600），不进代码、不进仓库。
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveAdapter, describeAdapters, extensionForMime, sniffMimeType, normalizeSize } from './adapters.js';

const PLUGIN = 'dsh-imagen';
/** 工具名。DSH 只禁 run_code；带连字符在主流 function-calling 上都合法，注册失败会自动退回下划线版。 */
const TOOL_NAME = 'dsh-imagen';
const TOOL_NAME_FALLBACK = 'dsh_imagen';
const PREVIEW_PREFIX = '/api/imagen/preview/';
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_COUNT = 8;
const TOOL_TIMEOUT_MS = 5 * 60 * 1000;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function stateDir() {
  return path.join(dshHome(), 'imagen');
}
function configFile() {
  return path.join(stateDir(), 'config.json');
}
function previewKeyFile() {
  return path.join(stateDir(), 'preview.key');
}
function logHost(message) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(path.join(stateDir(), 'host.log'), new Date().toISOString() + ' ' + message + '\n');
  } catch (_error) {
    // 日志失败不能影响主流程。
  }
}

/* ------------------------------------------------------------------ 配置 */

const CONFIG_TEMPLATE = {
  version: 2,
  active: 'ark',
  activeModel: 'doubao-seedream-5-0-flash-260915',
  size: '2K',
  outputDir: 'generated-images',
  providers: [
    {
      id: 'ark',
      kind: 'ark',
      name: '火山方舟 Seedream',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: '',
      models: ['doubao-seedream-5-0-flash-260915'],
      watermark: false
    }
  ]
};

/**
 * 把配置文件里的一条提供商读成规范形状。
 *
 * v1 只有单个 `model` 字符串，v2 改成 `models` 数组；这里两种都认，
 * 所以老的 config.json 不需要手动迁移就能继续用。
 */
function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const models = Array.isArray(raw.models)
    ? raw.models.map((item) => String(item || '').trim()).filter(Boolean)
    : (String(raw.model || '').trim() ? [String(raw.model).trim()] : []);
  return {
    id: String(raw.id || '').trim(),
    kind: String(raw.kind || '').trim().toLowerCase(),
    name: String(raw.name || raw.id || '').trim(),
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(raw.apiKey || ''),
    models: Array.from(new Set(models)),
    size: String(raw.size || '').trim(),
    watermark: raw.watermark === true
  };
}

function ensureConfigFile() {
  const file = configFile();
  if (existsSync(file)) return false;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n', { mode: 0o600 });
  logHost('created starter config at ' + file);
  return true;
}

function loadConfig() {
  ensureConfigFile();
  let raw;
  try {
    raw = JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch (error) {
    throw new Error('读取配置失败：' + configFile() + ' —— ' + String(error && error.message ? error.message : error));
  }
  if (!raw || typeof raw !== 'object') throw new Error('配置文件内容不是对象：' + configFile());
  const providers = (Array.isArray(raw.providers) ? raw.providers : []).map(normalizeProvider).filter((item) => item && item.id);
  if (providers.length === 0) throw new Error('配置里没有任何提供商，请在 ' + configFile() + ' 的 providers 里添加一项。');
  const activeId = String(raw.active || '').trim();
  const active = providers.find((item) => item.id === activeId) || providers[0];
  const wantedModel = String(raw.activeModel || '').trim();
  const activeModel = wantedModel && active.models.includes(wantedModel) ? wantedModel : (active.models[0] || '');
  return {
    active,
    activeModel,
    size: String(raw.size || '').trim(),
    providers,
    outputDir: typeof raw.outputDir === 'string' && raw.outputDir.trim() ? raw.outputDir.trim() : 'generated-images'
  };
}

/* ------------------------------------------------------- 预览 URL 与签名 */

let previewKeyCache = null;

function previewKey() {
  if (previewKeyCache) return previewKeyCache;
  const file = previewKeyFile();
  mkdirSync(stateDir(), { recursive: true });
  let key = null;
  try {
    key = readFileSync(file);
  } catch (_error) {
    key = null;
  }
  if (!key || key.length !== 32) {
    key = randomBytes(32);
    try {
      writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      key = readFileSync(file);
    }
  }
  if (!key || key.length !== 32) throw new Error('预览签名密钥无效：' + file);
  previewKeyCache = key;
  return key;
}

/**
 * 令牌里带完整路径，但整段用 HMAC 签过，所以前端没法改路径去读别的文件。
 * 之所以走签名而不是白名单目录：图片存在会话自己的工作区里，路径因会话而异。
 */
function signPreview(file) {
  const payload = Buffer.from(JSON.stringify({ p: file }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', previewKey()).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function resolvePreviewToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return '';
  try {
    const expected = createHmac('sha256', previewKey()).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return '';
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return value && typeof value.p === 'string' && path.isAbsolute(value.p) ? value.p : '';
  } catch (_error) {
    return '';
  }
}

/** apply 时算一次对外地址：DSH_WEB_URL 优先（远程/反代场景），否则问 webServer。 */
let originBase = '';
function resolveOrigin(ctx) {
  const advertised = String(process.env.DSH_WEB_URL || '').trim();
  if (/^https?:\/\//i.test(advertised)) return advertised.replace(/\/+$/, '');
  try {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
    if (webServer && typeof webServer.getOrigin === 'function') {
      const origin = String(webServer.getOrigin() || '').trim();
      if (/^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, '');
    }
  } catch (_error) {
    // 拿不到就用相对地址，前端同源也能显示。
  }
  return '';
}

function previewUrl(file) {
  const path = PREVIEW_PREFIX + encodeURIComponent(signPreview(file));
  return originBase ? originBase + path : path;
}

/* --------------------------------------------------------------- 参数校验 */

function asString(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('参数 ' + name + ' 必须是字符串，收到 ' + typeof value + '。');
  return value.trim();
}

/** 参数名写错或类型写错时直接拒绝：静默忽略会让模型以为自己传对了。 */
function parseArgs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数必须是对象。');
  const allowed = new Set(['prompt', 'size', 'model', 'provider', 'image', 'watermark', 'seed']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error('不认识的参数：' + key + '。可用：' + Array.from(allowed).join('、') + '。');
  }
  const prompt = asString(raw.prompt, 'prompt');
  if (!prompt) throw new Error('参数 prompt 必填，且不能是空字符串。');

  const args = {
    prompt,
    size: asString(raw.size, 'size'),
    model: asString(raw.model, 'model'),
    provider: asString(raw.provider, 'provider')
  };

  if (raw.image !== undefined && raw.image !== null) {
    if (!Array.isArray(raw.image)) throw new Error('参数 image 必须是字符串数组；一张图也要写成 ["/abs/a.png"]，纯文生图请整个省略。');
    if (raw.image.length === 0) throw new Error('参数 image 是空数组。纯文生图请把 image 字段整个省略；要改图就给至少一张。');
    if (raw.image.length > MAX_INPUT_COUNT) throw new Error('参数 image 最多 ' + MAX_INPUT_COUNT + ' 张，收到 ' + raw.image.length + ' 张。');
    args.image = raw.image.map((item, index) => {
      if (typeof item !== 'string' || !item.trim()) throw new Error('参数 image[' + index + '] 必须是非空字符串。');
      return item.trim();
    });
  }

  if (raw.watermark !== undefined && raw.watermark !== null) {
    if (typeof raw.watermark !== 'boolean') throw new Error('参数 watermark 必须是布尔值。');
    args.watermark = raw.watermark;
  }

  if (raw.seed !== undefined && raw.seed !== null) {
    if (typeof raw.seed !== 'number' || !Number.isFinite(raw.seed)) throw new Error('参数 seed 必须是数字。');
    args.seed = raw.seed;
  }

  return args;
}

/* ----------------------------------------------------------- 输入参考图 */

function mimeFromPath(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

/**
 * 把参考图统一成 data URL。
 * 上游只认「URL 或 base64」，本地路径必须先读成字节；http(s) 也先下载下来，
 * 免得把内网地址或需要鉴权的链接交给上游。
 */
async function toDataUrl(item, signal) {
  if (/^data:/i.test(item)) {
    const bytes = Buffer.byteLength(item, 'utf8');
    if (bytes > MAX_INPUT_BYTES * 1.4) throw new Error('参考图 data URL 太大（约 ' + Math.round(bytes / 1024 / 1024) + 'MB），单张上限约 10MB。');
    return item;
  }
  if (/^https?:\/\//i.test(item)) {
    const response = await fetch(item, { signal });
    if (!response.ok) throw new Error('下载参考图失败：' + item + '（HTTP ' + response.status + '）');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_INPUT_BYTES) throw new Error('参考图超过 10MB 上限：' + item);
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0] || sniffMimeType(buffer);
    return 'data:' + mimeType + ';base64,' + buffer.toString('base64');
  }
  const file = path.resolve(item);
  if (!existsSync(file)) throw new Error('参考图不存在：' + file);
  const info = statSync(file);
  if (!info.isFile()) throw new Error('参考图不是文件：' + file);
  if (info.size > MAX_INPUT_BYTES) throw new Error('参考图超过 10MB 上限（' + Math.round(info.size / 1024 / 1024) + 'MB）：' + file);
  const bytes = await readFile(file);
  return 'data:' + mimeFromPath(file) + ';base64,' + bytes.toString('base64');
}

/* ---------------------------------------------------------------- 出图 */

function sessionCwd(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd;
    return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : '';
  } catch (_error) {
    return '';
  }
}

function outputDirFor(exec, config) {
  const base = sessionCwd(exec) || stateDir();
  return path.isAbsolute(config.outputDir) ? config.outputDir : path.join(base, config.outputDir);
}

function uniqueFile(dir, mimeType) {
  const ext = extensionForMime(mimeType);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return path.join(dir, 'imagen-' + stamp + '-' + randomBytes(3).toString('hex') + '.' + ext);
}

async function fetchImageBytes(image, signal) {
  if (image.base64) {
    const bytes = Buffer.from(image.base64, 'base64');
    return { bytes, mimeType: image.mimeType || sniffMimeType(bytes) };
  }
  if (!image.url) throw new Error('上游没有返回图片地址，也没有返回 base64。');
  const response = await fetch(image.url, { signal });
  if (!response.ok) throw new Error('下载上游图片失败（HTTP ' + response.status + '）：' + image.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('上游图片超过 30MB 上限，已放弃保存。');
  const headerType = String(response.headers.get('content-type') || '').split(';')[0];
  return { bytes, mimeType: headerType && headerType.startsWith('image/') ? headerType : sniffMimeType(bytes) };
}

async function generate(args, exec) {
  const config = loadConfig();
  const providerId = args.provider || (config.active && config.active.id) || '';
  const provider = config.providers.find((item) => item && item.id === providerId);
  if (!provider) throw new Error('找不到提供商 ' + providerId + '，可用：' + config.providers.map((item) => item && item.id).filter(Boolean).join('、'));

  const adapter = resolveAdapter(provider.kind);
  const signal = exec && exec.signal ? AbortSignal.any([exec.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]) : AbortSignal.timeout(TOOL_TIMEOUT_MS);

  const images = [];
  for (const item of args.image || []) images.push(await toDataUrl(item, signal));

  // 模型回退必须跟着「这次实际用哪家」走：args.provider 指定了别家时，
  // 不能把当前提供商的 activeModel 套上去，那是另一个上游的模型 id。
  const isActiveProvider = provider.id === (config.active && config.active.id);
  const fallbackModel = (isActiveProvider && config.activeModel) || (provider.models && provider.models[0]) || '';

  const spec = {
    prompt: args.prompt,
    size: args.size || config.size || provider.size || '',
    model: args.model || fallbackModel,
    watermark: typeof args.watermark === 'boolean' ? args.watermark : provider.watermark,
    images,
    seed: args.seed
  };
  // 临时覆盖模型时只改这一次请求，不动配置文件。
  const requestProvider = Object.assign({}, provider, { model: spec.model });

  const request = adapter.request(requestProvider, spec);
  let response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('请求超时（' + Math.round(TOOL_TIMEOUT_MS / 1000) + ' 秒）。生图有时会超过这个时间，稍后重试或换小一点的尺寸。');
    }
    throw new Error('请求 ' + adapter.label + ' 失败：' + String(error && error.message ? error.message : error));
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_error) {
    body = null;
  }

  if (!response.ok) {
    const detail = (body && adapter.describeError(body)) || text.slice(0, 400) || '(空响应)';
    throw new Error(adapter.label + ' 返回 HTTP ' + response.status + '：' + detail);
  }
  if (!body) throw new Error(adapter.label + ' 返回的内容不是 JSON：' + text.slice(0, 300));

  const parsed = adapter.parse(body);
  const first = parsed.images.find((image) => image && (image.base64 || image.url));
  if (!first) throw new Error(adapter.label + ' 的回应里没有图片。原始回应：' + text.slice(0, 400));

  const { bytes, mimeType } = await fetchImageBytes(first, signal);
  if (!bytes || bytes.length === 0) throw new Error('上游返回的图片是空的。');

  const dir = outputDirFor(exec, config);
  mkdirSync(dir, { recursive: true });
  const file = uniqueFile(dir, mimeType);
  writeFileSync(file, bytes, { mode: 0o600 });
  logHost('generated ' + file + ' (' + bytes.length + ' bytes, ' + adapter.id + ')');

  const mode = images.length > 0 ? 'edit' : 'generate';
  const url = previewUrl(file);
  const markdown = '![' + (mode === 'edit' ? '改图' : '文生图') + '](' + url + ')';
  return {
    path: file,
    url,
    markdown,
    mode,
    provider: provider.id,
    model: parsed.model || spec.model,
    size: spec.size || '',
    bytes: bytes.length
  };
}

/* ------------------------------------------------------------- 插件装配 */

/* ------------------------------------------------------- 配置读写接口 */

const CONFIG_ROUTE = '/api/imagen/config';
const SELECTION_ROUTE = '/api/imagen/selection';
const MAX_BODY = 1024 * 1024;

function readRawConfigSafe() {
  try {
    const raw = JSON.parse(readFileSync(configFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_error) {
    return {};
  }
}

/** 只露尾巴 4 位，前端拿不到完整密钥。 */
function keyHint(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return '';
  if (key.length <= 4) return '••••';
  return '••••' + key.slice(-4);
}

function publicConfig() {
  const config = loadConfig();
  return {
    version: 2,
    active: config.active ? config.active.id : '',
    activeModel: config.activeModel,
    size: config.size,
    outputDir: config.outputDir,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.models,
      watermark: provider.watermark === true,
      hasKey: !!String(provider.apiKey || '').trim(),
      keyHint: keyHint(provider.apiKey)
    }))
  };
}

/**
 * 保存整份配置。
 *
 * apiKey 的三态是故意分开的：
 *   字段不出现 → 保留原来的 key（前端只拿到掩码，没法回传真值）
 *   空字符串   → 主动清空
 *   非空字符串 → 覆盖
 */
function saveConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('请求体里没有 config 对象。');
  const previous = readRawConfigSafe();
  const previousProviders = Array.isArray(previous.providers) ? previous.providers : [];
  const incoming = Array.isArray(input.providers) ? input.providers : [];
  const out = [];
  for (const item of incoming) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!id) throw new Error('提供商 id 不能为空。');
    if (out.some((existing) => existing.id === id)) throw new Error('提供商 id 重复：' + id);
    const kind = String(item.kind || '').trim().toLowerCase();
    const adapter = resolveAdapter(kind);
    const models = Array.isArray(item.models)
      ? item.models.map((value) => String(value || '').trim()).filter(Boolean)
      : (String(item.model || '').trim() ? [String(item.model).trim()] : []);
    const uniqueModels = Array.from(new Set(models));
    if (uniqueModels.length === 0) throw new Error('提供商 ' + id + ' 至少要填一个模型 id。');
    let apiKey = '';
    if (item.apiKey === undefined) {
      const before = previousProviders.find((existing) => existing && existing.id === id);
      apiKey = before ? String(before.apiKey || '') : '';
    } else {
      apiKey = String(item.apiKey || '').trim();
    }
    out.push({
      id,
      kind,
      name: String(item.name || id).trim() || id,
      baseUrl: String(item.baseUrl || '').trim().replace(/\/+$/, '') || adapter.defaultBaseUrl,
      apiKey,
      models: uniqueModels,
      watermark: item.watermark === true
    });
  }
  if (out.length === 0) throw new Error('至少要保留一个提供商。');

  const wantedActive = String(input.active || '').trim();
  const active = out.find((provider) => provider.id === wantedActive) || out[0];
  const wantedModel = String(input.activeModel || '').trim();
  const activeModel = wantedModel && active.models.includes(wantedModel) ? wantedModel : active.models[0];

  const wantedSize = String(input.size || '').trim();
  let size = '2K';
  if (wantedSize) {
    const normalized = normalizeSize(wantedSize);
    size = normalized === 'auto' ? '' : normalized;
  }

  const outputDir = String(input.outputDir || '').trim() || 'generated-images';
  const next = {
    version: 2,
    active: active.id,
    activeModel,
    size,
    outputDir,
    providers: out
  };
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  logHost('config saved; active=' + active.id + '/' + activeModel + '; size=' + (size || 'auto') + '; providers=' + out.map((provider) => provider.id).join(','));
  return next;
}

/**
 * 只改「当前用哪个模型、出多大图」。
 *
 * 输入栏的选择器每次切换都会走这里，所以它必须：
 *   - 不碰 apiKey（整份配置回写时原样带上，前端拿不到也改不了）
 *   - 不认识的值直接拒绝，而不是悄悄回退到默认
 */
function saveSelection(input) {
  if (!input || typeof input !== 'object') throw new Error('请求体里没有选择内容。');
  const raw = readRawConfigSafe();
  const config = loadConfig();

  const providerId = String(input.active || '').trim();
  if (providerId && !config.providers.some((provider) => provider.id === providerId)) {
    throw new Error('没有这个提供商：' + providerId);
  }

  const providers = config.providers.map((provider) => Object.assign({}, provider));
  let activeId = providerId || config.active.id;
  let activeModel = config.activeModel;

  const wantedModel = String(input.activeModel || '').trim();
  if (wantedModel) {
    const owner = providers.find((provider) => provider.models.includes(wantedModel));
    if (!owner) throw new Error('没有配置过这个模型：' + wantedModel);
    // 选的是别家的模型时，提供商跟着一起切 —— 否则请求会发到错的上游。
    activeId = providerId && providers.some((provider) => provider.id === providerId && provider.models.includes(wantedModel))
      ? providerId
      : owner.id;
    activeModel = wantedModel;
  }

  const target = providers.find((provider) => provider.id === activeId) || providers[0];
  if (target && !target.models.includes(activeModel)) activeModel = target.models[0] || '';

  let size = config.size;
  if (input.size !== undefined) {
    const wanted = String(input.size || '').trim();
    if (!wanted) {
      size = '';
    } else {
      const normalized = normalizeSize(wanted);
      size = normalized === 'auto' ? '' : normalized;
    }
  }

  const next = {
    version: 2,
    active: target ? target.id : config.active.id,
    activeModel,
    size,
    outputDir: typeof raw.outputDir === 'string' && raw.outputDir.trim() ? raw.outputDir.trim() : config.outputDir,
    providers: providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      models: provider.models,
      watermark: provider.watermark
    }))
  };
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  logHost('selection saved; ' + next.active + '/' + next.activeModel + '; size=' + (size || 'auto'));
  return next;
}

/** 只接受本机请求：远程页面不能改你的 key。 */
function isLocalRequest(req) {
  const address = req && req.socket ? String(req.socket.remoteAddress || '') : '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === '';
  if (!loopback) return false;
  const origin = String((req.headers && req.headers.origin) || '').trim();
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    const expected = String((req.headers && req.headers.host) || '').trim();
    return host === expected;
  } catch (_error) {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 1MB 上限。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error('请求体不是合法 JSON。'));
      }
    });
    req.on('error', reject);
  });
}

function registerConfigRoute(ctx) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    logHost('no webServer; config route not registered (settings page will not work)');
    return;
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      try {
        if (!isLocalRequest(req)) return send(403, { ok: false, error: '只接受本机请求。' });
        if (req.method === 'GET') {
          return send(200, { ok: true, config: publicConfig(), adapters: describeAdapters(), configFile: configFile() });
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          saveConfig(body && body.config ? body.config : body);
          return send(200, { ok: true, config: publicConfig(), adapters: describeAdapters(), configFile: configFile() });
        }
        return send(405, { ok: false, error: 'method not allowed' });
      } catch (error) {
        logHost('config route error: ' + String(error && error.message ? error.message : error));
        return send(400, { ok: false, error: String(error && error.message ? error.message : error) });
      }
    }
  }), 'dsh-imagen: config route');

  // 输入栏的模型/尺寸选择器只改这三个字段，走单独的窄接口，
  // 免得为了切一次模型把整份配置（含 key）传一遍。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SELECTION_ROUTE,
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      try {
        if (!isLocalRequest(req)) return send(403, { ok: false, error: '只接受本机请求。' });
        if (req.method === 'GET') {
          return send(200, { ok: true, config: publicConfig() });
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          saveSelection(body && body.selection ? body.selection : body);
          return send(200, { ok: true, config: publicConfig() });
        }
        return send(405, { ok: false, error: 'method not allowed' });
      } catch (error) {
        logHost('selection route error: ' + String(error && error.message ? error.message : error));
        return send(400, { ok: false, error: String(error && error.message ? error.message : error) });
      }
    }
  }), 'dsh-imagen: selection route');
}

/* ------------------------------------------------------- 调用路由提示 */

/**
 * 工具描述只能说明「这个工具能干什么」，说明不了「什么时候不该用」。
 * 所以这里往系统提示词里放一小段路由规则，每个会话组装提示词时都会带上：
 *   - 用户要画 / 要改图 → 必须调用
 *   - 只是聊图、看图、问图、做别的事 → 不许调用
 *
 * 文字故意写短：系统提示词是每次请求都要付的上下文成本。
 */
const ROUTING_SECTION = [
  'Image generation (`' + PLUGIN + '`).',
  'Call it when the user asks you to create, draw, render, generate, or edit an image — e.g. "画一张…", "generate an image", "make a poster", "把这张图改成…".',
  'Do not call it when: the user only talks about images, asks how one was made, or asks you to describe or read an existing image; when the deliverable is text, code, a document, a diagram, or a chart rather than a raster image; or when the user did not ask for a new or edited picture.',
  'One image per call, one call per request. It returns a ready-to-send Markdown image line: reply with that line and nothing else, and never judge, caption, or re-read the image.',
  'On failure, report the error verbatim and stop — do not retry in a loop and do not switch to another image tool on your own.',
  'If several image tools are available, prefer this one unless the user explicitly names another.'
].join(' ');

function installPromptSection(ctx) {
  const register = (target) => {
    if (!target.systemPrompt || typeof target.systemPrompt.section !== 'function') {
      logHost('systemPrompt service unavailable; routing hint not injected');
      return;
    }
    target.effect(() => target.systemPrompt.section({
      name: PLUGIN + ':routing',
      order: 2940,
      text: () => ROUTING_SECTION
    }), PLUGIN + ': routing section');
    logHost('routing hint registered (' + PLUGIN + ':routing)');
  };
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['systemPrompt'], register);
    else register(ctx);
  } catch (error) {
    logHost('routing hint install error: ' + String(error && error.message ? error.message : error));
  }
}

/** 注册工具；连字符被宿主拒绝时自动退回下划线名，并把实际名字记进日志。 */
function registerTool(ctx, definition) {
  const tryRegister = (name) => {
    const candidate = Object.assign({}, definition, { name });
    return ctx.effect(() => ctx.tools.register(candidate), 'dsh-imagen: tool ' + name);
  };
  try {
    tryRegister(TOOL_NAME);
    logHost('tool registered as ' + TOOL_NAME);
    return TOOL_NAME;
  } catch (error) {
    logHost('register ' + TOOL_NAME + ' failed: ' + String(error && error.message ? error.message : error) + '; retrying as ' + TOOL_NAME_FALLBACK);
    tryRegister(TOOL_NAME_FALLBACK);
    return TOOL_NAME_FALLBACK;
  }
}

function registerPreviewRoute(ctx) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    logHost('no webServer; preview route not registered (images will not render inline)');
    return;
  }
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: PREVIEW_PREFIX.slice(0, -1),
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
          return;
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        const token = decodeURIComponent(url.pathname.slice(PREVIEW_PREFIX.length));
        const file = resolvePreviewToken(token);
        if (!file || !existsSync(file)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not found' }));
          return;
        }
        const info = statSync(file);
        if (!info.isFile()) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not found' }));
          return;
        }
        const bytes = await readFile(file);
        res.writeHead(200, {
          'content-type': sniffMimeType(bytes),
          'content-length': info.size,
          'cache-control': 'private, max-age=3600'
        });
        res.end(bytes);
      } catch (error) {
        logHost('preview route error: ' + String(error && error.message ? error.message : error));
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      }
    }
  }), 'dsh-imagen: preview route');
}

export const name = PLUGIN;
export const inject = ['tools'];

export function apply(ctx) {
  originBase = resolveOrigin(ctx);
  const created = ensureConfigFile();
  logHost('apply; origin=' + (originBase || '(relative)') + '; adapters=' + describeAdapters().map((adapter) => adapter.id).join(',') + (created ? '; config created' : ''));

  registerPreviewRoute(ctx);
  registerConfigRoute(ctx);
  installPromptSection(ctx);

  const output = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'markdown', 'mode', 'provider', 'model'],
      properties: {
        path: { type: 'string', description: '落盘的图片绝对路径。' },
        url: { type: 'string', description: '本地预览地址。' },
        markdown: { type: 'string', description: '可直接放进回复的 Markdown 图片行。' },
        mode: { type: 'string', description: 'generate 或 edit。' },
        provider: { type: 'string', description: '实际使用的提供商 id。' },
        model: { type: 'string', description: '实际使用的模型 id。' },
        size: { type: 'string', description: '请求的尺寸。' },
        bytes: { type: 'number', description: '图片字节数。' }
      }
    },
    render(_args, value) {
      const record = value && typeof value === 'object' ? value : {};
      const markdown = typeof record.markdown === 'string' ? record.markdown : '';
      const model = typeof record.model === 'string' ? record.model : '';
      const size = typeof record.size === 'string' ? record.size : '';
      const meta = [model ? '模型 `' + model + '`' : '', size ? size : ''].filter(Boolean).join(' · ');
      return [{ type: 'text', text: markdown + (meta ? '\n\n' + meta : '') }];
    }
  };

  const actualName = registerTool(ctx, {
    name: TOOL_NAME,
    description: [
      'Generate or edit an image with the configured image model, and show it in the conversation.',
      'Call it only when the user asks for a new or edited image; never call it for image questions, image descriptions, or non-image deliverables.',
      'Do not describe what you would generate instead of calling it, and do not call it proactively.',
      'Omit `image` for text-to-image. To edit, pass `image` with 1-8 absolute local paths or http(s) URLs and name each reference (图1/图2) inside `prompt`.',
      '`size` accepts 1K/2K/4K or WIDTHxHEIGHT; omit to use the configured default. `model`/`provider` override the active provider for this one call only.',
      'The result already contains a ready-to-send Markdown image line: reply with that line and nothing else. Output is final — never judge, describe, or re-read the image, and never switch tools or providers on your own.',
      'On failure, report the error text verbatim and stop; do not retry in a loop.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'The full image prompt. State subject, action, environment, style, lighting, composition, and any in-image text exactly as it should appear.'
        },
        size: {
          type: 'string',
          description: 'Optional. 1K / 2K / 4K, or WIDTHxHEIGHT such as 1024x1024. Omit to use the configured default.'
        },
        model: {
          type: 'string',
          description: 'Optional. Override the model id for this call only; omit to use the active provider model.'
        },
        provider: {
          type: 'string',
          description: 'Optional. Provider id from config, e.g. ark / openai / gemini. Omit to use the active provider.'
        },
        image: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional reference images for editing: 1-8 absolute local paths or http(s) URLs. Omit entirely for text-to-image.'
        },
        watermark: {
          type: 'boolean',
          description: 'Optional. Whether the provider adds a watermark. Omit to use the configured default.'
        }
      }
    },
    output,
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(rawArgs, exec) {
      const args = parseArgs(rawArgs);
      return generate(args, exec);
    }
  });

  logHost(PLUGIN + ' ready, tool=' + actualName);
}
