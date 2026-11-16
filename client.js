/**
 * dsh-imagen 的浏览器端。
 *
 * 两块界面：
 *   1. settings.section —— 设置页，管理提供商、模型列表、key、默认尺寸。
 *   2. conversation.input.right —— 输入栏里的「当前模型 + 图像大小」选择器。
 *
 * 两条纪律：
 *   - 密钥只单向传输：GET 只回掩码，保存时字段不出现就表示沿用原值。
 *   - 选择器只调窄接口 /api/imagen/selection，不把整份配置（含 key）来回传。
 */

window.__ModuleLoader__.load({
  id: 'dsh-imagen',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // portal 需要 react-dom；拿不到就退化成「永远不折叠」，不能让整个插件挂掉。
    const ReactDOM = (() => {
      try { return require('react-dom'); } catch (_error) { return null; }
    })();

    const SECTION_ID = 'dsh-imagen';
    const CONFIG_URL = '/api/imagen/config';
    const SELECTION_URL = '/api/imagen/selection';
    const SAVED_EVENT = 'dsh-imagen:config-saved';

    /* ------------------------------------------------------------ 文案 */

    const DICT = {
      zh: {
        nav: '生图',
        intro: '配置生图模型。保存后立即生效，不需要重启 DSH。',
        empty: '还没有配置任何提供商。',
        addProvider: '新增提供商',
        active: '当前使用',
        use: '设为当前',
        remove: '删除',
        kind: '接口类型',
        name: '名称',
        baseUrl: 'API 地址',
        baseUrlHint: '留空使用该接口的默认地址',
        models: '模型 id',
        modelsHint: '可填多个，用逗号或换行分隔',
        size: '默认图像大小',
        sizeHint: '1K / 2K / 4K，或 宽x高',
        watermark: '加平台水印',
        apiKey: 'API Key',
        apiKeyPlaceholder: '填入新密钥；留空表示沿用原值',
        currentKey: '当前密钥',
        clearKey: '清除',
        undoClear: '撤销清除',
        keyWillClear: '保存后将清空密钥',
        noKey: '尚未设置密钥',
        outputDir: '出图保存目录',
        outputDirHint: '相对路径基于当前会话的工作目录',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        reload: '重新读取',
        loading: '读取中…',
        failed: '操作失败',
        configFile: '配置文件',
        adaptersHint: '三个接口的字段差异：方舟支持 1K/2K/4K；OpenAI 只认具体宽高，档位会退回 auto；Gemini 忽略尺寸。',
        modelTitle: '当前生图模型',
        sizeTitle: '图像大小',
        autoSize: '自动'
      },
      en: {
        nav: 'Image',
        intro: 'Configure the image model. Saved changes apply immediately; no restart needed.',
        empty: 'No provider configured yet.',
        addProvider: 'Add provider',
        active: 'Active',
        use: 'Use this',
        remove: 'Remove',
        kind: 'API type',
        name: 'Name',
        baseUrl: 'Base URL',
        baseUrlHint: 'Leave empty to use the adapter default',
        models: 'Model ids',
        modelsHint: 'One or more, separated by commas or newlines',
        size: 'Default image size',
        sizeHint: '1K / 2K / 4K, or WIDTHxHEIGHT',
        watermark: 'Platform watermark',
        apiKey: 'API key',
        apiKeyPlaceholder: 'New key; leave empty to keep the current one',
        currentKey: 'Current key',
        clearKey: 'Clear',
        undoClear: 'Undo',
        keyWillClear: 'The key will be cleared on save',
        noKey: 'No key set',
        outputDir: 'Output directory',
        outputDirHint: 'Relative to the current session working directory',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        reload: 'Reload',
        loading: 'Loading…',
        failed: 'Failed',
        configFile: 'Config file',
        adaptersHint: 'Adapter differences: Ark accepts 1K/2K/4K; OpenAI only takes explicit dimensions, so tokens fall back to auto; Gemini ignores size.',
        modelTitle: 'Active image model',
        sizeTitle: 'Image size',
        autoSize: 'Auto'
      }
    };

    function activeLanguage(ctx) {
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null;
        const active = snapshot && snapshot.active ? String(snapshot.active).toLowerCase() : '';
        if (active.startsWith('zh')) return 'zh';
        return 'en';
      } catch (_error) {
        return 'en';
      }
    }

    function translate(ctx, key, params) {
      const dict = DICT[activeLanguage(ctx)];
      let text = dict[key] !== undefined ? dict[key] : DICT.en[key] !== undefined ? DICT.en[key] : key;
      if (params) {
        for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]));
      }
      return text;
    }

    function useTranslate(ctx) {
      const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        const off = locale.subscribe(() => bump((value) => value + 1));
        return typeof off === 'function' ? off : undefined;
      }, [locale]);
      return (key, params) => translate(ctx, key, params);
    }

    /* ------------------------------------------------------------ 样式 */

    const colors = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      base: 'var(--dsw-alias-bg-base)',
      brand: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      overlay: 'var(--dsw-alias-bg-overlay)'
    };

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', color: colors.text, fontSize: '13px', lineHeight: 1.5 },
      intro: { color: colors.dim, margin: 0 },
      card: { border: '1px solid ' + colors.border, borderRadius: '10px', background: colors.layer, padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      cardTitle: { fontWeight: 600, fontSize: '13px' },
      badge: { fontSize: '11px', padding: '1px 7px', borderRadius: '999px', border: '1px solid ' + colors.brand, color: colors.brand },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      label: { fontSize: '12px', color: colors.dim },
      hint: { fontSize: '11px', color: colors.dim },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit', color: colors.text, background: colors.base, border: '1px solid ' + colors.borderStrong, borderRadius: '6px' },
      textarea: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit', color: colors.text, background: colors.base, border: '1px solid ' + colors.borderStrong, borderRadius: '6px', resize: 'vertical', minHeight: '56px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      spacer: { flex: 1 },
      button: { padding: '5px 11px', fontSize: '12px', fontFamily: 'inherit', color: colors.text, background: 'transparent', border: '1px solid ' + colors.borderStrong, borderRadius: '6px', cursor: 'pointer' },
      buttonPrimary: { padding: '6px 14px', fontSize: '12px', fontFamily: 'inherit', color: '#fff', background: colors.brand, border: '1px solid ' + colors.brand, borderRadius: '6px', cursor: 'pointer' },
      buttonDanger: { padding: '5px 11px', fontSize: '12px', fontFamily: 'inherit', color: colors.danger, background: 'transparent', border: '1px solid ' + colors.borderStrong, borderRadius: '6px', cursor: 'pointer' },
      error: { color: colors.danger, fontSize: '12px', margin: 0 },
      ok: { color: colors.ok, fontSize: '12px', margin: 0 },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', color: colors.dim, wordBreak: 'break-all' },
      // 输入栏里的两个选择器：尽量矮、不带边框，和旁边的原生控件对齐。
      picker: {
        maxWidth: '200px',
        height: '24px',
        padding: '0 4px',
        fontSize: '12px',
        fontFamily: 'inherit',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid ' + colors.border,
        borderRadius: '6px',
        cursor: 'pointer'
      },
      pickerSize: {
        width: '64px',
        height: '24px',
        padding: '0 4px',
        fontSize: '12px',
        fontFamily: 'inherit',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid ' + colors.border,
        borderRadius: '6px',
        cursor: 'pointer'
      },
      pickerWrap: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      iconButton: {
        width: '26px',
        height: '24px',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid ' + colors.border,
        borderRadius: '6px',
        cursor: 'pointer'
      },
      menu: {
        background: colors.overlay,
        border: '1px solid ' + colors.border,
        borderRadius: '10px',
        padding: '6px',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.28)',
        color: colors.text,
        fontSize: '12px',
        maxHeight: '320px',
        overflowY: 'auto',
        boxSizing: 'border-box'
      },
      menuSection: { fontSize: '11px', color: colors.dim, margin: '6px 4px 4px' },
      menuItem: {
        display: 'block',
        width: '100%',
        boxSizing: 'border-box',
        textAlign: 'left',
        padding: '6px 8px',
        marginBottom: '2px',
        fontSize: '12px',
        fontFamily: 'inherit',
        color: 'inherit',
        background: 'transparent',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      },
      menuItemActive: { color: colors.brand, fontWeight: 600, background: colors.layer },
      chipRow: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '2px 4px 6px' },
      chip: {
        padding: '3px 10px',
        fontSize: '12px',
        fontFamily: 'inherit',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid ' + colors.borderStrong,
        borderRadius: '999px',
        cursor: 'pointer'
      },
      chipActive: { color: colors.brand, borderColor: colors.brand }
    };

    function Field(props) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, props.label),
        props.children,
        props.hint ? h('span', { style: S.hint }, props.hint) : null
      );
    }

    /* ------------------------------------------------------------ 数据 */

    async function requestJson(url, init) {
      const response = await fetch(url, Object.assign({ headers: { accept: 'application/json' } }, init || {}));
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) {
        throw new Error((body && body.error) || ('HTTP ' + response.status));
      }
      return body;
    }

    function splitModels(text) {
      return Array.from(new Set(String(text || '')
        .split(/[,，\n\r]+/)
        .map((item) => item.trim())
        .filter(Boolean)));
    }

    /** 服务端配置 → 可编辑草稿；apiKey 永远不落进草稿。 */
    function toDraft(config) {
      return {
        active: config.active || '',
        activeModel: config.activeModel || '',
        size: config.size || '',
        outputDir: config.outputDir || 'generated-images',
        providers: (config.providers || []).map((provider) => ({
          id: provider.id,
          kind: provider.kind,
          name: provider.name || '',
          baseUrl: provider.baseUrl || '',
          modelsText: (provider.models || []).join('\n'),
          watermark: provider.watermark === true,
          hasKey: provider.hasKey === true,
          keyHint: provider.keyHint || '',
          keyAction: 'keep',
          keyInput: ''
        }))
      };
    }

    function toPayload(draft) {
      return {
        active: draft.active,
        activeModel: draft.activeModel,
        size: draft.size,
        outputDir: draft.outputDir,
        providers: draft.providers.map((provider) => {
          const item = {
            id: provider.id,
            kind: provider.kind,
            name: provider.name,
            baseUrl: provider.baseUrl,
            models: splitModels(provider.modelsText),
            watermark: provider.watermark === true
          };
          if (provider.keyAction === 'clear') item.apiKey = '';
          if (provider.keyAction === 'set' && provider.keyInput.trim() !== '') item.apiKey = provider.keyInput.trim();
          return item;
        })
      };
    }

    /* ------------------------------------------------------ 设置页 UI */

    function ProviderCard(props) {
      const { provider, index, isActive, t, adapters, onChange, onActivate, onRemove, removable } = props;
      const patch = (next) => onChange(index, next);

      const kindOptions = adapters.map((adapter) =>
        h('option', { key: adapter.id, value: adapter.id }, adapter.label));

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('span', { style: S.cardTitle }, provider.name || provider.id),
          isActive ? h('span', { style: S.badge }, t('active')) : h('button', {
            type: 'button', style: S.button, onClick: () => onActivate(index)
          }, t('use')),
          h('span', { style: S.spacer }),
          removable ? h('button', { type: 'button', style: S.buttonDanger, onClick: () => onRemove(index) }, t('remove')) : null
        ),

        h('div', { style: S.grid },
          h(Field, { label: t('kind') },
            h('select', {
              style: S.input, value: provider.kind,
              onChange: (event) => patch({ kind: event.target.value })
            }, kindOptions)
          ),
          h(Field, { label: t('name') },
            h('input', {
              style: S.input, value: provider.name, placeholder: provider.id,
              onChange: (event) => patch({ name: event.target.value })
            })
          )
        ),

        h(Field, { label: t('baseUrl'), hint: t('baseUrlHint') },
          h('input', {
            style: S.input, value: provider.baseUrl,
            onChange: (event) => patch({ baseUrl: event.target.value })
          })
        ),

        h(Field, { label: t('models'), hint: t('modelsHint') },
          h('textarea', {
            style: S.textarea, value: provider.modelsText, spellCheck: false,
            onChange: (event) => patch({ modelsText: event.target.value })
          })
        ),

        h(Field, { label: t('apiKey') },
          h('div', { style: S.row },
            h('input', {
              style: Object.assign({}, S.input, { flex: 1, minWidth: '160px' }),
              type: 'password',
              autoComplete: 'off',
              // 默认永远是空输入框：不把旧值或掩码放进 value，避免看起来像已经填好了。
              value: provider.keyAction === 'set' ? provider.keyInput : '',
              placeholder: t('apiKeyPlaceholder'),
              onChange: (event) => patch({ keyAction: 'set', keyInput: event.target.value })
            }),
            provider.hasKey && provider.keyAction !== 'clear'
              ? h('button', { type: 'button', style: S.button, onClick: () => patch({ keyAction: 'clear', keyInput: '' }) }, t('clearKey'))
              : null,
            provider.keyAction === 'clear'
              ? h('button', { type: 'button', style: S.button, onClick: () => patch({ keyAction: 'keep', keyInput: '' }) }, t('undoClear'))
              : null
          ),
          provider.keyAction === 'clear'
            ? h('span', { style: S.hint }, t('keyWillClear'))
            : provider.hasKey
              ? h('span', { style: S.hint }, t('currentKey') + '：' + provider.keyHint)
              : h('span', { style: S.hint }, t('noKey'))
        ),

        h('label', { style: S.checkboxRow },
          h('input', {
            type: 'checkbox', checked: provider.watermark,
            onChange: (event) => patch({ watermark: event.target.checked })
          }),
          t('watermark')
        )
      );
    }

    function ImagenSettings(props) {
      const ctx = props.ctx;
      const t = useTranslate(ctx);
      const [phase, setPhase] = React.useState('loading');
      const [error, setError] = React.useState('');
      const [saved, setSaved] = React.useState(false);
      const [draft, setDraft] = React.useState(null);
      const [adapters, setAdapters] = React.useState([]);
      const [configFile, setConfigFile] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const adopt = React.useCallback((body) => {
        setDraft(toDraft(body.config));
        setAdapters(body.adapters || []);
        setConfigFile(body.configFile || '');
        setPhase('ready');
      }, []);

      const load = React.useCallback(() => {
        setPhase('loading');
        setError('');
        requestJson(CONFIG_URL).then(adopt).catch((cause) => {
          setError(String(cause && cause.message ? cause.message : cause));
          setPhase('error');
        });
      }, [adopt]);

      React.useEffect(() => { load(); }, [load]);

      const onChange = React.useCallback((index, next) => {
        setSaved(false);
        setDraft((current) => {
          if (!current) return current;
          const providers = current.providers.map((provider, position) => position === index ? Object.assign({}, provider, next) : provider);
          return Object.assign({}, current, { providers });
        });
      }, []);

      const onActivate = React.useCallback((index) => {
        setSaved(false);
        setDraft((current) => {
          if (!current) return current;
          const target = current.providers[index];
          if (!target) return current;
          const models = splitModels(target.modelsText);
          return Object.assign({}, current, { active: target.id, activeModel: models[0] || '' });
        });
      }, []);

      const onRemove = React.useCallback((index) => {
        setSaved(false);
        setDraft((current) => {
          if (!current) return current;
          const providers = current.providers.filter((_provider, position) => position !== index);
          if (!providers.some((provider) => provider.id === current.active)) {
            const first = providers[0];
            return Object.assign({}, current, {
              providers,
              active: first ? first.id : '',
              activeModel: first ? (splitModels(first.modelsText)[0] || '') : ''
            });
          }
          return Object.assign({}, current, { providers });
        });
      }, []);

      const onAdd = React.useCallback(() => {
        setSaved(false);
        setDraft((current) => {
          if (!current) return current;
          let index = current.providers.length + 1;
          let id = 'provider-' + index;
          while (current.providers.some((provider) => provider.id === id)) {
            index += 1;
            id = 'provider-' + index;
          }
          const created = {
            id, kind: 'openai', name: id, baseUrl: '', modelsText: '',
            watermark: false, hasKey: false, keyHint: '', keyAction: 'set', keyInput: ''
          };
          return Object.assign({}, current, { providers: current.providers.concat([created]) });
        });
      }, []);

      const onSave = React.useCallback(() => {
        if (!draft) return;
        setBusy(true);
        setError('');
        requestJson(CONFIG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ config: toPayload(draft) })
        }).then((body) => {
          adopt(body);
          setSaved(true);
          try { window.dispatchEvent(new CustomEvent(SAVED_EVENT)); } catch (_error) { /* 事件只是通知 */ }
        }).catch((cause) => {
          setError(String(cause && cause.message ? cause.message : cause));
        }).finally(() => {
          setBusy(false);
        });
      }, [draft, adopt]);

      if (phase === 'loading') {
        return h('div', { style: S.root }, h('p', { style: S.intro }, t('loading')));
      }
      if (phase === 'error') {
        return h('div', { style: S.root },
          h('p', { style: S.error }, t('failed') + '：' + error),
          h('button', { type: 'button', style: S.button, onClick: load }, t('reload'))
        );
      }
      if (!draft) return null;

      return h('div', { style: S.root },
        h('p', { style: S.intro }, t('intro')),

        draft.providers.length === 0
          ? h('p', { style: S.intro }, t('empty'))
          : draft.providers.map((provider, index) => h(ProviderCard, {
            key: provider.id + ':' + index,
            provider,
            index,
            isActive: provider.id === draft.active,
            t,
            adapters,
            onChange,
            onActivate,
            onRemove,
            removable: draft.providers.length > 1
          })),

        h('div', { style: S.row },
          h('button', { type: 'button', style: S.button, onClick: onAdd }, t('addProvider'))
        ),

        h(Field, { label: t('size'), hint: t('sizeHint') },
          h('input', {
            style: S.input, value: draft.size, placeholder: '2K',
            onChange: (event) => { setSaved(false); setDraft(Object.assign({}, draft, { size: event.target.value })); }
          })
        ),

        h(Field, { label: t('outputDir'), hint: t('outputDirHint') },
          h('input', {
            style: S.input, value: draft.outputDir,
            onChange: (event) => { setSaved(false); setDraft(Object.assign({}, draft, { outputDir: event.target.value })); }
          })
        ),

        h('p', { style: S.hint }, t('adaptersHint')),

        h('div', { style: S.footer },
          h('button', {
            type: 'button', style: S.buttonPrimary, disabled: busy, onClick: onSave
          }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', style: S.button, disabled: busy, onClick: load }, t('reload')),
          saved ? h('span', { style: S.ok }, t('saved')) : null,
          error ? h('span', { style: S.error }, t('failed') + '：' + error) : null
        ),

        configFile ? h('div', null,
          h('span', { style: S.hint }, t('configFile') + '：'),
          h('span', { style: S.code }, configFile)
        ) : null
      );
    }

    /* -------------------------------------------------- 输入栏选择器 */

    /** 把所有提供商的所有模型摊平成一个列表；value 带提供商前缀，防止两家同名模型撞车。 */
    function modelOptions(config) {
      const options = [];
      const multiProvider = (config.providers || []).length > 1;
      for (const provider of config.providers || []) {
        for (const model of provider.models || []) {
          options.push({
            value: provider.id + '\u0000' + model,
            label: multiProvider ? provider.name + ' · ' + model : model,
            provider: provider.id,
            model
          });
        }
      }
      return options;
    }

    const SIZE_VALUES = ['1K', '2K', '4K'];

    /**
     * 可用宽度小于这个值就收成一个图标：两个下拉约占 264px，再挤就没地方放
     * 别的控件了。想调手感只改这一个数。
     */
    const COMPACT_WIDTH = 460;

    function PickerIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14;
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', color: 'currentColor' }
      },
        h('rect', { x: 6, y: 18, width: 52, height: 36, rx: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 6 }),
        h('circle', { cx: 32, cy: 36, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 6 }),
        h('path', { d: 'M22 18l4-6h12l4 6', fill: 'none', stroke: 'currentColor', strokeWidth: 6, strokeLinejoin: 'round' })
      );
    }

    function ComposerPicker(props) {
      const ctx = props.ctx;
      const t = useTranslate(ctx);
      const [config, setConfig] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [compact, setCompact] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const anchorRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const lastCompactRef = React.useRef(null);

      const refresh = React.useCallback(() => {
        requestJson(SELECTION_URL).then((body) => {
          setConfig(body.config || null);
          setError('');
        }).catch((cause) => {
          setError(String(cause && cause.message ? cause.message : cause));
        });
      }, []);

      /**
       * 插件可能比页面晚就绪（宿主重启后加载顺序会变），这时路由还不存在。
       * 不能就此永久消失：先每 3 秒重试、最多约一分钟，之后靠窗口重新获得焦点
       * 再拉一次。这样用户不用为了一个下拉刷新整页。
       */
      React.useEffect(() => {
        let cancelled = false;
        let timer = null;
        let attempts = 0;
        const attempt = () => {
          requestJson(SELECTION_URL).then((body) => {
            if (cancelled) return;
            setConfig(body.config || null);
            setError('');
          }).catch((cause) => {
            if (cancelled) return;
            setError(String(cause && cause.message ? cause.message : cause));
            attempts += 1;
            if (attempts < 20) timer = setTimeout(attempt, 3000);
          });
        };
        attempt();
        const onFocus = () => { if (!cancelled) attempt(); };
        window.addEventListener('focus', onFocus);
        return () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
          window.removeEventListener('focus', onFocus);
        };
      }, []);

      React.useEffect(() => {
        const onSaved = () => refresh();
        window.addEventListener(SAVED_EVENT, onSaved);
        return () => window.removeEventListener(SAVED_EVENT, onSaved);
      }, [refresh]);

      /**
       * 宽度探测：宽了展开成两个下拉，窄了收成图标。
       *
       * 判定依据取「祖先里最宽的那个」（不含 body/html）。之前试过另外两种，
       * 都被宿主的包装层骗了：
       *   - 量 parentElement：那是只装我们自己的 wrapper，宽度等于控件本身，
       *     折叠后会形成「变宽→展开→变窄→折叠」的死循环。
       *   - 量第一个「子元素多于一个」的祖先：仍可能命中外层的一个窄包装，
       *     结果全屏也只量到两百多，永远折叠。
       * 取最大值最稳：全屏时它就是对话列宽度，缩窄时它会跟着变小。
       * 再加一条兜底：量到的宽度比展开态本身还窄，说明量错了对象，宁可展开。
       */
      React.useEffect(() => {
        const node = anchorRef.current;
        if (!node || typeof ResizeObserver !== 'function') return undefined;

        let outermost = null;
        let probe = node.parentElement;
        for (let depth = 0; probe && depth < 7; depth += 1, probe = probe.parentElement) {
          if (probe === document.body || probe === document.documentElement) break;
          outermost = probe;
        }

        const measure = () => {
          let widest = 0;
          let walk = node.parentElement;
          for (let depth = 0; walk && depth < 7; depth += 1, walk = walk.parentElement) {
            if (walk === document.body || walk === document.documentElement) break;
            const width = walk.getBoundingClientRect().width;
            if (width > widest) widest = width;
          }
          if (!widest) widest = window.innerWidth;
          const shouldCompact = widest >= 200 && widest < COMPACT_WIDTH;
          if (lastCompactRef.current !== shouldCompact) {
            lastCompactRef.current = shouldCompact;
            // 留一行日志，方便你告诉我实际量到多少、阈值该调到多少。
            console.log('[dsh-imagen] composer width=' + Math.round(widest) + ' compact=' + shouldCompact);
          }
          setCompact(shouldCompact);
          // 变宽后弹层没有锚点了，直接关掉，避免它悬在半空。
          if (!shouldCompact) setOpen(false);
        };

        measure();
        const observer = new ResizeObserver(measure);
        if (outermost) observer.observe(outermost);
        window.addEventListener('resize', measure);
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', measure);
        };
      }, [config]);

      // 点外面或按 Esc 关弹层。
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          const anchor = anchorRef.current;
          const menu = menuRef.current;
          if (anchor && anchor.contains(event.target)) return;
          if (menu && menu.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);

      const send = React.useCallback((selection) => {
        setBusy(true);
        requestJson(SELECTION_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ selection })
        }).then((body) => {
          setConfig(body.config || null);
          setError('');
        }).catch((cause) => {
          setError(String(cause && cause.message ? cause.message : cause));
          refresh();
        }).finally(() => {
          setBusy(false);
        });
      }, [refresh]);

      if (!config || !Array.isArray(config.providers) || config.providers.length === 0) return null;

      const options = modelOptions(config);
      if (options.length === 0) return null;

      const currentValue = config.active + '\u0000' + config.activeModel;
      const currentOption = options.find((item) => item.value === currentValue) || options[0];
      const sizeValue = config.size || '';
      const sizeChoices = SIZE_VALUES.slice();
      if (sizeValue && sizeChoices.indexOf(sizeValue) === -1) sizeChoices.push(sizeValue);
      const summary = currentOption.label + ' \u00b7 ' + (sizeValue || t('autoSize'));
      const collapsed = compact && !!ReactDOM;

      let menuStyle = null;
      if (open && collapsed && anchorRef.current && typeof window !== 'undefined') {
        const rect = anchorRef.current.getBoundingClientRect();
        const menuWidth = 264;
        menuStyle = {
          position: 'fixed',
          left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)) + 'px',
          // 输入框在底部，弹层往上开。
          bottom: Math.max(8, window.innerHeight - rect.top + 8) + 'px',
          width: menuWidth + 'px',
          zIndex: 2147483000
        };
      }

      const closeMenu = () => setOpen(false);

      const menu = open && menuStyle ? ReactDOM.createPortal(
        h('div', { ref: menuRef, style: Object.assign({}, S.menu, menuStyle), role: 'menu' },
          h('div', { style: S.menuSection }, t('modelTitle')),
          options.map((option) => h('button', {
            key: option.value,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': option.value === currentOption.value,
            style: Object.assign({}, S.menuItem, option.value === currentOption.value ? S.menuItemActive : null),
            onClick: () => { send({ active: option.provider, activeModel: option.model }); closeMenu(); }
          }, option.label)),

          h('div', { style: S.menuSection }, t('sizeTitle')),
          h('div', { style: S.chipRow }, sizeChoices.map((value) => h('button', {
            key: value || 'auto',
            type: 'button',
            'aria-pressed': value === sizeValue,
            style: Object.assign({}, S.chip, value === sizeValue ? S.chipActive : null),
            onClick: () => { send({ size: value }); closeMenu(); }
          }, value || t('autoSize'))))
        ),
        document.body
      ) : null;

      return h('span', { ref: anchorRef, style: S.pickerWrap, title: collapsed ? summary : (error || '') },
        collapsed
          ? h('button', {
            type: 'button',
            style: S.iconButton,
            disabled: busy,
            title: summary,
            'aria-label': t('modelTitle') + ' / ' + t('sizeTitle'),
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value)
          }, h(PickerIcon, { size: 14 }))
          : null,

        collapsed ? null : h('select', {
          style: S.picker,
          value: currentValue,
          disabled: busy,
          title: t('modelTitle'),
          'aria-label': t('modelTitle'),
          onChange: (event) => {
            const picked = options.find((option) => option.value === event.target.value);
            if (!picked) return;
            send({ active: picked.provider, activeModel: picked.model });
          }
        }, options.map((option) =>
          h('option', { key: option.value, value: option.value }, option.label))),

        collapsed ? null : h('select', {
          style: S.pickerSize,
          value: sizeValue,
          disabled: busy,
          title: t('sizeTitle'),
          'aria-label': t('sizeTitle'),
          onChange: (event) => send({ size: event.target.value })
        }, sizeChoices.map((value) =>
          h('option', { key: value || 'auto', value: value }, value || t('autoSize')))),

        menu
      );
    }

    /* ------------------------------------------------------------ 图标 */

    function NavIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', color: 'currentColor' }
      },
        h('rect', { x: 6, y: 18, width: 52, height: 36, rx: 7, fill: 'none', stroke: 'currentColor', strokeWidth: 5 }),
        h('circle', { cx: 32, cy: 36, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 5 }),
        h('path', { d: 'M22 18l4-6h12l4 6', fill: 'none', stroke: 'currentColor', strokeWidth: 5, strokeLinejoin: 'round' })
      );
    }

    function Section(props) {
      return h(ImagenSettings, { ctx: props.ctx });
    }

    function Composer(props) {
      return h(ComposerPicker, { ctx: props.ctx });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const register = (slot, id, order, component, label) => {
          try {
            const disposeInject = ctx.slots.inject(slot, () => ctx.slots.register({
              name: slot,
              id,
              order,
              label,
              inject: () => ({ ctx })
            }, component));
            if (disposeInject) ctx.effect(() => disposeInject, 'dsh-imagen: ' + id);
          } catch (error) {
            console.error('[dsh-imagen] ' + id + ' registration failed:', error);
          }
        };

        register('settings.section', SECTION_ID, 36, Section, () => translate(ctx, 'nav'));

        try {
          const disposeIcon = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
            name: 'settings.section.icon',
            id: SECTION_ID
          }, NavIcon));
          if (disposeIcon) ctx.effect(() => disposeIcon, 'dsh-imagen: settings nav icon');
        } catch (error) {
          console.error('[dsh-imagen] settings nav icon registration failed (page unaffected):', error);
        }

        register('conversation.input.right', 'dsh-imagen-picker', 50, Composer, () => translate(ctx, 'nav'));
      }
    };
  }
});
