# dsh-imagen

给 DeepSeek Harness 用的文生图插件：在对话里直接让模型出图，或拿参考图改图。

支撑三家接口，配置里切换，不改代码：

| `kind` | 平台 | 说明 |
|---|---|---|
| `ark` | 火山方舟 Seedream | 豆包生图，URL 或 base64 返回都认 |
| `openai` | OpenAI Images 兼容 | 官方 `gpt-image-*`、各类中转站、兼容网关 |
| `gemini` | Google Gemini | `gemini-*-image`，原生 `generateContent` |

## 它怎么工作

```
模型调用 dsh-imagen 工具
  → 按配置选一家接口 → 拿回图片字节
  → 落盘到当前工作区 generated-images/
  → 用一个 HMAC 签名的本地 URL
  → 在对话里显示成 Markdown 图片
```

为什么不直接把上游外链丢给前端：方舟这类接口返回的是带时效的签名 URL，几小时后失效；存一份本地的，翻回对话还能看到图。

## 安装

已经通过插件管理器装进 `desktop` profile。重新安装或更新代码后：

```bash
# 源码改动后让宿主重新加载（不需要重启整个 DSH）
#   在对话里让我执行 set_plugin false → true，或者重启 DSH
```

卸载：

```bash
dsh plugin --profile desktop remove dsh-imagen
```

## 配置

文件位置：`~/.dsh/imagen/config.json`（权限 600，密钥只在这里）。

```json
{
  "version": 2,
  "active": "ark",
  "activeModel": "doubao-seedream-5-0-flash-260915",
  "size": "2K",
  "outputDir": "generated-images",
  "providers": [
    {
      "id": "ark",
      "kind": "ark",
      "name": "火山方舟 Seedream",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
      "apiKey": "ark-xxxxxxxx",
      "models": [
        "doubao-seedream-5-0-flash-260915",
        "doubao-seedream-5-0-260915"
      ],
      "watermark": false
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `active` | 是 | 当前用哪家的 `id` |
| `activeModel` | 否 | 当前用这个家下面的哪个模型；不在 `models` 里会退回第一个 |
| `size` | 否 | 当前图像大小：`1K` / `2K` / `4K` / `宽x高`；空字符串表示交给上游自动 |
| `outputDir` | 否 | 出图目录，默认 `generated-images` |
| `providers[].id` | 是 | 自己起的名字，工具参数 `provider` 用它选 |
| `providers[].kind` | 是 | `ark` / `openai` / `gemini` |
| `providers[].baseUrl` | 否 | 不填用该家默认地址 |
| `providers[].apiKey` | 是 | 对应平台的 key |
| `providers[].models` | 是 | 模型 id 数组，至少一个 |
| `providers[].watermark` | 否 | 是否加水印，默认 `false` |

换模型/换尺寸这件事现在不用改文件，直接点输入栏里的两个选择器。也可以给工具传 `provider` / `model` / `size` 临时覆盖一次——都不会改配置文件。

> 旧版（v1，单 `model` 字段）的配置**不用手动迁移**：读取时会自动兼容，第一次保存后自动写成 v2。

### 三家接口的差异（配置时容易踩）

- **ark**：`size` 支持 `1K`/`2K`/`4K` 或 `宽x高`。参考图直接放进请求体的 `image` 数组（URL 或 data URL），不是 multipart。
- **openai**：官方只认 `1024x1024` / `1536x1024` / `1024x1536` / `auto`，所以写 `1K`/`2K`/`4K` 会被换成 `auto`；显式写宽高才原样透传。改图走 multipart。
- **gemini**：没有尺寸参数，`size` 会被忽略（不会报错），比例只能写进提示词。

## 设置页

打开 **设置 → 生图**（在 workbuddy 那一项下面）。这一页能做的事：

- 增删提供商、切换接口类型（ark / openai / gemini）
- 填 API 地址、API Key、**多个模型 id**（逗号或换行分隔）、是否加水印
- 点「设为当前」切换默认使用哪一家
- 设置默认图像大小、出图保存目录
- 保存后**立即生效**：插件每次出图都会重新读配置文件，不用重启

密钥的处理是单向的：

- **API Key 输入框默认永远是空的**，不会把旧值或掩码预先填进去
- 当前密钥只以 `••••` 加尾号 4 位显示在输入框下方，拿不到完整值
- 输入框留空 = 保存时不动原来的 key
- 想换 key 就填新的；想删就点「清除」再保存

安全边界：配置接口只接受**本机请求**，外部 Origin 一律 403（已实测），所以别的网页没法改你的 key。

## 输入栏选择器

对话输入框右侧有两个下拉：

- **当前生图模型**：列出所有配置过的模型。选别家的模型时，提供商自动跟着切——不然请求会发到错的上游。
- **图像大小**：`1K` / `2K` / `4K` / `自动`。

切换后立刻写回配置，下一句对话就按新的模型和尺寸出图，不用进设置页。这两个下拉走的是独立的窄接口 `/api/imagen/selection`，只传模型和尺寸三个字段，不会把整份配置（含 key）搬来搬去。

## 工具参数

工具名 `dsh-imagen`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | 是 | 完整画面描述 |
| `size` | string | 否 | `1K` / `2K` / `4K` / `宽x高` |
| `model` | string | 否 | 本次临时覆盖模型 |
| `provider` | string | 否 | 本次临时指定提供商 |
| `image` | string[] | 否 | 参考图 1–8 张，本地绝对路径或 http(s) URL；纯文生图请整个省略 |
| `watermark` | boolean | 否 | 本次是否加水印 |

参数名写错、类型写错、`image` 传空数组，都会直接报错，不会静默忽略——这一点是故意的：静默忽略会让模型以为自己传对了。

## 出图存哪

`<当前工作区>/generated-images/imagen-<时间>-<随机>.png`。

图片通过 `http://127.0.0.1:60682/api/imagen/preview/<令牌>` 显示，令牌用 `~/.dsh/imagen/preview.key` 做 HMAC 签名，改一个字符就读不到别的文件（实测伪造令牌返回 404）。

