# Changelog

## 0.3.0 — 2026-11-13

- Embed keys: `FlashAlphaChart.setLicenseKey('fa_pk_…')` or `data-key` on the embed `<script>` tag; a console warning when
  a page uses a secret API key.
- Plans: the API's `plan` locks layers above it in the Layers menu with an upgrade link (`upgradeUrl`), and an Upgrade box
  names picked layers the plan doesn't include. Layer plugins declare `plans: { id: 'growth' }`.
- Themes: `theme: 'dark' | 'light' | 'auto'`, `setTheme()`.
- Levels drawn as step lines through the day.
- Mobile: session and plugin controls move into the Layers menu below 560 px; larger buttons; key levels in two columns;
  level labels without titles below 480 px.
- API errors shown in words; load status only with `debug: true`.
- The brand logo sits under the chart next to the "Charts by TradingView" link.
- Requests time out after 20 s; a chart whose element leaves the page stops refreshing.
- `embed.js`: default `5m` over 5 days, `data-range` accepts `1D 5D 1M 6M 1Y`, `data-theme`, `data-upgrade-url`,
  Lightweight Charts pinned by an SRI hash.
- Docs: [chart API reference](docs/api.md); gallery images also as WebP (about 4x smaller).

## 0.1.0 — 2026-11-11

First public release: candlestick chart with call wall, put wall, gamma flip and max pain, key levels text, layer plugins,
custom data sources, one-line embed.
