/*
 * FlashAlphaChart core: an embeddable candlestick chart with gamma exposure levels, on TradingView lightweight-charts 5.
 *
 *   <div id="spx" style="height: 480px"></div>
 *   <script src="https://unpkg.com/lightweight-charts@5.0.0/dist/lightweight-charts.standalone.production.js"></script>
 *   <script src="flashalpha-chart-core.js"></script>
 *   <script>
 *     const chart = FlashAlphaChart.mount(document.getElementById('spx'), { symbol: 'SPX', resolution: '5m', apiKey: 'YOUR_KEY' });
 *     chart.setLayers(['levels', 'maxpain']);   // setSymbol, setResolution, setRange, setSession, reload, destroy
 *   </script>
 *
 * Layers (the "Layers" menu, or options.layers / setLayers):
 *   levels   call wall, put wall, gamma flip (grey when the flip is not certified)
 *   maxpain  max pain
 * More layers can be added with FlashAlphaChart.registerLayers(plugin), see below.
 * Under the chart, key levels as text (options.keyLevels, default true): spot, call wall, put wall, gamma flip, max pain at
 * the latest exposure row, with the change since the previous session's last row (daily resolutions read the last 5 days at 1h).
 * When there is nothing to draw (unknown symbol, no bars, the API unreachable) a message covers the chart and the container
 * gets a bubbling 'flashalpha:nodata' CustomEvent, detail {symbol, error}, e.g. to hide the section. An unknown symbol is
 * not polled again. Below 560 px wide the toolbar and the legend are compact (one line until the crosshair is on the chart).
 * options.brand {logo, href, name}: the logo (a link to href) under the chart instead of the TradingView logo on the chart,
 * next to a "Charts by TradingView" text link (the Lightweight Charts license asks for one).
 * options.note: a line under the chart next to the credit (default: the levels are model estimates, not dealer positions;
 * '' hides it). The Upgrade box names the plan and what it adds.
 * options.theme 'dark' (default), 'light' or 'auto' (follows the reader's prefers-color-scheme); options.background overrides
 * the background colour. options.debug shows load status in the toolbar.
 * Keys and plans: options.apiKey, or FlashAlphaChart.setLicenseKey(key) once for every chart on the page. On a public page use
 * an embed key (fa_pk_…, locked to your domains); the chart warns in the console when it sees a secret key. The API answers
 * with the key's plan (response.plan): layers above it show a lock and a link to options.upgradeUrl (FlashAlpha pricing,
 * tagged utm_source=chart), and an "Upgrade" box over the chart names the picked layers the plan does not include.
 * Errors from the API are shown in words (a bad key, a domain the key is not for, rate limits), not as codes.
 *
 * The chart fills its container and follows its size. Data comes from a source object, so the same widget can read the
 * FlashAlpha chart API (default: FlashAlphaChart.chartEngineSource(baseUrl, apiKey)) or any backend that returns the same shapes:
 *   symbols() -> [{symbol, last_bar}]
 *   bars(symbol, resolution, fromIso, toIso, session 'rth'|'eth') -> {bars: [{ts, open, high, low, close, volume, source}]}
 *   charts(symbol, resolution, fromIso, toIso, {layers: ['exposure', ...], session, ...query})
 *     -> {exposure: [{ts, gamma_flip: {last, status}, call_wall, put_wall, max_pain, spot: {first, min, max, last}}], layers: {...}}
 * Times are shown in ET. A NULL level is drawn as a gap, never as the previous value. Overlays are drawn on bar times only.
 * After the last stored bar (today, until the bars arrive) candles are built from the exposure rows' spot (first/min/max/last
 * per bucket) and drawn muted, labelled "spot".
 *
 * Layer plugins. FlashAlphaChart.registerLayers(plugin) before mount() adds layers to every chart mounted afterwards:
 *   {
 *     layers: [['id', 'Menu label'], ...],
 *     defaults: ['id', ...],                 // turned on when options.layers is not given (optional)
 *     plans: { id: 'basic' | 'growth' | ... }, // the lowest plan per layer (optional; without one a layer is never locked)
 *     apiLayers(ctx) -> ['strikes', ...],    // the API layers to request for the enabled ids (optional)
 *     attach(ctx) -> handle,                 // once per chart, before the candle series exists: series added here
 *   }                                        //   are drawn behind the candles
 *   handle: { ready(), draw(response), clear(), legend(time, y) -> [lines], crosshair(time, y), destroy(),
 *             legendLevels(row, parts), keyLevels(last, prev, items), methods }, all optional.
 *   ready() runs once the candles exist; draw(response) after every load with the charts() response; clear() when a load
 *   failed. legendLevels(row, parts): parts of the legend's levels line for the exposure row under the crosshair
 *   (['flip …', 'call wall …', 'put wall …', 'max pain …' when on]), joined with ' · '; insert or append in place.
 *   keyLevels(last, prev, items): the key levels text for the latest exposure row and the previous session's last row;
 *   items are HTML strings [spot, call wall, put wall, gamma flip, max pain] ('' when absent); insert or append in place
 *   (escape API text with util.esc). methods: {name: function} added to the object mount() returns (core names win).
 *   Panes a plugin adds under the price pane each get a fifth of the chart's height (at least 60 px).
 *   ctx: LW, chart, root, options, colors, candles, bars, symbol, resolution, intraday(), on(id) (picked and in the plan),
 *   plan, lockedPlan(plan), upgradeHref(what), level(color, title),
 *   addControl(element), query, setQuery({...}) (merged into the charts() request, then reloads; called from attach()
 *   it only sets the first request), note(text), util.
 */