## 别的会话怎么知道该调用它

工具描述只说清了「这个工具能干什么」，说不清「什么时候不该用」——模型看到一堆工具时容易乱调。所以插件往系统提示词里注册了一段路由规则：

- 位置：`systemPrompt.section`，name 是 `dsh-imagen:routing`，order 2940
- 生效范围：**所有会话**，包括子代理。每次组装提示词时带上，不需要用户做什么
- 规则内容（英文原文在 `index.js` 的 `ROUTING_SECTION`）：

| 情况 | 行为 |
|---|---|
| 用户要画图、生成图、做海报、改图 | 调用 `dsh-imagen` |
| 只是聊图、问图、让人描述/读取已有图片 | 不调用 |
| 交付物是文字、代码、文档、流程图、图表 | 不调用 |
| 用户没要求新图或改图 | 不调用 |
| 同时存在别的生图工具 | 默认优先用这个，除非用户点名别的 |

另外工具描述里也补了同样的反向约束（「do not call it for image questions, image descriptions, or non-image deliverables」），两道保险。

想改这段规则：编辑 `index.js` 里的 `ROUTING_SECTION` 常量，然后重载插件。规则是纯文本、不随配置变化，所以不会因为换了模型就失配。

## 常见问题

### 1. HTTP 429 `SetLimitExceeded` / `Safe Experience Mode`

原文：

```
Your account has reached the set usage limit for the [doubao-seedream-5-0-flash] model,
and the model service has been paused. To continue using this model, please visit the
Model Activation page to adjust or close the "Safe Experience Mode".
```

通俗说：**模型被账户侧的「安全体验模式」限额停掉了，充钱不解决这个**——这是新开通模型默认带的体验额度开关，和余额是两回事。

解决：火山方舟控制台 → 模型开通/管理页 → 找到 `doubao-seedream-5-0-flash` → 关闭「安全体验模式」或调高上限。

### 2. HTTP 401 / `AuthenticationError`

key 不对、过期，或者复制时带了空格。检查 `config.json` 里的 `apiKey`。

### 3. HTTP 404 `InvalidEndpointOrModel.NotFound`

模型 id 不对，或者该模型没在这个账号下开通。**注意：开通了才有的模型 id 才能用**，比如本账号只有 `doubao-seedream-5-0-flash-260915` 可用，`doubao-seedream-4-0-250828` 会报 404。

### 4. 改了配置不生效

每次出图都会重新读 `config.json`，所以**改配置立刻生效**，不用重载插件。只有改 `index.js` / `adapters.js` 的代码才需要重载。

### 5. 图片显示成裂图

先确认预览路由通：`curl -I http://127.0.0.1:60682/api/imagen/preview/<令牌>`。返回 404 说明文件被删了或令牌过期（令牌本身不过期，但文件删了就没法读）。

## 本地自测（不花钱）

```bash
cd dsh-plugins/dsh-imagen
npm test                    # 15 个适配层单测，不需要 key
node scripts/mock-ark.mjs 18080   # 起一个假的方舟接口
```

然后在 `config.json` 加一个 provider 指过去：

```json
{ "id": "mock", "kind": "ark", "baseUrl": "http://127.0.0.1:18080/api/v3",
  "apiKey": "mock", "model": "mock-image", "size": "2K" }
```

调用工具时传 `provider: "mock"`，就能在没有真实 key 的情况下跑通「请求 → 解析 → 落盘 → 预览」整条链路。

## 目录结构

```
dsh-imagen/
  index.js            注册工具、预览路由、配置读写接口、落盘
  adapters.js         三家接口的请求构造与回应解析（纯函数，可单测）
  client.js           设置页（Client 半，挂在 settings.section）
  cordis.patch.yml    插件行
  locale/{zh,en}.json 插件管理器的标题与描述
  icon.svg            图标
  scripts/mock-ark.mjs 本地假接口
  test/adapters.test.mjs
```

新增一家平台：在 `adapters.js` 的 `ADAPTERS` 里加一条（`id` / `label` / `request` / `parse` / `describeError`），不用改 `index.js`。

## 安全

- 密钥只存在 `~/.dsh/imagen/config.json`，权限 600，不进代码、不进仓库。
- 预览 URL 带 HMAC 签名，无法通过改路径读其他文件。
- 插件不会把 key 写进日志；错误信息里也不会带 key。
