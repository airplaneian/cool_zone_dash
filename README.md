# Cool Zone Dashboard

A terminal-style dashboard tracking systemic risk across three layers, loosely based on Richard Bookstaber's framing of physical constraints propagating through financial structures.

Live: https://airplaneian.github.io/cool_zone_dash/

## What it tracks

| Layer | Metric | Ticker |
|---|---|---|
| L1 Physical | Crude oil (WTI) | `CL=F` |
| L1 Physical | Semiconductor ETF | `SOXX` |
| L2 Concentration | Cap-weight vs. equal-weight S&P 500 | `SPY` / `RSP` |
| L3 Credit | 10-year Treasury yield | `^TNX` |
| L3 Credit | Blue Owl Capital (private credit proxy) | `OWL` |

## Alerts

- **Price band:** price breaks its 60-day mean ± 2.5σ in the risk direction.
- **Momentum:** 30- or 90-day change is ≥ 2σ against that asset's own history.
- **Concentration:** SPY/RSP ratio is above the 90th percentile of its 5-year range.
- **Credit stress:** 10Y yield up ≥ 25bp while OWL is down ≥ 15% over 30 days.

Defaults fire on roughly 2–7% of days over a 5-year backtest. All thresholds and risk directions can be changed under **ALERT CFG**, which also shows how often each setting would have fired. Alerts use daily data regardless of the selected time window.

## Data

- Daily history (5 years) from Yahoo Finance, fetched through a Cloudflare Worker that adds CORS headers. Refreshes every 15 minutes.
- The **1D** view loads 1-minute bars and then streams live ticks from Yahoo's WebSocket feed. CL=F is delayed about 10 minutes at the source.
- Yahoo's chart API and stream are unofficial and may change without notice.

## Running locally

No build step. Serve the folder on a port the worker allows (see `ALLOWED_ORIGINS` in `worker/index.js`):

```sh
python3 -m http.server 8080
```

## Deploying

- **Site:** GitHub Pages serves `main` from the repo root. Pushing to `main` deploys.
- **Worker:** deployed separately: `cd worker && npx wrangler deploy`. Update `WORKER_BASE_URL` in `app.js` if the URL changes.
