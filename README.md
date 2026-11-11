# Options GEX Charts

An embeddable JavaScript candlestick chart that draws options gamma exposure (GEX) levels on the price: call wall, put
wall, gamma flip, and max pain. It renders with [TradingView Lightweight Charts™](https://github.com/tradingview/lightweight-charts)
and reads data from the [FlashAlpha](https://flashalpha.com) options analytics API or from your own backend.

- One `<div>` and one `<script>`. No build step and no framework.
- Levels share the time axis with the price, so you can see where the price traded against each level.
- Works on phones: the toolbar and legend shrink below 560 px.
- MIT licensed.

## Project status

The chart code in this repository is ready to use with your own data source. The hosted FlashAlpha chart API and the
one-line embed aren't public yet. Until they are, the examples that use FlashAlpha data (`basic.html`, `embed.html`)
show a "Chart data unavailable" message. [`examples/custom-source.html`](examples/custom-source.html) runs offline with
generated data.

## Quick start with your own data

1. Load Lightweight Charts 5 and the chart core:

   ```html
   <script src="https://unpkg.com/lightweight-charts@5.0.0/dist/lightweight-charts.standalone.production.js"></script>
   <script src="src/flashalpha-chart-core.js"></script>
   ```

1. Add a container with a height. The chart fills the container and follows its size.

   ```html
   <div id="chart" style="height: 480px"></div>
   ```

1. Mount the chart with a `source` object. For the shape of the data, see [Use your own data](#use-your-own-data).

   ```html
   <script>
     const chart = FlashAlphaChart.mount(document.getElementById('chart'), {
       symbol: 'SPX',
       resolution: '5m',
       layers: ['levels', 'maxpain'],
       source: mySource,
     });
   </script>
   ```

For a complete page, open [`examples/custom-source.html`](examples/custom-source.html) in a browser.

## Use FlashAlpha data

When the hosted chart API is public, you pass a FlashAlpha chart key instead of a `source` object:

```js
FlashAlphaChart.mount(el, {
  symbol: 'SPX',
  resolution: '5m',
  apiKey: 'YOUR_CHART_KEY',
  baseUrl: 'https://charts.flashalpha.com',
});
```

The chart sends the key in the `X-Api-Key` header. Anyone can read the key in your page source, so the chart key is a
publishable key: it is read-only and works only for chart data. The layers that you get depend on your FlashAlpha plan.
A layer that your plan doesn't include shows a "not in your plan" note.

### One-line embed

The embed script loads Lightweight Charts and the chart core, then mounts every element that has the
`data-flashalpha-chart` attribute:

```html
<div data-flashalpha-chart data-symbol="SPX" data-key="YOUR_CHART_KEY" data-resolution="5m" style="height: 480px"></div>
<script async src="https://charts.flashalpha.com/embed.js"></script>
```

If your page adds charts after it loads, for example in a single-page app, call `FlashAlphaEmbed.scan()`.

| Attribute | Default | Description |
|---|---|---|
| `data-symbol` | Required | Ticker, for example `SPX` or `SPY`. |
| `data-key` | None | Your FlashAlpha chart key. |
| `data-resolution` | `1d` | One of `1m`, `5m`, `15m`, `1h`, `1d`, `1w`. |
| `data-range` | Depends on resolution | Number of days to show. |
| `data-layers` | `levels` | Comma-separated layer IDs, for example `levels,maxpain`. |
| `data-session` | `rth` | `rth` for regular hours, `eth` to add pre-market and after-hours. |
| `data-controls` | `true` | `false` hides the toolbar. |
| `data-key-levels` | `true` | `false` hides the key levels text under the chart. |
| `data-background` | `#0f1115` | Chart background color. |
| `data-refresh` | `60` | Seconds between refreshes while the page is visible. `0` turns refresh off. |
| `data-base` | The script's host | Chart API root URL, for example when you use a proxy. |

To skip the optional layer bundle, add `data-layer-bundle="false"` to the `<script>` tag.

## What the chart shows

- Candlesticks and volume, with zoom, scroll, and a crosshair legend.
- Resolutions from 1 minute to 1 week, and ranges from 1 day to 1 year.
- Regular session or extended hours, on a US Eastern time axis.
- The `levels` layer: call wall, put wall, and gamma flip. The flip is gray when the data source marks it as not
  certified.
- The `maxpain` layer: max pain.
- Key levels as text under the chart: spot, walls, flip, and max pain, each with its change since the previous session.
- Muted "spot" candles after the last stored bar, when the data source sends spot prices for those minutes.

The chart refreshes every 60 seconds while the page is visible and keeps your zoom.

## Options

`FlashAlphaChart.mount(element, options)` accepts these options:

| Option | Default | Description |
|---|---|---|
| `symbol` | First symbol with data | Ticker. |
| `resolution` | `5m` | One of `1m`, `5m`, `15m`, `1h`, `1d`, `1w`. |
| `days` | Depends on resolution | Number of days to show. Each resolution has a maximum. |
| `session` | `rth` | `rth` or `eth`. |
| `layers` | `['levels']` | Layer IDs: `levels`, `maxpain`, and IDs from registered layer plugins. |
| `controls` | `true` | `false` hides the toolbar. |
| `symbolButtons` | `true` | `false` hides the symbol buttons. |
| `exposure` | `true` | `false` draws candles only. |
| `keyLevels` | `true` | `false` hides the key levels text. |
| `source` | FlashAlpha | Your own data source. |
| `apiKey` | None | FlashAlpha chart key. |
| `baseUrl` | Same origin | Chart API root URL. |
| `refresh` | `60` | Seconds between refreshes. `0` turns refresh off. |
| `background` | `#0f1115` | Background color. You can also set the CSS variable `--fac-bg`. |
| `lightweightCharts` | `window.LightweightCharts` | The Lightweight Charts module, if you import it instead of loading the script. |

`mount` returns an object with these members: `setSymbol(symbol)`, `setResolution(resolution)`, `setRange(days)`,
`setSession('rth' | 'eth')`, `setLayers([...])`, `layers`, `reload()`, `destroy()`, and `chart` (the Lightweight Charts
instance, for your own series).

When there's no data to draw, the chart shows a message and dispatches a `flashalpha:nodata` event on the container.
The event bubbles, and `event.detail` has `symbol` and `error`. For example, you can hide the chart's section:

```js
el.addEventListener('flashalpha:nodata', () => { el.closest('section').hidden = true; });
```

## Use your own data

Pass an object with the following methods as the `source` option. Each method can return a value or a promise.

```js
const mySource = {
  // Tickers the chart can show.
  symbols: () => [{ symbol: 'SPX', last_bar: '2026-11-10T21:00:00Z' }],

  // OHLCV bars.
  bars: (symbol, resolution, fromIso, toIso, session) => ({
    bars: [{ ts: '2026-11-10T14:30:00Z', open: 0, high: 0, low: 0, close: 0, volume: 0, source: 'mine' }],
  }),

  // Gamma exposure levels per bar.
  charts: (symbol, resolution, fromIso, toIso, { layers, session }) => ({
    exposure: [{
      ts: '2026-11-10T14:30:00Z',
      call_wall: 0, put_wall: 0, max_pain: 0,
      gamma_flip: { last: 0, status: 'available' },
    }],
  }),
};
```

- Times are UTC ISO 8601 strings. The chart shows them in US Eastern time.
- A `null` value is drawn as a gap, not as the previous value.
- A `gamma_flip.status` other than `available` draws the flip in gray.
- Levels are drawn on intraday resolutions (`1m` to `1h`).
- An exposure row can include `spot: { first, min, max, last }`. The chart then draws muted "spot" candles for minutes
  after the last bar.
- To report an error, return `{ error: 'message' }`. The chart shows the message instead of an empty chart.

## Add layers

To add layers to the Layers menu, call `FlashAlphaChart.registerLayers(plugin)` before `mount`. The layers apply to
every chart that you mount afterward. This example adds a VWAP line:

```js
FlashAlphaChart.registerLayers({
  layers: [['vwap', 'VWAP']],
  attach(ctx) {
    let line;
    return {
      ready() { line = ctx.chart.addSeries(ctx.LW.LineSeries, { color: '#4fc3f7', lineWidth: 1 }); },
      draw() {
        let pv = 0, v = 0;
        line.setData(!ctx.on('vwap') ? [] : ctx.bars.map(b => {
          pv += b.close * (b.volume || 0); v += b.volume || 0;
          return v ? { time: b.time, value: pv / v } : { time: b.time };
        }));
      },
      clear() { line.setData([]); },
    };
  },
});
```

A plugin has these fields:

- `layers`: an array of `[id, label]` pairs.
- `defaults` (optional): layer IDs that are on by default.
- `apiLayers(ctx)` (optional): extra API layers to request.
- `attach(ctx)`: runs once per chart and returns a handle with any of `ready()`, `draw(response)`, `clear()`,
  `legend(time, y)`, `crosshair(time, y)`, and `destroy()`.

The header comment in [`src/flashalpha-chart-core.js`](src/flashalpha-chart-core.js) describes `ctx` and the handle
in full.

## FAQ

**What is gamma exposure (GEX)?**
GEX estimates how much options market makers' delta changes when the underlying price moves. It's summed over all
strikes from open interest and each option's gamma. It indicates how much stock dealers might need to buy or sell to
stay hedged.

**What is the call wall?**
The strike with the largest call gamma exposure. Dealer hedging near it tends to slow rallies, so traders often read it
as resistance.

**What is the put wall?**
The strike with the largest put gamma exposure. Traders often read it as support.

**What is the gamma flip?**
The price where net GEX changes sign. Above it, dealers are estimated to be long gamma, and their hedging dampens moves.
Below it, they are estimated to be short gamma, and their hedging can amplify moves.

**What is max pain?**
The strike at which open options would expire with the least total value for their holders.

**Is this a trading signal?**
No. The levels are model estimates from open interest, not observed dealer positions, and they aren't financial advice.

**Can I use the chart with my own backend?**
Yes. Pass a `source` object. You need a FlashAlpha key only for FlashAlpha data.

## Browser support

The chart supports current versions of Chrome, Edge, Firefox, and Safari on desktop and mobile. It needs ES2020 and
`Intl.DateTimeFormat` with time zone support.

## License and attribution

This project is licensed under the MIT License. See [LICENSE](LICENSE).

The chart loads [TradingView Lightweight Charts™](https://github.com/tradingview/lightweight-charts) at run time and
doesn't include its source code. Lightweight Charts is licensed under the Apache License 2.0:

> TradingView Lightweight Charts™
> Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/

The chart keeps the TradingView attribution logo, which is the Lightweight Charts default
(`layout.attributionLogo: true`). The logo meets the license requirement to link to tradingview.com. If you turn the
logo off, link to https://www.tradingview.com/ elsewhere on your page. If you bundle Lightweight Charts with your code,
include its LICENSE and NOTICE files.

## Related projects

- [FlashAlpha](https://flashalpha.com): real-time options analytics API.
- [flashalpha-js](https://github.com/FlashAlpha-lab/flashalpha-js): JavaScript and TypeScript SDK.
- [flashalpha-python](https://github.com/FlashAlpha-lab/flashalpha-python): Python SDK.
- [gex-explained](https://github.com/FlashAlpha-lab/gex-explained): the theory and math behind GEX.
- [awesome-options-analytics](https://github.com/FlashAlpha-lab/awesome-options-analytics): a list of options analytics resources.
