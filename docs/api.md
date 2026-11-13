# FlashAlpha chart API

The read API behind the chart widget. Base URL: `https://charts.flashalpha.com`. Every answer is JSON, field names in
snake_case, times in UTC ISO 8601. A `null` value means "unknown"; it is never filled with the previous value.

## Keys

Send the key in the `X-Api-Key` header (CORS allows `GET` from any origin with this header).

| Key | Where | What it can do |
|---|---|---|
| Secret API key (your FlashAlpha account key) | servers only | read every layer of your plan; mint embed keys |
| Embed key `fa_pk_…` | public pages | read every layer of the plan it was minted with, only from the domains it lists (checked on `Origin`, else `Referer`; subdomains included); cannot mint keys; never reaches the main FlashAlpha API |

### Mint an embed key

`POST /v1/embed-keys` with the secret key.

```http
POST /v1/embed-keys
X-Api-Key: <secret key>
Content-Type: application/json

{ "domains": ["example.com"], "ttl_seconds": 3600 }
```

- `domains`: 1 to 10 host names (no scheme, no path), at least two labels (`example.com`); a bare TLD, `localhost` and IP
  addresses are refused.
- `ttl_seconds` (optional): 300 up to 30 days; default 30 days. A site with a backend mints short-lived keys per page view;
  a static site mints a 30-day key and renews it.
- `plan` (optional): a plan up to yours (`free`, `basic`, ...), for a page that should show fewer layers.
- `delay_minutes` (optional): 15 to 1440. A delayed key reads nothing newer than now minus the delay (`/latest` is refused
  with `403 delayed_key`), and may live up to 365 days.

Answer `200`:

```json
{ "key": "fa_pk_…", "id": "424fba899475ef1f", "plan": "growth", "domains": ["example.com"], "expires_at": "2026-12-16T10:00:00Z",
  "delay_minutes": 0 }
```

The key carries the plan it was minted with until it expires. Errors: `403 secret_key_required` (an embed key tried to mint),
`400 domains_required`, `400 invalid_ttl`, `400 invalid_plan`, `400 invalid_delay`, `404 embed_keys_off`. FlashAlpha can revoke a key by its `id`.

## Plans and layers

| Plan | Layers |
|---|---|
| Free | bars only |
| Basic | `exposure` (walls, gamma flip, max pain, net GEX, regime, 0DTE magnet, vanna / charm / delta exposure) on scope `all` |
| Growth | plus `strikes`, `events`, `daily`, `metrics`, `expiries`, and the scopes `zero_dte`, `front`, `monthly` |
| Alpha, Enterprise | plus basis `live` |

A layer above the key's plan answers `{"status": "gated"}` in `layers` and has no data. `/v1/charts` also returns `plan`.

## Endpoints

### `GET /v1/symbols`

The symbols the engine serves.

```json
[{ "symbol": "SPX", "asset_class": "index", "enabled_from": "2026-01-02", "first_bar": "2025-11-03T14:30:00Z",
   "last_bar": "2026-11-13T20:59:00Z", "sources": ["quotes", "trades"], "reconciled_through": "2026-11-12" }]
```

### `GET /v1/bars/{symbol}`

OHLCV bars.

| Parameter | Default | |
|---|---|---|
| `resolution` | required | `1m 5m 15m 1h 1d 1w 1M` |
| `from`, `to` | last 5 days (intraday) or 2 years (daily and up), ending now | ISO 8601 UTC |
| `limit` | 5000 | at most 10000 |
| `session` | `rth` | `rth` (09:30–16:00 ET) or `eth` (04:00–20:00 ET) |
| `adjust` | `none` intraday, `split` daily | `none`, `split`, `all` (splits and dividends) |

```json
{ "symbol": "SPY", "resolution": "5m", "session": "rth", "adjust": "none", "from": "…", "to": "…", "count": 78,
  "bars": [{ "ts": "2026-11-13T14:30:00Z", "closed": true, "open": 671.2, "high": 671.9, "low": 670.8, "close": 671.5,
             "volume": 1203344, "vwap": 671.4, "buy_volume": 600112, "sell_volume": 580210, "trade_count": 9120, "source": "trades" }] }
```

`ts` is the start of the bar; daily bars carry the ET session date at 00:00 UTC. `source` is `trades`, `quotes` (bars from
quote samples: no volume) or a mix. `GET /v1/bars/{symbol}/latest?resolution=1m` returns `{ symbol, resolution, bar }` with
the newest bar, the open minute included (`closed: false`).

### `GET /v1/charts/{symbol}`

Options-positioning layers for a window.

