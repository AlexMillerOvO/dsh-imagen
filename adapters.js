/**
 * 生图接口适配层。
 *
 * 插件其余部分只认一种规范输入：
 *   { provider, prompt, size, watermark, images }
 *
 * 每个适配器只负责三件事：
 *   request(provider, spec) —— 把规范输入翻成一次 HTTP 请求
 *   parse(body)            —— 从回应 JSON 里挖出图片（URL 或 base64）
 *   describeError(body)    —— 把上游错误翻成一句能看懂的报错
 *
 * 新增一家平台 = 在 ADAPTERS 里加一条，不用改 index.js。
 *
 * 本文件不碰网络、不碰文件系统，所以 test/ 里不需要 key 就能跑。
 */

/** 尺寸写法：1K / 2K / 4K，或 宽x高。上游各自接受的范围不同，下面逐个处理。 */
const SIZE_TOKENS = { '1k': '1K', '2k': '2K', '4k': '4K' };

/**
 * 把用户写的尺寸规整成两种之一：'1K'/'2K'/'4K' 或 '1024x1024'；空 → ''（用默认）。
 * 认不出就抛错——宁可报错，也不要悄悄换一个尺寸出图。
 */
export function normalizeSize(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return '';
  const lower = text.toLowerCase().replace(/\s+/g, '');
  if (lower === 'auto') return 'auto';
  if (SIZE_TOKENS[lower]) return SIZE_TOKENS[lower];
  const match = /^(\d{2,5})[x×*](\d{2,5})$/.exec(lower);
  if (!match) {
    throw new Error('无法识别的尺寸：' + text + '。请用 1K / 2K / 4K，或 宽x高（如 1024x1024）。');
  }
  return Number(match[1]) + 'x' + Number(match[2]);
}

/** 拼 URL 时去掉多余斜杠，避免 baseUrl 末尾带 / 导致 //。 */
function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const tail = String(suffix || '').replace(/^\/+/, '');
  return base + '/' + tail;
}

function requireModel(provider) {
  const model = String(provider.model || '').trim();
  if (!model) throw new Error('提供商 ' + (provider.name || provider.id) + ' 没有填写模型 id，请先在配置里补上。');
  return model;
}

function authHeaders(provider) {
  const key = String(provider.apiKey || '').trim();
  if (!key) {
    throw new Error('提供商 ' + (provider.name || provider.id) + ' 没有配置 apiKey，请先写入 ~/.dsh/imagen/config.json。');
  }
  return { 'content-type': 'application/json', authorization: 'Bearer ' + key };
}

/* ------------------------------------------------------------------ 火山方舟 */

/**
 * 火山方舟 Seedream：OpenAI 形状的 /images/generations，但多几个自己的字段。
 * 参考图直接放进 body.image（URL 或 data URL 数组），不是 multipart。
 */
const ark = {
  id: 'ark',
  label: '火山方舟 Seedream',
  defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  supportsEdit: true,

  request(provider, spec) {
    const body = {
      model: requireModel(provider),
      prompt: spec.prompt,
      response_format: 'url',
      stream: false
    };
    const size = normalizeSize(spec.size === undefined ? provider.size : spec.size);
    if (size && size !== 'auto') body.size = size;
    if (typeof spec.watermark === 'boolean') body.watermark = spec.watermark;
    if (Array.isArray(spec.images) && spec.images.length > 0) body.image = spec.images;
    if (Number.isFinite(spec.seed)) body.seed = spec.seed;
    return {
      url: joinUrl(provider.baseUrl || this.defaultBaseUrl, 'images/generations'),
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify(body)
    };
  },

  parse(body) {
    const data = body && Array.isArray(body.data) ? body.data : [];
    return {
      model: body && body.model ? String(body.model) : '',
      images: data.map((item) => ({
        url: item && item.url ? String(item.url) : '',
        base64: item && item.b64_json ? String(item.b64_json) : ''
      }))
    };
  },

  describeError(body) {
    const error = body && body.error;
    if (!error) return '';
    return String(error.message || error.code || '') + (error.code ? '（' + error.code + '）' : '');
  }
};

/* ------------------------------------------------------- OpenAI Images 兼容 */

/**
 * OpenAI Images 兼容（官方 gpt-image-*、各类中转站、兼容网关）。
 * 官方只吃 1024x1024 / 1536x1024 / 1024x1536 / auto，所以令牌写法退回 auto，
 * 只有显式宽高才原样透传。默认要 b64_json，避免再下载一次外链。
 */
