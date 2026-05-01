# Flow Backtest Notes

This version adds a Backtest tab and two endpoints:

- `POST /api/flow-alerts/backtest`
- `GET /api/flow-alerts/backtest`

The backtest replays stored Neon bars from `flow_live_bars` first. If that table has no matching rows, it falls back to older tables:

- NIFTY: `live_bars`
- SENSEX: `sensex_bars`

## Logic

1. Calculate abnormal volume using SD lookback, default SD200.
2. Fire `HIGH_VOLUME_EVENT` immediately when CE/PE volume spikes.
3. Start a validation watch for 5 minutes by default.
4. If event low is not broken and bullish flow confirms, create `BEAR_TRAP_BUY_CE`.
5. If event high is not broken and bearish flow confirms, create `BULL_TRAP_BUY_PE`.
6. Outcome is checked using spot points after the confirmation alert.

## Important

For proper SD200 results, Neon should contain enough historical bars before the selected backtest time. The endpoint loads up to 7 days before the selected start time as seed history.

Default parameters:

```env
FLOW_ALERT_VOLUME_LOOKBACK=200
FLOW_ALERT_MIN_VOLUME_SAMPLES=80
FLOW_ALERT_MIN_VOL_ZSCORE=2.50
FLOW_ALERT_MIN_VOL_RATIO=6.00
FLOW_ALERT_TRAP_WAIT_MS=300000
FLOW_ALERT_BREAK_BUFFER=2
```

The Backtest tab lets you select index, date/time range, optional strike, target points, wait minutes, and minimum SD samples.