(function (global) {
  'use strict';

  const ET = 'America/New_York';
  const RESOLUTIONS = ['1m', '5m', '15m', '1h', '1d', '1w'];
  const INTRADAY = ['1m', '5m', '15m', '1h'];
  const RES_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400, '1w': 604800 };
  const RANGES = [['1D', 1], ['5D', 5], ['1M', 31], ['6M', 183], ['1Y', 366]];
  const DEFAULT_DAYS = { '1m': 1, '5m': 5, '15m': 5, '1h': 31, '1d': 183, '1w': 366 };
  /** The longest window per resolution: about 10,000 bars (the bars API limit). */
  const MAX_DAYS = { '1m': 5, '5m': 31, '15m': 62, '1h': 366, '1d': 3660, '1w': 3660 };
  const CORE_LAYERS = [['levels', 'Walls & gamma flip'], ['maxpain', 'Max pain']];
  const DEFAULT_LAYERS = ['levels'];
  /** Plans in order, and the lowest plan per layer. The API returns the key's plan (response.plan); a layer above it is locked. */
  const PLANS = ['free', 'basic', 'growth', 'alpha', 'enterprise'];
  const PLAN_NAMES = { free: 'Free', basic: 'Basic', growth: 'Growth', alpha: 'Alpha', enterprise: 'Enterprise' };
  const CORE_PLANS = { levels: 'basic', maxpain: 'basic' };
  const UPGRADE_URL = 'https://flashalpha.com/pricing';
  /** One line per plan for the Upgrade box: what the reader gets. */
  const PLAN_PITCH = {
    basic: 'See where dealers hedge: call wall, put wall, gamma flip, max pain.',
    growth: 'Strike heatmap, GEX profile, replay, 0DTE and hedging flow.',
    alpha: 'Levels from live open interest, updated through the session.',
    enterprise: 'Everything, for your team and your site.',
  };
  /** Shown under the chart (options.note): what the levels are. */
  const NOTE = 'GEX levels are model estimates from open interest, not observed dealer positions. Not financial advice.';
  /** API error codes in words for the page's readers (the code stays in the 'flashalpha:nodata' event). */
  const ERRORS = {
    api_key_required: 'Add your FlashAlpha key to show this chart.',
    invalid_api_key: 'This FlashAlpha key is not valid.',
    invalid_embed_key: 'This FlashAlpha key is not valid.',
    embed_key_expired: 'This FlashAlpha key has expired.',
    embed_key_revoked: 'This FlashAlpha key was revoked.',
    origin_not_allowed: 'This FlashAlpha key is not allowed on {host}.',
    too_many_requests: 'Too many requests. Retrying in a minute.',
    too_many_key_lookups: 'Too many requests. Retrying in a minute.',
    auth_unavailable: 'Chart data is unavailable right now. Retrying.',
    questdb_unavailable: 'Chart data is unavailable right now. Retrying.',
    network: 'Could not reach the chart server.',
    timeout: 'The chart server did not answer.',
  };
  const COLORS = { up: '#26a69a', down: '#ef5350', spotUp: '#5f8f8a', spotDown: '#9a6463', flip: '#e0c040', unverified: '#6b7080',
    maxpain: '#b388ff' };
  /** options.theme 'dark' (default), 'light' or 'auto' (follows prefers-color-scheme). */
  const THEMES = {
    dark: { bg: '#0f1115', text: '#d6d9e0', muted: '#8a909c', line: '#262a33', grid: '#1b1e25', shadow: 'rgba(0,0,0,0.4)' },
    light: { bg: '#ffffff', text: '#1f2430', muted: '#5b6270', line: '#d9dde4', grid: '#eef0f3', shadow: 'rgba(20,24,32,0.15)' },
  };
  /** Default key for every chart mounted later (FlashAlphaChart.setLicenseKey); options.apiKey wins. */
  let licenseKey = null;
  // lightweight-charts places day and month ticks on UTC boundaries, so every time handed to it is ET wall-clock
  // written as if it were UTC ("ET-as-UTC" seconds), and the formatters read it back in UTC.
  const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const fmtClock = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: 'numeric', hour12: false });
  const etParts = new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });
  /** UTC ISO timestamp → ET wall-clock seconds labelled as UTC. */
  function etTime(iso) {
    const p = Object.fromEntries(etParts.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
  }
  /** The ET date (yyyy-mm-dd) of a chart time. */
  const dayOf = t => new Date(t * 1000).toISOString().slice(0, 10);

  const CSS = `
.fac { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 240px;
  background: var(--fac-bg, #0f1115); color: var(--fac-text, #d6d9e0); font: 12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; }
.fac a.fac-lock { display: flex; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 4px; color: var(--fac-muted, #8a909c);
  text-decoration: none; white-space: nowrap; }
.fac a.fac-lock:hover { background: var(--fac-line, #262a33); color: var(--fac-text, #d6d9e0); }
.fac-lock .plan, .fac-upsell .plan { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--fac-accent, #4f8cff); color: #fff; }
.fac-more { display: none; flex-direction: column; gap: 6px; padding: 6px 6px 2px; margin-top: 4px; border-top: 1px solid var(--fac-line, #262a33); }
.fac-more:not(:empty) { display: flex; }
.fac-more select { max-width: none; }
.fac-upsell { position: absolute; right: 64px; top: 6px; z-index: 5; display: flex; gap: 8px; align-items: center; padding: 4px 6px 4px 10px;
  border: 1px solid var(--fac-line, #262a33); border-radius: 6px; background: var(--fac-bg, #0f1115); color: var(--fac-text, #d6d9e0);
  box-shadow: 0 2px 10px var(--fac-shadow, rgba(0,0,0,0.4)); }
.fac-upsell[hidden] { display: none; }
.fac-upsell a { padding: 3px 10px; border-radius: 4px; background: var(--fac-accent, #4f8cff); color: #fff; text-decoration: none; font-weight: 600; }
.fac-keys a { color: var(--fac-accent, #4f8cff); }
.fac-narrow .fac-upsell { left: 8px; right: auto; top: auto; bottom: 34px; }
.fac-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--fac-line, #262a33); }
.fac-group { display: flex; gap: 2px; border: 1px solid var(--fac-line, #262a33); border-radius: 6px; padding: 2px; }
.fac-group button, .fac-menu > button { background: none; border: 0; color: var(--fac-muted, #8a909c); padding: 3px 8px; border-radius: 4px; cursor: pointer; font: inherit; }
.fac-group button:hover, .fac-menu > button:hover { color: var(--fac-text, #d6d9e0); }
.fac-group select { border: 0; padding: 2px 2px; font-weight: 600; max-width: 110px; }
.fac select option { background: var(--fac-bg, #0f1115); color: var(--fac-text, #d6d9e0); }
.fac-group button.on { background: var(--fac-accent, #4f8cff); color: #fff; }
.fac select { background: transparent; color: inherit; border: 1px solid var(--fac-line, #262a33); border-radius: 6px; padding: 3px 4px; font: inherit;
  max-width: 170px; }
.fac-menu { position: relative; border: 1px solid var(--fac-line, #262a33); border-radius: 6px; }
.fac-menu > button { color: var(--fac-text, #d6d9e0); }
.fac-panel { display: none; position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; min-width: 190px; padding: 6px;
  background: var(--fac-bg, #0f1115); border: 1px solid var(--fac-line, #262a33); border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,0.4); }
.fac-menu.open .fac-panel { display: block; }
.fac-panel label { display: flex; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.fac-panel label:hover { background: var(--fac-line, #262a33); }
.fac-status { margin-left: auto; color: var(--fac-muted, #8a909c); }
.fac-body { position: relative; flex: 1; min-height: 0; }
.fac-canvas { position: absolute; inset: 0; }
.fac-legend { position: absolute; top: 6px; left: 10px; z-index: 3; pointer-events: none; font-variant-numeric: tabular-nums; }
.fac-legend b { font-size: 14px; margin-right: 6px; }
.fac-legend .k { color: var(--fac-muted, #8a909c); margin-left: 6px; }
.fac-legend .up { color: ${COLORS.up}; } .fac-legend .dn { color: ${COLORS.down}; }
.fac-legend .sub { color: var(--fac-muted, #8a909c); margin-top: 2px; }
.fac-empty { position: absolute; inset: 0; z-index: 4; display: none; align-items: center; justify-content: center; text-align: center;
  padding: 16px; color: var(--fac-muted, #8a909c); background: var(--fac-bg, #0f1115); }
.fac-keys { display: flex; flex-wrap: wrap; gap: 2px 14px; padding: 5px 10px; border-top: 1px solid var(--fac-line, #262a33);
  font-variant-numeric: tabular-nums; }
.fac-keys:empty { display: none; }
.fac-keys .k, .fac-keys .ch { color: var(--fac-muted, #8a909c); }
.fac-keys .up { color: ${COLORS.up}; } .fac-keys .dn { color: ${COLORS.down}; }
.fac-narrow .fac-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px; }
.fac-narrow .fac-keys > span:last-child { grid-column: 1 / -1; }
.fac-narrow .fac-status { display: none; }
.fac-narrow .fac-group button, .fac-narrow .fac-menu > button { min-height: 32px; min-width: 32px; padding: 3px 7px; }
.fac-credit { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 10px 4px; font-size: 10px; }
.fac-credit a { color: var(--fac-muted, #8a909c); text-decoration: none; }
.fac-credit a:hover { text-decoration: underline; }
.fac-credit .fac-brand { display: flex; align-items: center; gap: 5px; color: var(--fac-text, #d6d9e0); font: 600 12px/1 system-ui, sans-serif;
  opacity: 0.8; }
.fac-credit .fac-brand:hover { opacity: 1; text-decoration: none; }
.fac-brand img { height: 16px; width: auto; }
.fac-note { flex: 1; min-width: 0; text-align: center; color: var(--fac-muted, #8a909c); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fac-upsell .pitch { color: var(--fac-muted, #8a909c); max-width: 260px; }
.fac-narrow .fac-upsell .pitch { display: none; }`;

  function injectCss() {
    if (document.getElementById('fac-css')) return;
    const style = document.createElement('style');
    style.id = 'fac-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /** The chart API: /v1/bars, /v1/charts, /v1/symbols under baseUrl ('' = same origin), with the key as X-Api-Key. */
  function chartEngineSource(baseUrl, apiKey) {
    const root = (baseUrl || '').replace(/\/$/, '');
    const headers = apiKey ? { 'X-Api-Key': apiKey } : undefined;
    // Every failure becomes {error}: a network error, a CORS refusal or a proxy's HTML page must not leave the chart loading.
    // A request that does not answer in 20 s is dropped, so it cannot stop the refreshes after it.
    const get = async url => {
      const abort = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = abort ? setTimeout(() => abort.abort(), 20000) : null;
      try {
        const r = await fetch(root + url, { headers, signal: abort ? abort.signal : undefined });
        return await r.json().catch(() => ({ error: `http_${r.status}` }));
      } catch (e) { return { error: e && e.name === 'AbortError' ? 'timeout' : 'network', message: String(e) }; }
      finally { if (timer) clearTimeout(timer); }
    };
    return {
      symbols: () => get('/v1/symbols'),
      bars: (s, res, from, to, session) =>
        get(`/v1/bars/${encodeURIComponent(s)}?resolution=${res}&from=${from}&to=${to}&limit=10000&session=${session || 'rth'}`),
      charts: (s, res, from, to, q) => {
        const { layers, session, ...extra } = q;
        const p = new URLSearchParams({ resolution: res, layers: layers.join(','), session: session || 'rth', from, to });
        for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, v);
        return get(`/v1/charts/${encodeURIComponent(s)}?${p}`);
      },
    };
  }

  /** Escapes text for innerHTML: symbols, statuses and details come from the host page or the API. */
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 2) => v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const big = v => v == null ? '—'
    : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
    : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v));

  function sessionOf(t) {
    const [h, m] = fmtClock.format(new Date(t * 1000)).split(':').map(Number);
    const mins = h * 60 + m;
    return mins < 570 ? 'pre' : mins >= 960 ? 'post' : 'rth';
  }

  /** Index of the last element of sorted `times` that is <= t, or -1. For layer plugins (ctx.util). */
  function floorIndex(times, t) {
    let lo = 0, hi = times.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return at;
  }

  const plugins = [];
  /** Adds layers to charts mounted after this call. See the header for the plugin shape. */
  function registerLayers(plugin) {
    if (!plugin || !Array.isArray(plugin.layers) || typeof plugin.attach !== 'function')
      throw new Error('registerLayers expects { layers: [[id, label]], attach(ctx) }');
    plugins.push(plugin);
  }

  /** Index of a plan name in PLANS; an unknown name counts as the lowest. */
  const planRank = p => Math.max(0, PLANS.indexOf(String(p || '').toLowerCase()));
  /** The key every chart mounted after this call uses when options.apiKey is not given. An embed key (fa_pk_…) belongs on a page. */
  function setLicenseKey(key) { licenseKey = key || null; }
  /** A secret API key in a public page can be copied and used anywhere: warn the developer, once per page. */
  let warned = false;
  function warnSecretKey(key) {
    if (warned || !key || /^fa_pk_/.test(key) || !global.location || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(global.location.hostname)) return;
    warned = true;
    if (global.console) console.warn('[flashalpha-chart] this page uses a secret FlashAlpha API key; use an embed key (fa_pk_…) locked to your domain');
  }

  function mount(container, options) {
    const LW = (options && options.lightweightCharts) || global.LightweightCharts;
    if (!LW) throw new Error('FlashAlphaChart needs lightweight-charts 5 (global LightweightCharts or options.lightweightCharts)');
    injectCss();
    const pluginDefaults = plugins.flatMap(p => p.defaults || []);
    const o = Object.assign({
      symbol: null, resolution: '5m', days: null, session: 'rth', layers: [...DEFAULT_LAYERS, ...pluginDefaults],
      controls: true, symbolButtons: true, exposure: true, source: null, baseUrl: '', apiKey: null, refresh: 60, background: null,
      keyLevels: true, brand: null, theme: 'dark', upgradeUrl: UPGRADE_URL, debug: false, note: NOTE,
    }, options || {});
    if (!o.apiKey) o.apiKey = licenseKey;
    if (!o.source) warnSecretKey(o.apiKey);
    const source = o.source || chartEngineSource(o.baseUrl, o.apiKey);
    const layerList = [...CORE_LAYERS, ...plugins.flatMap(p => p.layers)];
    const layerPlan = Object.assign({}, CORE_PLANS, ...plugins.map(p => p.plans || {}));
    const state = { symbol: o.symbol, res: o.resolution, days: o.days || DEFAULT_DAYS[o.resolution] || 5, symbols: [], loading: 0,
      layers: new Set(o.exposure ? o.layers : []), noData: null, plan: null };
    const query = {};                       // extra charts() parameters, set by plugins
    const intraday = () => INTRADAY.includes(state.res);
    /** True when the key's plan (known after the first charts() answer) is below `plan`. No plan from the API: nothing is locked. */
    const lockedPlan = plan => state.plan != null && planRank(state.plan) < planRank(plan);
    const locked = layer => lockedPlan(layerPlan[layer] || 'free');
    /** A layer is drawn (and requested) when it is picked and the plan includes it. */
    const on = layer => state.layers.has(layer) && !locked(layer);
    /** The upgrade link, tagged so flashalpha.com can count where buyers came from. */
    const upgradeHref = what => {
      const u = new URL(o.upgradeUrl, global.location ? global.location.href : undefined);
      u.searchParams.set('utm_source', 'chart'); u.searchParams.set('utm_medium', 'embed'); u.searchParams.set('utm_campaign', 'upgrade');
      if (what) u.searchParams.set('utm_content', what);
      if (global.location && global.location.hostname) u.searchParams.set('utm_term', global.location.hostname);
      return u.toString();
    };

    const root = document.createElement('div');
    root.className = 'fac';
    root.innerHTML = `${o.controls ? `<div class="fac-bar">
        ${o.symbolButtons ? '<div class="fac-group" data-g="symbols"></div>' : ''}
        <div class="fac-group" data-g="res"></div><div class="fac-group" data-g="range"></div><div class="fac-group" data-g="session"></div>
        ${o.exposure ? '<div class="fac-menu"><button type="button">Layers ▾</button><div class="fac-panel"><div class="fac-layers"></div><div class="fac-more"></div></div></div>' : ''}
        <span class="fac-status"></span></div>` : ''}
      <div class="fac-body"><div class="fac-canvas"></div><div class="fac-legend"></div><div class="fac-empty"></div>
        <div class="fac-upsell" hidden></div></div>
      ${o.keyLevels && o.exposure ? '<div class="fac-keys"></div>' : ''}
      ${o.brand ? `<div class="fac-credit"><a class="fac-brand" href="${esc(o.brand.href)}" target="_blank" rel="noopener" title="${esc(o.brand.name)}"><img src="${esc(o.brand.logo)}" alt="">${o.brand.name ? `<span>${esc(o.brand.name)}</span>` : ''}</a>${o.note && o.exposure ? `<span class="fac-note" title="${esc(o.note)}">${esc(o.note)}</span>` : ''}<a href="https://www.tradingview.com/" target="_blank" rel="noopener">Charts by TradingView</a></div>` : ''}`;
    container.appendChild(root);
    const $ = sel => root.querySelector(sel);
    const status = text => { const s = $('.fac-status'); if (s) s.textContent = o.debug ? text : ''; };
    const extraControls = [];                  // [element, placeholder] for controls that move on narrow widths
    /** Keeps `el` (already in the toolbar) where it is on wide charts; on narrow ones it goes into the Layers panel. */
    const movable = el => { const mark = document.createComment('fac'); el.after(mark); extraControls.push([el, mark]); };
    if ($('.fac-menu') && $('[data-g="session"]')) movable($('[data-g="session"]'));

    const chart = LW.createChart($('.fac-canvas'), {
      autoSize: true,
      layout: { background: { color: 'transparent' }, attributionLogo: !o.brand },
      crosshair: { mode: LW.CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (t, type) => (type <= 2 ? fmtDay : fmtClock).format(new Date(t * 1000)) },
      localization: { timeFormatter: t => intraday() ? fmtTime.format(new Date(t * 1000)) + ' ET' : fmtDay.format(new Date(t * 1000)) },
    });
    // Theme: CSS variables on the root and the same colours in lightweight-charts. 'auto' follows the reader's system setting.
    const dark = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
    function applyTheme() {
      const t = THEMES[o.theme === 'auto' ? (dark && !dark.matches ? 'light' : 'dark') : o.theme] || THEMES.dark;
      for (const [k, v] of Object.entries(t)) root.style.setProperty('--fac-' + k, v);
      if (o.background) root.style.setProperty('--fac-bg', o.background);
      chart.applyOptions({ layout: { textColor: t.muted, panes: { separatorColor: t.line } },
        grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
        rightPriceScale: { borderColor: t.line }, timeScale: { borderColor: t.line } });
    }
    applyTheme();
    const onScheme = () => { if (o.theme === 'auto') applyTheme(); };
    if (dark && dark.addEventListener) dark.addEventListener('change', onScheme);
    // A level is a step line through the day (where the wall or the flip stood at each bar; a gap where it is unknown) and a
    // dotted line at its latest value across the chart. On a phone the axis label keeps the colour and drops the title.
    const levels = [];
    const level = (color, title) => {
      const x = chart.addSeries(LW.LineSeries, { color, title, lineWidth: 1, lineType: LW.LineType.WithSteps,
        priceLineVisible: true, priceLineStyle: LW.LineStyle.Dotted, priceLineWidth: 1, priceLineColor: color,
        lastValueVisible: true, crosshairMarkerVisible: false });
      levels.push([x, title]);
      return x;
    };

    let candles = null, bars = [], byTime = new Map(), gexByTime = new Map(), notes = [], started = false;
    const ctx = {
      LW, chart, root, options: o, colors: COLORS, level, intraday, on, lockedPlan, upgradeHref,
      get plan() { return state.plan; },
      get candles() { return candles; },
      get bars() { return bars; },
      get symbol() { return state.symbol; },
      get resolution() { return state.res; },
      get query() { return Object.assign({}, query); },
      setQuery(x) { Object.assign(query, x); return started ? load() : Promise.resolve(); },
      /** Puts a control into the toolbar before the status text; false when the toolbar is hidden. */
      addControl(el) { const st = $('.fac-status'); if (!st) return false; st.before(el); if ($('.fac-menu')) movable(el); return true; },
      note(text) { notes.push(text); },
      util: { etTime, dayOf, sessionOf, floorIndex, esc, num, big, RES_SECONDS },
    };
    // Plugins attach before the candles exist, so the series they add are drawn behind them.
    const handles = plugins.map(p => ({ plugin: p, h: p.attach(ctx) || {} }));
    const call = (name, ...args) => {
      const out = [];
      for (const { h } of handles) {
        if (typeof h[name] !== 'function') continue;
        try { out.push(h[name](...args)); } catch (e) { if (global.console) console.error('[flashalpha-chart] layer plugin', e); }
      }
      return out;
    };

    candles = chart.addSeries(LW.CandlestickSeries,
      { upColor: COLORS.up, downColor: COLORS.down, borderVisible: false, wickUpColor: COLORS.up, wickDownColor: COLORS.down });
    const volume = chart.addSeries(LW.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    chart.priceScale('vol').applyOptions({ visible: false, scaleMargins: { top: 0.82, bottom: 0 } });
    const s = {
      flip: level(COLORS.flip, 'flip'), callWall: level(COLORS.up, 'call wall'), putWall: level(COLORS.down, 'put wall'),
      maxPain: level(COLORS.maxpain, 'max pain'),
    };
    call('ready');
    // Plugin panes under the price take a fifth of the chart each; re-applied on every resize because the container may
    // still be 0 px tall when a pane is added.
    const sizePanes = () => {
      const panes = chart.panes(), h = $('.fac-body').clientHeight;
      if (h > 0) for (let i = 1; i < panes.length; i++) panes[i].setHeight(Math.max(60, Math.round(h * 0.2)));
    };
    // Phones: resolutions, ranges and Layers in the toolbar; the session and the plugins' controls move into the Layers panel
    // ("more"); a one-line legend; level labels on the price axis without their titles.
    const placeControls = narrow => {
      const more = $('.fac-more');
      if (!more) return;
      for (const [el, mark] of extraControls) if (narrow) more.appendChild(el); else mark.before(el);
    };
    const resizeObserver = new ResizeObserver(() => {
      const narrow = root.clientWidth < 560;
      if (narrow !== root.classList.contains('fac-narrow')) {
        root.classList.toggle('fac-narrow', narrow);
        placeControls(narrow);
        renderLegend(null, null);
      }
      const tiny = root.clientWidth < 480;
      if (tiny !== state.tiny) { state.tiny = tiny; for (const [x, title] of levels) x.applyOptions({ title: tiny ? '' : title }); }
      sizePanes();
    });
    resizeObserver.observe(root);

    const legend = $('.fac-legend'), keys = $('.fac-keys');
    function renderLegend(t, y) {
      const b = t != null ? byTime.get(t) : [...byTime.values()].at(-1);
      const time = b ? b.time : null;
      const g = time != null ? gexByTime.get(time) : null;
      const head = `<b>${esc(state.symbol)}</b>`;
      if (t == null && root.classList.contains('fac-narrow')) {         // the rest shows on tap (crosshair)
        legend.innerHTML = head + (b ? `<span class="${b.close >= b.open ? 'up' : 'dn'}">${num(b.close)}</span>` : '');
        return;
      }
      const price = b ? `<span class="${b.close >= b.open ? 'up' : 'dn'}">${num(b.close)}</span>`
        + `<span class="k">O</span> ${num(b.open)}<span class="k">H</span> ${num(b.high)}<span class="k">L</span> ${num(b.low)}`
        + (b.volume != null ? `<span class="k">Vol</span> ${big(b.volume)}` : '')
        + (b.source === 'spot' ? '<span class="k">index spot</span>' : intraday() && sessionOf(b.time) !== 'rth' ? `<span class="k">${sessionOf(b.time)}-market</span>` : '') : '';
      const lines = [];
      if (g) {
        const flipOk = g.gamma_flip && g.gamma_flip.status === 'available';
        const parts = [`flip ${num(g.gamma_flip && g.gamma_flip.last)}${flipOk || !g.gamma_flip || g.gamma_flip.last == null ? '' : ' (unverified)'}`,
          `call wall ${num(g.call_wall)}`, `put wall ${num(g.put_wall)}`];
        if (on('maxpain') && g.max_pain != null) parts.push(`max pain ${num(g.max_pain)}`);
        call('legendLevels', g, parts);
        lines.push(parts.filter(Boolean).join(' · '));
      }
      const extra = time != null ? call('legend', time, y).flat().filter(Boolean) : [];
      lines.push(...extra);
      if (!g && notes.length) lines.push(notes.join(' · '));
      legend.innerHTML = head + price + lines.filter(Boolean).map(l => `<div class="sub">${esc(l)}</div>`).join('');
    }
    chart.subscribeCrosshairMove(p => {
      const t = p.time != null ? p.time : null, y = p.point ? p.point.y : null;
      renderLegend(t, y);
      call('crosshair', t, y);
    });

    function buttons(group, items, isOn, onClick) {
      const box = root.querySelector(`[data-g="${group}"]`);
      if (!box) return;
      box.innerHTML = '';
      for (const [label, value] of items) {
        const b = document.createElement('button');
        b.textContent = label;
        b.classList.toggle('on', isOn(value));
        b.onclick = () => onClick(value);
        box.appendChild(b);
      }
    }
    function renderControls() {
      // A few symbols are buttons; a longer list is one select, so the toolbar never becomes a strip of tickers.
      const symBox = root.querySelector('[data-g="symbols"]');
      if (symBox && state.symbols.length > 8) {
        const names = state.symbols.map(x => x.symbol).sort();
        symBox.innerHTML = `<select title="Symbol">${names.map(n => `<option value="${esc(n)}"${n === state.symbol ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
        symBox.querySelector('select').onchange = e => api.setSymbol(e.target.value);
      } else buttons('symbols', state.symbols.map(x => [x.symbol, x.symbol]), v => v === state.symbol, v => api.setSymbol(v));
      buttons('res', RESOLUTIONS.map(r => [r, r]), v => v === state.res, v => api.setResolution(v));
      buttons('range', RANGES.filter(([, d]) => d <= (MAX_DAYS[state.res] || d)), v => v === state.days, v => api.setRange(v));
      buttons('session', [['RTH', 'rth'], ['ETH', 'eth']], v => v === o.session, v => api.setSession(v));
      const panel = $('.fac-layers');
      if (panel) {
        // A layer above the key's plan is a link to the upgrade page, with the plan it needs.
        panel.innerHTML = layerList.map(([k, label]) => locked(k)
          ? `<a class="fac-lock" href="${esc(upgradeHref(k))}" target="_blank" rel="noopener">🔒 ${esc(label)} <span class="plan">${esc(PLAN_NAMES[layerPlan[k]] || layerPlan[k])}</span></a>`
          : `<label><input type="checkbox" value="${esc(k)}" ${on(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('');
        panel.querySelectorAll('input').forEach(i => { i.onchange = () => api.setLayers(
          [...panel.querySelectorAll('input:checked')].map(x => x.value)); });
      }
    }

    /** "Upgrade" over the chart while a layer that is on needs a higher plan than the key's: names them and the lowest plan. */
    function renderUpsell() {
      const box = $('.fac-upsell');
      const wanted = [...state.layers].filter(locked);
      if (!wanted.length) { box.hidden = true; return; }
      const need = wanted.map(k => layerPlan[k]).sort((a, b) => planRank(a) - planRank(b))[0];
      const names = layerList.filter(([k]) => wanted.includes(k) && layerPlan[k] === need).map(([, l]) => l);
      box.innerHTML = `<span>🔒 ${esc(names.slice(0, 2).join(', '))}${names.length > 2 ? ` +${names.length - 2}` : ''}</span>`
        + (PLAN_PITCH[need] ? `<span class="pitch">${esc(PLAN_PITCH[need])}</span>` : '')
        + `<span class="plan">${esc(PLAN_NAMES[need] || need)}</span><a href="${esc(upgradeHref(wanted[0]))}" target="_blank" rel="noopener">Upgrade</a>`;
      box.hidden = false;
    }
    let destroyed = false;
    const closeMenu = () => menu && menu.classList.remove('open');
    const menu = $('.fac-menu');
    if (menu) {
      menu.querySelector('button').onclick = e => {
        e.stopPropagation();
        const panel = menu.querySelector('.fac-panel');
        menu.classList.toggle('open');
        // Open towards the side with room: right-aligned when a left-aligned panel would leave the widget.
        panel.style.left = ''; panel.style.right = '';
        if (panel.getBoundingClientRect().right > root.getBoundingClientRect().right) { panel.style.left = 'auto'; panel.style.right = '0'; }
      };
      menu.querySelector('.fac-panel').onclick = e => e.stopPropagation();
      document.addEventListener('click', closeMenu);
    }

    function window_() {
      // The window ends now, or at the newest bar when that is later (clock skew); a symbol without today's bars still
      // shows its last sessions and today's exposure rows.
      const meta = state.symbols.find(x => x.symbol === state.symbol);
      const last = meta && meta.last_bar ? Date.parse(meta.last_bar) + 60e3 : 0;
      // Rounded up to the minute: readers of the same page then ask the same window, which the API answers from its cache.
      const to = new Date(Math.ceil(Math.max(Date.now(), last) / 60e3) * 60e3);
      return { from: new Date(to.getTime() - Math.min(state.days, MAX_DAYS[state.res] || state.days) * 86400e3), to };
    }

    /** The API layers the enabled chart layers need: the core's, then each plugin's. */
    function apiLayers() {
      const l = new Set();
      if (['levels', 'maxpain'].some(on) && intraday()) l.add('exposure');
      for (const { plugin } of handles) {
        if (typeof plugin.apiLayers !== 'function') continue;
        try { for (const x of plugin.apiLayers(ctx) || []) l.add(x); } catch (e) { if (global.console) console.error('[flashalpha-chart] layer plugin', e); }
      }
      return [...l];
    }

    let pending = 0;
    /**
     * Loads the window. A refresh ({keepView: true}) keeps what the user looks at: a view that ends at the latest bar follows
     * the new bars with the same zoom, any other view stays on the same times; a failed refresh keeps the drawn data.
     */
    async function load({ keepView = false } = {}) {
      if (!state.symbol) return;
      pending++;
      try { await loadOnce(keepView); } finally { pending--; }
    }

    /** A message over the chart when there is nothing to draw; the host page hears 'flashalpha:nodata' (e.g. to hide the section). */
    function empty(error) {
      const box = $('.fac-empty');
      state.noData = error;                                         // an unknown symbol is not polled again
      if (!error) { box.style.display = 'none'; return; }
      const host = global.location ? global.location.hostname : 'this site';
      box.textContent = error === 'unknown_symbol' || error === 'no bars' ? `No chart data for ${state.symbol} yet.`
        : (ERRORS[error] || 'Chart data is unavailable right now.').replace('{host}', host);
      box.style.display = 'flex';
      container.dispatchEvent(new CustomEvent('flashalpha:nodata', { bubbles: true, detail: { symbol: state.symbol, error } }));
    }

    async function loadOnce(keepView) {
      const ticket = ++state.loading;
      const { from, to } = window_();
      const t0 = performance.now();
      if (!keepView) status('loading…');
      const layers = apiLayers();
      // The spot candles need exposure rows even when no exposure layer is on.
      const q = intraday() && !layers.includes('exposure') ? [...layers, 'exposure'] : layers;
      // Key levels on daily resolutions come from a small hourly read of the last sessions (exposure is intraday only).
      const keysFrom = new Date(to.getTime() - 5 * 86400e3).toISOString();
      const [r, c, k] = await Promise.all([
        source.bars(state.symbol, state.res, from.toISOString(), to.toISOString(), o.session),
        q.length ? Promise.resolve(source.charts(state.symbol, state.res, from.toISOString(), to.toISOString(),
          Object.assign({}, query, { session: o.session, layers: q }))).catch(e => ({ error: String(e) })) : {},
        keys && !intraday() ? Promise.resolve(source.charts(state.symbol, '1h', keysFrom, to.toISOString(),
          Object.assign({}, query, { session: 'rth', layers: ['exposure'] }))).catch(() => ({})) : null,
      ]);
      if (ticket !== state.loading || destroyed) return;      // a newer load (or destroy) superseded this one
      if (keepView && (r.error || !Array.isArray(r.bars))) { status(`refresh failed: ${r.error || 'no bars'}`); return; }   // keep what is drawn
      const view = keepView ? currentView() : null;
      if (r.error || !Array.isArray(r.bars)) {
        status(`${r.error || 'no bars'}${r.message ? ': ' + r.message : ''}`);
        empty(r.error || 'no bars');
        bars = []; byTime = new Map(); gexByTime = new Map();
        for (const x of [candles, volume, ...Object.values(s)]) x.setData([]);
        call('clear');
        renderLegend(null, null);
        renderKeyLevels([]);
        return;
      }
      // Daily ts is already the ET date at 00:00 UTC; intraday ts is shifted to ET-as-UTC.
      bars = r.bars.filter(b => b.open != null).map(b => Object.assign({}, b, { time: intraday() ? etTime(b.ts) : Date.parse(b.ts) / 1000 }));
      bars = bars.concat(spotBars(c.exposure || []));
      empty(bars.length ? null : 'no bars');
      byTime = new Map(bars.map(b => [b.time, b]));
      candles.setData(bars.map(b => b.source === 'spot'
        ? { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
            color: b.close >= b.open ? COLORS.spotUp : COLORS.spotDown, wickColor: b.close >= b.open ? COLORS.spotUp : COLORS.spotDown }
        : { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
      volume.setData(bars.map(b => b.volume == null ? { time: b.time } : { time: b.time, value: b.volume,
        color: b.close >= b.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)' }));
      notes = [];
      if (c.error && o.debug) notes.push(`layers: ${c.error}`);
      // The key's plan: layers above it are locked in the menu and named in the Upgrade box. A layer the plan does not include
      // also comes back as status "gated" with no data (an API without a plan field).
      if (c && 'plan' in c && c.plan !== state.plan) { state.plan = c.plan; renderControls(); }
      const gated = layers.filter(k => c.layers && c.layers[k] && c.layers[k].status === 'gated');
      renderUpsell();
      drawExposure(layers.includes('exposure') ? c.exposure || [] : []);
      const keysGated = gated.includes('exposure') || (k && k.layers && k.layers.exposure && k.layers.exposure.status === 'gated');
      renderKeyLevels(keysGated ? null : intraday() ? c.exposure || [] : (k && k.exposure) || []);
      call('draw', c);
      requestAnimationFrame(sizePanes);                     // a pane added in this load is laid out on the next frame
      if (!intraday() && state.picked && ['levels', 'maxpain'].some(on)) notes.push('GEX levels: pick 1m to 1h');
      else if (layers.includes('exposure') && !gated.includes('exposure') && !(c.exposure || []).length) notes.push('GEX levels: none yet in this window (they start at the 9:30 ET open)');
      restoreView(view);
      status(`${bars.length} bars · ${Math.round(performance.now() - t0)} ms`);
      renderLegend(null, null);
    }

    /** The visible range as distances from the last bar and as times, before a refresh replaces the data. */
    function currentView() {
      const ts = chart.timeScale(), lr = ts.getVisibleLogicalRange(), last = bars.length - 1;
      return lr && last >= 0 ? { fromEnd: last - lr.from, toEnd: last - lr.to, range: ts.getVisibleRange() } : null;
    }
    function restoreView(view) {
      const ts = chart.timeScale(), last = bars.length - 1;
      if (!view || last < 0) ts.fitContent();
      else if (view.toEnd <= 0.5) ts.setVisibleLogicalRange({ from: last - view.fromEnd, to: last - view.toEnd });   // follow the latest bar
      else if (view.range) ts.setVisibleRange(view.range);
      else ts.fitContent();
    }

    /** Candles from the exposure rows' spot for the buckets after the last stored bar (RTH only: spot is sampled in RTH). */
    function spotBars(rows) {
      if (!intraday()) return [];
      const last = bars.length ? bars[bars.length - 1].time : -Infinity;
      return rows.filter(e => e.spot && e.spot.first != null && e.spot.last != null).map(e => ({
        time: etTime(e.ts), open: e.spot.first, high: e.spot.max, low: e.spot.min, close: e.spot.last, volume: null, source: 'spot',
      })).filter(b => b.time > last);
    }

    function drawExposure(rows) {
      // Only on bar times: a point without a candle would widen the time scale with empty space.
      const data = rows.map(e => Object.assign({}, e, { time: etTime(e.ts) })).filter(e => byTime.has(e.time));
      gexByTime = new Map(data.map(e => [e.time, e]));
      const pts = (show, pick, color) => !show ? [] : data.map(e => {
        const v = pick(e);
        return v == null ? { time: e.time } : color ? { time: e.time, value: v, color: color(e) } : { time: e.time, value: v };
      });
      const flip = e => e.gamma_flip || {};
      s.flip.setData(pts(on('levels'), e => flip(e).last, e => flip(e).status === 'available' ? COLORS.flip : COLORS.unverified));
      s.callWall.setData(pts(on('levels'), e => e.call_wall));
      s.putWall.setData(pts(on('levels'), e => e.put_wall));
      s.maxPain.setData(pts(on('maxpain'), e => e.max_pain));
    }

    /**
     * Key levels as text under the chart: the latest exposure row, with the change against the last row of the previous
     * session in the rows. Text, not canvas, so people and search engines can read it on the host page.
     */
    function renderKeyLevels(rows) {
      if (!keys) return;
      if (rows === null) {                     // the plan has no exposure: say what is there and where to get it
        keys.innerHTML = `<span><span class="k">Key levels</span> 🔒 call wall, put wall, gamma flip: ${esc(PLAN_NAMES[layerPlan.levels] || 'Basic')} plan`
          + ` · <a href="${esc(upgradeHref('key_levels'))}" target="_blank" rel="noopener">Upgrade</a></span>`;
        return;
      }
      const last = rows.length ? rows[rows.length - 1] : null;
      if (!last) { keys.innerHTML = ''; return; }
      const day = dayOf(etTime(last.ts));
      let prev = null;
      for (let i = rows.length - 1; i >= 0; i--) if (dayOf(etTime(rows[i].ts)) < day) { prev = rows[i]; break; }
      const ch = (v, p) => v == null || p == null || v === p ? '' : ` <span class="ch">(${v > p ? '+' : '−'}${num(Math.abs(v - p))})</span>`;
      const item = (label, v, p, cls = '') => v == null ? ''
        : `<span><span class="k">${label}</span> <span class="${cls}">${num(v)}</span>${ch(v, p)}</span>`;
      const flip = last.gamma_flip || {}, pflip = (prev && prev.gamma_flip) || {};
      const items = [
        item('Spot', last.spot && last.spot.last, prev && prev.spot && prev.spot.last),
        item('Call wall', last.call_wall, prev && prev.call_wall, 'up'),
        item('Put wall', last.put_wall, prev && prev.put_wall, 'dn'),
        item(flip.status === 'available' || flip.last == null ? 'Gamma flip' : 'Gamma flip (unverified)', flip.last, pflip.last),
        on('maxpain') ? item('Max pain', last.max_pain, prev && prev.max_pain) : '',
      ];
      call('keyLevels', last, prev, items);
      items.push(`<span class="k">${esc(fmtTime.format(new Date(etTime(last.ts) * 1000)))} ET${prev ? ' · change vs previous session' : ''}</span>`);
      keys.innerHTML = items.filter(Boolean).join('');
    }

    const api = {
      setSymbol(x) { state.symbol = x; renderControls(); return load(); },
      setResolution(r) { state.res = r; state.days = DEFAULT_DAYS[r] || state.days; renderControls(); return load(); },
      /** Days back from now; capped per resolution (MAX_DAYS). */
      setRange(days) { state.days = days; renderControls(); return load(); },
      /** 'rth' (regular hours, the default) or 'eth' (with pre- and post-market). */
      setSession(x) { o.session = x; renderControls(); return load(); },
      /** Any of 'levels', 'maxpain', plus the ids of registered layer plugins. */
      setLayers(list) { state.layers = new Set(list); state.picked = true; renderControls(); renderUpsell(); return load(); },
      /** 'dark', 'light' or 'auto'. */
      setTheme(t) { o.theme = t; applyTheme(); },
      /** The key's plan from the last answer ('free', 'basic', ...), or null before it / without auth. */
      get plan() { return state.plan; },
      get layers() { return [...state.layers]; },
      reload: () => load(),
      destroy() {
        destroyed = true; state.loading++;
        clearInterval(timer);
        document.removeEventListener('click', closeMenu);
        if (dark && dark.removeEventListener) dark.removeEventListener('change', onScheme);
        call('destroy');
        resizeObserver.disconnect(); chart.remove(); root.remove();
      },
      get chart() { return chart; },
    };
    for (const { h } of handles)
      for (const [name, fn] of Object.entries(h.methods || {})) if (!(name in api) && typeof fn === 'function') api[name] = fn;

    // Auto-refresh: every `refresh` seconds while the page is visible (0 = off).
    // Skipped while a load is running, so a refresh never replaces a load the user started.
    // A chart whose element left the page (a single-page app moved on) stops itself instead of polling with the key.
    const timer = o.refresh > 0 ? setInterval(() => {
      if (!root.isConnected) { api.destroy(); return; }
      if (!document.hidden && !pending && state.noData !== 'unknown_symbol') load({ keepView: true });
    }, o.refresh * 1000) : null;

    (async () => {
      try { state.symbols = await source.symbols(); } catch (e) { state.symbols = []; }
      if (destroyed) return;
      if (!Array.isArray(state.symbols)) state.symbols = [];
      if (!state.symbol) state.symbol = (state.symbols.find(x => x.last_bar) || state.symbols[0] || {}).symbol;
      if (state.symbol && !state.symbols.some(x => x.symbol === state.symbol)) state.symbols.push({ symbol: state.symbol });
      renderControls();
      started = true;
      await load();
    })();
    return api;
  }

  global.FlashAlphaChart = {
    mount, chartEngineSource, registerLayers, setLicenseKey, plans: PLANS,
    get layers() { return [...CORE_LAYERS, ...plugins.flatMap(p => p.layers)].map(l => l[0]); },
    version: '0.3.0',
  };
})(typeof window !== 'undefined' ? window : globalThis);
