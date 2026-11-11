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
 *     apiLayers(ctx) -> ['strikes', ...],    // the API layers to request for the enabled ids (optional)
 *     attach(ctx) -> handle,                 // once per chart, before the candle series exists: series added here
 *   }                                        //   are drawn behind the candles
 *   handle: { ready(), draw(response), clear(), legend(time, y) -> [lines], crosshair(time, y), destroy() }, all optional.
 *   ready() runs once the candles exist; draw(response) after every load with the charts() response; clear() when a load
 *   failed. ctx: LW, chart, root, options, colors, candles, bars, symbol, resolution, intraday(), on(id), level(color, title),
 *   addControl(element), query, setQuery({...}) (merged into the charts() request, then reloads), note(text), util.
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
  const COLORS = { up: '#26a69a', down: '#ef5350', spotUp: '#5f8f8a', spotDown: '#9a6463', flip: '#e0c040', unverified: '#6b7080',
    maxpain: '#b388ff' };
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
.fac-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--fac-line, #262a33); }
.fac-group { display: flex; gap: 2px; border: 1px solid var(--fac-line, #262a33); border-radius: 6px; padding: 2px; }
.fac-group button, .fac-menu > button { background: none; border: 0; color: var(--fac-muted, #8a909c); padding: 3px 8px; border-radius: 4px; cursor: pointer; font: inherit; }
.fac-group button:hover, .fac-menu > button:hover { color: var(--fac-text, #d6d9e0); }
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
.fac-narrow .fac-keys { flex-wrap: nowrap; overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
.fac-narrow .fac-keys > span { flex: none; }
.fac-narrow [data-g="session"], .fac-narrow .fac-status { display: none; }`;

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
    const init = apiKey ? { headers: { 'X-Api-Key': apiKey } } : undefined;
    // Every failure becomes {error}: a network error, a CORS refusal or a proxy's HTML page must not leave the chart loading.
    const get = async url => {
      try {
        const r = await fetch(root + url, init);
        return await r.json().catch(() => ({ error: `http_${r.status}` }));
      } catch (e) { return { error: 'network', message: String(e) }; }
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

  function mount(container, options) {
    const LW = (options && options.lightweightCharts) || global.LightweightCharts;
    if (!LW) throw new Error('FlashAlphaChart needs lightweight-charts 5 (global LightweightCharts or options.lightweightCharts)');
    injectCss();
    const pluginDefaults = plugins.flatMap(p => p.defaults || []);
    const o = Object.assign({
      symbol: null, resolution: '5m', days: null, session: 'rth', layers: [...DEFAULT_LAYERS, ...pluginDefaults],
      controls: true, symbolButtons: true, exposure: true, source: null, baseUrl: '', apiKey: null, refresh: 60, background: null,
      keyLevels: true,
    }, options || {});
    const source = o.source || chartEngineSource(o.baseUrl, o.apiKey);
    const layerList = [...CORE_LAYERS, ...plugins.flatMap(p => p.layers)];
    const state = { symbol: o.symbol, res: o.resolution, days: o.days || DEFAULT_DAYS[o.resolution] || 5, symbols: [], loading: 0,
      layers: new Set(o.exposure ? o.layers : []), noData: null };
    const query = {};                       // extra charts() parameters, set by plugins
    const intraday = () => INTRADAY.includes(state.res);
    const on = layer => state.layers.has(layer);

    const root = document.createElement('div');
    root.className = 'fac';
    if (o.background) root.style.setProperty('--fac-bg', o.background);
    root.innerHTML = `${o.controls ? `<div class="fac-bar">
        ${o.symbolButtons ? '<div class="fac-group" data-g="symbols"></div>' : ''}
        <div class="fac-group" data-g="res"></div><div class="fac-group" data-g="range"></div><div class="fac-group" data-g="session"></div>
        ${o.exposure ? '<div class="fac-menu"><button type="button">Layers ▾</button><div class="fac-panel"></div></div>' : ''}
        <span class="fac-status"></span></div>` : ''}
      <div class="fac-body"><div class="fac-canvas"></div><div class="fac-legend"></div><div class="fac-empty"></div></div>
      ${o.keyLevels && o.exposure ? '<div class="fac-keys"></div>' : ''}`;
    container.appendChild(root);
    const $ = sel => root.querySelector(sel);
    const status = text => { const s = $('.fac-status'); if (s) s.textContent = text; };

    const chart = LW.createChart($('.fac-canvas'), {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#8a909c', panes: { separatorColor: '#262a33' } },
      grid: { vertLines: { color: '#1b1e25' }, horzLines: { color: '#1b1e25' } },
      crosshair: { mode: LW.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#262a33' },
      timeScale: { borderColor: '#262a33', timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (t, type) => (type <= 2 ? fmtDay : fmtClock).format(new Date(t * 1000)) },
      localization: { timeFormatter: t => intraday() ? fmtTime.format(new Date(t * 1000)) + ' ET' : fmtDay.format(new Date(t * 1000)) },
    });
    // A level is a dot per bar (its strike jumps between minutes; a connected line would draw a wall of verticals) and a
    // dotted line at its latest value across the chart.
    const level = (color, title) => chart.addSeries(LW.LineSeries, { color, title, lineVisible: false, pointMarkersVisible: true,
      pointMarkersRadius: 1.5, priceLineVisible: true, priceLineStyle: LW.LineStyle.Dotted, priceLineWidth: 1, priceLineColor: color,
      lastValueVisible: true, crosshairMarkerVisible: false });

    let candles = null, bars = [], byTime = new Map(), gexByTime = new Map(), notes = [];
    const ctx = {
      LW, chart, root, options: o, colors: COLORS, level, intraday, on,
      get candles() { return candles; },
      get bars() { return bars; },
      get symbol() { return state.symbol; },
      get resolution() { return state.res; },
      get query() { return Object.assign({}, query); },
      setQuery(x) { Object.assign(query, x); return load(); },
      /** Puts a control into the toolbar before the status text; false when the toolbar is hidden. */
      addControl(el) { const st = $('.fac-status'); if (!st) return false; st.before(el); return true; },
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
    // Phones: resolutions, ranges and Layers only, and a one-line legend.
    const resizeObserver = new ResizeObserver(() => {
      const narrow = root.clientWidth < 560;
      if (narrow !== root.classList.contains('fac-narrow')) { root.classList.toggle('fac-narrow', narrow); renderLegend(null, null); }
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
        + (b.volume != null ? `<span class="k">Vol</span> ${big(b.volume)}` : '') + `<span class="k">${esc(b.source)}${intraday() ? ' · ' + sessionOf(b.time) : ''}</span>` : '';
      const lines = [];
      if (g) lines.push(`flip ${num(g.gamma_flip && g.gamma_flip.last)} (${(g.gamma_flip && g.gamma_flip.status) || '—'})`
        + ` · call wall ${num(g.call_wall)} · put wall ${num(g.put_wall)}`
        + (on('maxpain') && g.max_pain != null ? ` · max pain ${num(g.max_pain)}` : ''));
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
      buttons('symbols', state.symbols.map(x => [x.symbol, x.symbol]), v => v === state.symbol, v => api.setSymbol(v));
      buttons('res', RESOLUTIONS.map(r => [r, r]), v => v === state.res, v => api.setResolution(v));
      buttons('range', RANGES.filter(([, d]) => d <= (MAX_DAYS[state.res] || d)), v => v === state.days, v => api.setRange(v));
      buttons('session', [['RTH', 'rth'], ['ETH', 'eth']], v => v === o.session, v => api.setSession(v));
      const panel = $('.fac-panel');
      if (panel) {
        panel.innerHTML = layerList.map(([k, label]) => `<label><input type="checkbox" value="${esc(k)}" ${on(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('');
        panel.querySelectorAll('input').forEach(i => { i.onchange = () => api.setLayers(
          [...panel.querySelectorAll('input:checked')].map(x => x.value)); });
      }
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
      const to = new Date(Math.max(Date.now(), last));
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
      box.textContent = error === 'unknown_symbol' || error === 'no bars' ? `No chart data for ${state.symbol} yet.` : `Chart data unavailable (${error}).`;
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
      if (keepView && (r.error || !Array.isArray(r.bars))) { status(`refresh failed: ${r.error || 'no bars'}`); return; }
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
      if (c.error) notes.push(`layers: ${c.error}`);
      // A layer the key's plan does not include comes back as status "gated" with no data.
      const gated = layers.filter(k => c.layers && c.layers[k] && c.layers[k].status === 'gated');
      if (gated.length) notes.push(`not in your plan: ${gated.join(', ')}`);
      drawExposure(layers.includes('exposure') ? c.exposure || [] : []);
      renderKeyLevels(intraday() ? c.exposure || [] : (k && k.exposure) || []);
      call('draw', c);
      if (!intraday() && state.picked && ['levels', 'maxpain'].some(on)) notes.push('GEX levels: intraday resolutions only');
      else if (layers.includes('exposure') && !gated.includes('exposure') && !(c.exposure || []).length) notes.push('GEX: no rows in this window (sampled during RTH)');
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
      const last = rows.length ? rows[rows.length - 1] : null;
      if (!last) { keys.innerHTML = ''; return; }
      const day = dayOf(etTime(last.ts));
      let prev = null;
      for (let i = rows.length - 1; i >= 0; i--) if (dayOf(etTime(rows[i].ts)) < day) { prev = rows[i]; break; }
      const ch = (v, p) => v == null || p == null || v === p ? '' : ` <span class="ch">(${v > p ? '+' : '−'}${num(Math.abs(v - p))})</span>`;
      const item = (label, v, p, cls = '') => v == null ? ''
        : `<span><span class="k">${label}</span> <span class="${cls}">${num(v)}</span>${ch(v, p)}</span>`;
      const flip = last.gamma_flip || {}, pflip = (prev && prev.gamma_flip) || {};
      keys.innerHTML = [
        item('Spot', last.spot && last.spot.last, prev && prev.spot && prev.spot.last),
        item('Call wall', last.call_wall, prev && prev.call_wall, 'up'),
        item('Put wall', last.put_wall, prev && prev.put_wall, 'dn'),
        item(flip.status === 'available' || flip.last == null ? 'Gamma flip' : 'Gamma flip (unverified)', flip.last, pflip.last),
        on('maxpain') ? item('Max pain', last.max_pain, prev && prev.max_pain) : '',
        `<span class="k">${esc(fmtTime.format(new Date(etTime(last.ts) * 1000)))} ET${prev ? ' · change vs previous session' : ''}</span>`,
      ].filter(Boolean).join('');
    }

    const api = {
      setSymbol(x) { state.symbol = x; renderControls(); return load(); },
      setResolution(r) { state.res = r; state.days = DEFAULT_DAYS[r] || state.days; renderControls(); return load(); },
      /** Days back from now; capped per resolution (MAX_DAYS). */
      setRange(days) { state.days = days; renderControls(); return load(); },
      /** 'rth' (regular hours, the default) or 'eth' (with pre- and post-market). */
      setSession(x) { o.session = x; renderControls(); return load(); },
      /** Any of 'levels', 'maxpain', plus the ids of registered layer plugins. */
      setLayers(list) { state.layers = new Set(list); state.picked = true; renderControls(); return load(); },
      get layers() { return [...state.layers]; },
      reload: () => load(),
      destroy() {
        destroyed = true; state.loading++;
        clearInterval(timer);
        document.removeEventListener('click', closeMenu);
        call('destroy');
        resizeObserver.disconnect(); chart.remove(); root.remove();
      },
      get chart() { return chart; },
    };

    // Auto-refresh: every `refresh` seconds while the page is visible (0 = off).
    // Skipped while a load is running, so a refresh never replaces a load the user started.
    const timer = o.refresh > 0 ? setInterval(() => { if (!document.hidden && !pending && state.noData !== 'unknown_symbol') load({ keepView: true }); }, o.refresh * 1000) : null;

    (async () => {
      try { state.symbols = await source.symbols(); } catch (e) { state.symbols = []; }
      if (destroyed) return;
      if (!Array.isArray(state.symbols)) state.symbols = [];
      if (!state.symbol) state.symbol = (state.symbols.find(x => x.last_bar) || state.symbols[0] || {}).symbol;
      if (state.symbol && !state.symbols.some(x => x.symbol === state.symbol)) state.symbols.push({ symbol: state.symbol });
      renderControls();
      await load();
    })();
    return api;
  }

  global.FlashAlphaChart = {
    mount, chartEngineSource, registerLayers,
    get layers() { return [...CORE_LAYERS, ...plugins.flatMap(p => p.layers)].map(l => l[0]); },
    version: '0.1.0',
  };
})(typeof window !== 'undefined' ? window : globalThis);
