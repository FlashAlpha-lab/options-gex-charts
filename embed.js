/*
 * FlashAlpha chart embed: one script tag and a div, no build step.
 *
 *   <div data-flashalpha-chart data-symbol="SPX" style="height: 480px"></div>
 *   <script async src="https://<chart host>/embed.js" data-key="fa_pk_YOUR_EMBED_KEY"></script>
 *
 * The script loads lightweight-charts and flashalpha-chart-core.js (from its own host) once, then the optional layer
 * bundle (flashalpha-chart-layers.js, same host) if the host serves one, then mounts every [data-flashalpha-chart]
 * element on the page, reading the chart API on the host it was loaded from. Without the layer bundle the chart works
 * as is with the core layers (levels, maxpain).
 * Attributes (all optional except data-symbol):
 *   data-key          key for this chart, sent as X-Api-Key (default: data-key on the script tag, the page-wide key).
 *                     On a public page use an embed key (fa_pk_…, locked to your domains), never the secret API key.
 *   data-resolution   1m 5m 15m 1h 1d 1w (default 5m; GEX levels need 1m to 1h)
 *   data-range        days back, or 1D 5D 1M 6M 1Y (default: per resolution, 5 days on 5m)
 *   data-theme        dark (default) | light | auto (follows the reader's system setting)
 *   data-upgrade-url  where the Upgrade button and locked layers link (default flashalpha.com pricing)
 *   data-layers       comma list, e.g. "levels,maxpain" (default: levels; ids from the layer bundle work when it is loaded)
 *   data-session      rth | eth
 *   data-controls     "false" hides the toolbar
 *   data-background   CSS colour of the chart background
 *   data-refresh      seconds between refreshes (default 60, 0 = off)
 *   data-metric       a per-minute metric column drawn in its own pane (intraday resolutions; needs the layer bundle)
 *   data-key-levels   "false" hides the key levels text under the chart
 *   data-brand        "false" keeps the TradingView logo instead of the FlashAlpha one
 *   data-base         chart API root, when it is not the host of this script
 * On the <script> tag itself: data-key (the key for every chart on the page), data-layer-bundle="false" skips the layer
 * bundle, data-debug="true" shows load status in the toolbar.
 * The plan of the key decides the layers: layers above it show a lock and an Upgrade link (the API sends the plan).
 * Pages that add charts later (single-page apps) call FlashAlphaEmbed.scan().
 * The core and the bundle are requested with ?v=VERSION, so a new deploy is not hidden by a cached copy: bump VERSION
 * whenever either file changes.
 */
(function () {
  'use strict';
  if (window.FlashAlphaEmbed) { window.FlashAlphaEmbed.scan(); return; }

  var VERSION = '0.8.1';
  // lightweight-charts from the CDN, pinned by hash: the script runs in every page that embeds the chart.
  var LW_URL = 'https://unpkg.com/lightweight-charts@5.0.0/dist/lightweight-charts.standalone.production.js';
  var LW_SRI = 'sha384-/z0wnnyAhUnLX5YRrxljPlJlhJPGIOuhRU9kt785gf9AUeh8YsG8O6oxSE2sTS9m';
  var RANGES = { '1D': 1, '5D': 5, '1M': 31, '6M': 183, '1Y': 366 };
  var me = document.currentScript;
  var host = me ? me.src.replace(/\/[^\/]*(\?.*)?$/, '') : '';
  var withLayers = !(me && me.getAttribute('data-layer-bundle') === 'false');
  var pageKey = me ? me.getAttribute('data-key') : null;
  var debug = !!(me && me.getAttribute('data-debug') === 'true');

  function script(src, integrity) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // The layer bundle registers its layers with FlashAlphaChart.registerLayers, so it loads after the core and before
  // the first mount. A host without it (404) or a blocked request just leaves the core layers.
  // A lightweight-charts the page already has is used only when it is version 5 (the chart needs its series API).
  var hasLw5 = window.LightweightCharts && window.LightweightCharts.CandlestickSeries && window.LightweightCharts.createSeriesMarkers;
  var ready = (hasLw5 ? Promise.resolve() : script(LW_URL, LW_SRI))
    .then(function () { return window.FlashAlphaChart ? null : script(host + '/flashalpha-chart-core.js?v=' + VERSION); })
    .then(function () {
      if (!withLayers) return null;
      return script(host + '/flashalpha-chart-layers.js?v=' + VERSION).catch(function () { return null; });
    });

  function options(el) {
    var d = el.dataset, o = { symbol: (d.symbol || '').toUpperCase() || null, apiKey: d.key || pageKey || null, baseUrl: d.base || host,
      resolution: d.resolution || '5m', symbolButtons: false, debug: debug };
    if (d.range) { var days = RANGES[d.range.toUpperCase()] || +d.range; if (days > 0) o.days = days; }
    if (d.theme) o.theme = d.theme;
    if (d.upgradeUrl) o.upgradeUrl = d.upgradeUrl;
    if (d.layers) o.layers = d.layers.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (d.session) o.session = d.session;
    if (d.controls === 'false') o.controls = false;
    if (d.background) o.background = d.background;
    if (d.refresh != null) o.refresh = +d.refresh;
    if (d.metric) o.metric = d.metric;
    if (d.keyLevels === 'false') o.keyLevels = false;
    if (d.brand !== 'false') o.brand = { logo: host + '/flashalpha-logo.png', href: 'https://flashalpha.com', name: 'FlashAlpha' };
    return o;
  }

  function scan() {
    return ready.then(function () {
      var els = document.querySelectorAll('[data-flashalpha-chart]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.__flashalphaChart) continue;
        if (!el.clientHeight) el.style.height = '460px';
        el.__flashalphaChart = window.FlashAlphaChart.mount(el, options(el));
      }
    }).catch(function (e) { if (window.console) console.error('[flashalpha-chart]', e); });
  }

  window.FlashAlphaEmbed = { scan: scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