| Parameter | Default | |
|---|---|---|
| `resolution` | `5m` | `1m 5m 15m 1h 1d 1w`; `exposure`, `strikes`, `metrics` are intraday only |
| `from`, `to` | last 5 days, ending now | ISO 8601 UTC; the window is at most 5 days on 1m, 31 on 5m, 62 on 15m, 366 on 1h, 3660 on 1d and 1w (`400 range_too_long` with `max_days`) |
| `layers` | `exposure` | comma list of `exposure`, `strikes`, `events`, `daily`, `metrics`, `expiries` |
| `scope` | `all` | expiries: `all`, `zero_dte`, `front`, `monthly` |
| `basis` | `settled` | open interest: `settled` (last close) or `live` (with today's flow) |
| `session` | `rth` | `rth` or `eth` |
| `metrics` | none | with `layers=metrics`: up to 8 column names from `/v1/metrics/columns` |
| `model_ver` | newest in the window | pin a model version |

Answer:

```json
{
  "symbol": "SPX", "resolution": "5m", "scope": "all", "basis": "settled", "session": "rth", "from": "…", "to": "…",
  "plan": "growth", "model_ver": "gex-2026.10",
  "exposure": [{
    "ts": "2026-11-13T19:55:00Z",
    "spot": { "first": 5051.2, "min": 5049.8, "max": 5056.5, "last": 5056.5 },
    "net_gex": { "first": -1.2e7, "min": -2.0e7, "max": -1.1e7, "last": -1.75e7 },
    "gamma_flip": { "first": 5030, "min": 5030, "max": 5035, "last": 5030, "status": "available" },
    "regime": "negative_gamma", "call_wall": 5075, "put_wall": 5025, "max_pain": 5050, "zero_dte_magnet": 5055,
    "net_dex": 1.1e9, "net_vex": -3.2e8, "net_chex": 4.0e7,
    "as_of": "2026-11-13T19:59:00Z", "data_quality_score": 0.98, "snapshot_age_s": 12
  }],
  "strikes": [{ "ts": "2026-11-13T19:55:00Z", "rows": [[5050, 1.2e8, 10234, 8122, 2.1e9, -3.0e7, 4.0e6], [5055, -4.0e7, 7120, 9001, -1.4e9, 1.2e7, null]] }],
  "events": [{ "ts": "…", "kind": "call_wall", "event": "rejected", "level_id": "…", "level": 5075, "prev_level": null,
               "strength": 0.7, "detail": null, "model_ver": "…" }],
  "daily": [{ "ts": "2026-11-13T00:00:00Z", "open_call_wall": 5075, "open_put_wall": 5025, "open_gamma_flip": 5030,
              "max_pain": 5050, "iv30": 14.2, "rv20": 11.8, "vrp": 2.4, "expected_move_1d": 38.5, "opex": false, "earnings": null }],
  "metrics": [{ "ts": "…", "values": { "zero_dte_vol_context_vix": 15.3 } }],
  "expiries": { "ts": "2026-11-13T19:45:00.000000Z", "expirations": ["2026-11-13", "2026-11-14", "2026-11-21"],
                "strikes": [5050, 5055], "cells": [[5050, 0, 1.2e8, 2.1e9, -3.0e7, 4.0e6], [5055, 2, -4.0e7, null, null, null]] },
  "layers": {
    "exposure": { "status": "ok", "count": 78, "last_ts": "…", "missing_minutes": 0 },
    "strikes": { "status": "ok", "count": 78, "last_ts": "…" }
  }
}
```

- `exposure`: one row per bar; the level fields are the last value in the bar, `spot`, `net_gex` and `gamma_flip` also give
  first / min / max. `gamma_flip.status` is `available` once the flip is certified. `regime` is `positive_gamma` or
  `negative_gamma`.
- `strikes`: per bar, the last 5-minute snapshot per strike: `[strike, net_gex, call_oi, put_oi, net_dex, net_vex, net_chex]`
  (gamma, delta, vanna and charm exposure), strikes within 2% of the window's price range.
- `events`: level touches, rejections, breaks, flip crossings, regime flips, and day markers (`kind: "marker"`: opex, earnings,
  expiry roll, OI change; `detail` is JSON text).
- `daily`: one row per session (open levels, expected move, IV30, RV20, VRP, VIX state, opex, earnings).
- `expiries`: the latest strike × expiry snapshot in the window (taken every 15 minutes in RTH; any resolution, it is not a
  series): the first 8 expirations, strikes within 10% of spot, `cells` as `[strike, expiration_index, net_gex, net_dex,
  net_vex, net_chex]` (`expiration_index` points into `expirations`). `null` with status `missing` when the window has none.
- `layers.{name}.status`: `ok`, `partial` (exposure with missing minutes), `missing` (no rows), `gated` (not in the plan),
  `unsupported_resolution`.

### `GET /v1/metrics/columns`

The per-minute metric columns `metrics=` accepts: `{ "columns": ["summary_hedging_estimate_spot_up_1pct_notional_usd", …] }`.
`hedge_flow_cumulative` and `hedge_flow_bar` are the 0DTE hedging flow: dealers' signed delta-dollars on today's expiry,
cumulative since the open and the last 30-second bar, as of the minute. Sessions without a same-day expiry have no value.

## Errors and limits

Every error is `{ "error": "<code>" }` with the HTTP status.

| Status | Codes |
|---|---|
| 400 | `invalid_resolution`, `invalid_range`, `range_too_long`, `invalid_ttl`, `invalid_layers`, `invalid_scope_or_basis`, `invalid_session`, `invalid_adjust` |
| 401 | `api_key_required`, `invalid_api_key`, `invalid_embed_key`, `embed_key_expired`, `embed_key_revoked` |
| 403 | `origin_not_allowed` (embed key on another domain), `delayed_key` (a delayed key on `/latest` or minting) |
| 404 | `unknown_symbol` |
| 429 | `too_many_requests` (per key: 600 a minute for embed keys and API keys), `too_many_key_lookups` (unknown keys per client) |
| 503 | `auth_unavailable`, `questdb_unavailable` (retry) |

Answers are not cached by browsers or proxies (`Cache-Control: no-store`).
