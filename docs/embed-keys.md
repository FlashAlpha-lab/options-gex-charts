# Embed keys

An embed key (`fa_pk_…`) is the key you put in a public web page to show FlashAlpha charts. Your secret FlashAlpha API key
stays on your server.

## What an embed key can do

| | Embed key `fa_pk_…` | Secret API key |
|---|---|---|
| Where it goes | public pages | your server only |
| Reads | chart data only (`/v1/symbols`, `/v1/bars`, `/v1/charts`, `/v1/metrics/columns`) | every FlashAlpha API endpoint of your plan |
| Sites | only the domains listed in the key, and their subdomains (the browser's `Origin`, else `Referer`) | any |
| Plan | the plan it was created with, or a lower one you ask for | your current plan |
| Lifetime | 5 minutes to 30 days (default 30 days); delayed keys up to 1 year | until you rotate it |
| Data | live, or delayed by 15 minutes to 24 hours | live |
| Can create keys | no | yes |
| Request limit | 600 a minute for all visitors of your site together | 600 a minute |

A copied embed key is useful only on your domains, only for charts, and only until it expires.

## Create one

From your server or a terminal, with your secret API key:

```sh
curl -X POST https://charts.flashalpha.com/v1/embed-keys \
  -H "X-Api-Key: $FLASHALPHA_API_KEY" -H "Content-Type: application/json" \
  -d '{"domains": ["example.com"]}'
```

| Field | | |
|---|---|---|
| `domains` | required | 1 to 10 host names, at least two labels (`example.com`, not `com`); no IP addresses or `localhost` |
| `ttl_seconds` | optional | lifetime, 300 to 30 days (default 30 days; up to 1 year for a delayed key) |
| `plan` | optional | a plan up to yours, to show fewer layers |
| `delay_minutes` | optional | 15 to 1440: the key reads nothing newer than now minus the delay |

The answer carries the key, its `id`, `plan`, `domains`, `expires_at`, and `delay_minutes`. Keep the `id`: FlashAlpha can
revoke a key by its id.

## Which lifetime to pick

- **A site with its own backend:** create a short-lived key (`"ttl_seconds": 3600`) for each page view and put it in the
  page. A leaked key stops working within the hour.
- **A static site:** create a 30-day key and renew it, for example from a monthly job.
- **A public demo or free widget:** a delayed key (`"delay_minutes": 15`) that lives up to a year.

## Use it

```html
<div data-flashalpha-chart data-symbol="SPX" style="height: 480px"></div>
<script async src="https://charts.flashalpha.com/embed.js" data-key="fa_pk_YOUR_EMBED_KEY"></script>
```

Or, with the chart core: `FlashAlphaChart.setLicenseKey('fa_pk_YOUR_EMBED_KEY')` before `FlashAlphaChart.mount(...)`.

## Errors

| Code | Meaning |
|---|---|
| `401 invalid_embed_key` | not a key FlashAlpha created, or changed |
| `401 embed_key_expired` | past `expires_at`: create a new one |
| `401 embed_key_revoked` | revoked by FlashAlpha |
| `403 origin_not_allowed` | the page is not on one of the key's domains |
| `403 secret_key_required` | an embed key tried to create a key |
| `429 too_many_requests` | over 600 requests a minute; the chart retries |

The full API is in the [chart API reference](api.md).
