/*
 * FlashAlpha chart embed: one script tag and a div, no build step.
 *
 *   <div data-flashalpha-chart data-symbol="SPX" data-key="YOUR_KEY" data-resolution="5m" style="height: 480px"></div>
 *   <script async src="https://<chart host>/embed.js"></script>
 *
 * The script loads lightweight-charts and flashalpha-chart-core.js (from its own host) once, then the optional layer
 * bundle (flashalpha-chart-layers.js, same host) if the host serves one, then mounts every [data-flashalpha-chart]
 * element on the page, reading the chart API on the host it was loaded from. Without the layer bundle the chart works
 * as is with the core layers (levels, maxpain).
 * Attributes (all optional except data-symbol):
 *   data-key          API key, sent as X-Api-Key
 *   data-resolution   1m 5m 15m 1h 1d 1w (default 1d; GEX levels need 1m to 1h)
 *   data-range        days back (default: per resolution, 183 = 6M on 1d)
 *   data-layers       comma list, e.g. "levels,maxpain" (default: levels; ids from the layer bundle work when it is loaded)
 *   data-session      rth | eth
 *   data-controls     "false" hides the toolbar
 *   data-background   CSS colour of the chart background
 *   data-refresh      seconds between refreshes (default 60, 0 = off)
 *   data-key-levels   "false" hides the key levels text under the chart
 *   data-base         chart API root, when it is not the host of this script
 * On the <script> tag itself: data-layer-bundle="false" skips the layer bundle.
 * Pages that add charts later (single-page apps) call FlashAlphaEmbed.scan().
 */
(function () {
  'use strict';
  if (window.FlashAlphaEmbed) { window.FlashAlphaEmbed.scan(); return; }

  var LW_URL = 'https://unpkg.com/lightweight-charts@5.0.0/dist/lightweight-charts.standalone.production.js';
  var me = document.currentScript;
  var host = me ? me.src.replace(/\/[^\/]*(\?.*)?$/, '') : '';
  var withLayers = !(me && me.getAttribute('data-layer-bundle') === 'false');

  function script(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // The layer bundle registers its layers with FlashAlphaChart.registerLayers, so it loads after the core and before
  // the first mount. A host without it (404) or a blocked request just leaves the core layers.
  var ready = (window.LightweightCharts ? Promise.resolve() : script(LW_URL))
    .then(function () { return window.FlashAlphaChart ? null : script(host + '/flashalpha-chart-core.js'); })
    .then(function () {
      if (!withLayers) return null;
      return script(host + '/flashalpha-chart-layers.js').catch(function () { return null; });
    });

  function options(el) {
    var d = el.dataset, o = { symbol: (d.symbol || '').toUpperCase() || null, apiKey: d.key || null, baseUrl: d.base || host,
      resolution: d.resolution || '1d', symbolButtons: false };
    if (d.range) o.days = +d.range;
    if (d.layers) o.layers = d.layers.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (d.session) o.session = d.session;
    if (d.controls === 'false') o.controls = false;
    if (d.background) o.background = d.background;
    if (d.refresh != null) o.refresh = +d.refresh;
    if (d.keyLevels === 'false') o.keyLevels = false;
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