const openai = {
  id: 'openai',
  label: 'OpenAI Images 兼容',
  defaultBaseUrl: 'https://api.openai.com/v1',
  supportsEdit: true,

  request(provider, spec) {
    const model = requireModel(provider);
    const size = normalizeSize(spec.size === undefined ? provider.size : spec.size);
    const body = { model, prompt: spec.prompt, n: 1, response_format: 'b64_json' };
    // 令牌（1K/2K/4K）在官方接口上没有对应写法，交给 auto，别硬塞一个它不认的值。
    body.size = size && size !== '1K' && size !== '2K' && size !== '4K' ? size : 'auto';

    const images = Array.isArray(spec.images) ? spec.images : [];
    if (images.length > 0) {
      // 改图接口是 multipart，这里返回 formData，由 index.js 直接交给 fetch。
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', spec.prompt);
      if (body.size !== 'auto') form.append('size', body.size);
      for (const image of images) {
        const { bytes, mimeType } = dataUrlToBytes(image);
        form.append('image', new Blob([bytes], { type: mimeType }), 'reference.' + extensionForMime(mimeType));
      }
      const key = String(provider.apiKey || '').trim();
      if (!key) authHeaders(provider); // 复用同一条报错
      return {
        url: joinUrl(provider.baseUrl || this.defaultBaseUrl, 'images/edits'),
        method: 'POST',
        // multipart 的 content-type 必须由 fetch 自己带 boundary。
        headers: { authorization: 'Bearer ' + key },
        body: form
      };
    }

    return {
      url: joinUrl(provider.baseUrl || this.defaultBaseUrl, 'images/generations'),
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify(body)
    };
  },

  parse(body) {
    const data = body && Array.isArray(body.data) ? body.data : [];
    return {
      model: body && body.model ? String(body.model) : '',
      images: data.map((item) => ({
        url: item && item.url ? String(item.url) : '',
        base64: item && item.b64_json ? String(item.b64_json) : ''
      }))
    };
  },

  describeError(body) {
    const error = body && body.error;
    if (!error) return '';
    return String(error.message || error.code || '') + (error.type ? '（' + error.type + '）' : '');
  }
};

/* ------------------------------------------------------------- Google Gemini */

/**
 * Gemini 原生：generateContent，图片以 inlineData 回来。
 * 没有 size 参数，比例只能靠提示词；这里忽略 size 而不是报错，避免模型每次都被挡。
 */
const gemini = {
  id: 'gemini',
  label: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  supportsEdit: true,

  request(provider, spec) {
    const model = requireModel(provider);
    const parts = [{ text: spec.prompt }];
    for (const image of Array.isArray(spec.images) ? spec.images : []) {
      const { bytes, mimeType } = dataUrlToBytes(image);
      parts.push({ inline_data: { mime_type: mimeType, data: bytes.toString('base64') } });
    }
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    };
    const key = String(provider.apiKey || '').trim();
    if (!key) authHeaders(provider); // 复用同一条报错
    return {
      url: joinUrl(provider.baseUrl || this.defaultBaseUrl, 'models/' + encodeURIComponent(model) + ':generateContent'),
      method: 'POST',
      // key 放请求头而不是 URL，免得写进日志或错误信息里。
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body)
    };
  },

  parse(body) {
    const candidates = body && Array.isArray(body.candidates) ? body.candidates : [];
    const images = [];
    for (const candidate of candidates) {
      const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        const inline = part && (part.inlineData || part.inline_data);
        if (inline && inline.data) {
          images.push({ url: '', base64: String(inline.data), mimeType: String(inline.mimeType || inline.mime_type || 'image/png') });
        }
      }
    }
    return { model: '', images };
  },

  describeError(body) {
    const error = body && body.error;
    if (!error) return '';
    return String(error.message || error.status || '') + (error.status ? '（' + error.status + '）' : '');
  }
};

/* --------------------------------------------------------------------- 导出 */

const ADAPTERS = { ark, openai, gemini };

export function resolveAdapter(kind) {
  const id = String(kind || '').trim().toLowerCase();
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error('不支持的接口类型：' + (kind || '(空)') + '。可选：' + Object.keys(ADAPTERS).join(' / '));
  }
  return adapter;
}

export function describeAdapters() {
  return Object.values(ADAPTERS).map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    defaultBaseUrl: adapter.defaultBaseUrl,
    supportsEdit: adapter.supportsEdit
  }));
}

/** 'data:image/png;base64,xxx' → { bytes, mimeType }。 */
export function dataUrlToBytes(dataUrl) {
  const text = String(dataUrl || '');
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(text);
  if (!match) throw new Error('参考图不是 data URL 格式。');
  const mimeType = match[1] || 'application/octet-stream';
  const payload = match[3] || '';
  const bytes = match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { bytes, mimeType };
}

export function extensionForMime(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'png';
}

/** 从字节头判断真实类型，决定落盘扩展名和预览响应的 Content-Type。 */
export function sniffMimeType(bytes) {
  if (!bytes || bytes.length < 12) return 'image/png';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return 'image/png';
}
