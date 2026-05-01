# Flow Alert Changes

This build changes the alert sequence so the first alert is an immediate information alert when abnormal SD200 option volume appears.

## Alert sequence

1. `HIGH_VOLUME_EVENT` fires immediately when CE or PE volume is abnormal versus SD200.
2. The system starts a 5-minute trap watch from that event candle.
3. If the event low is not broken and CE flow confirms, it fires `BEAR_TRAP_BUY_CE`.
4. If the event high is not broken and PE flow confirms, it fires `BULL_TRAP_BUY_PE`.

## Scope

By default, `FLOW_ALERT_SCAN_ALL_STRIKES=true`, so the high-volume information alert scans every option strike captured for NIFTY and SENSEX.

## Recommended Railway variables

```env
FLOW_ALERT_SCAN_ALL_STRIKES=true
FLOW_ALERT_VOLUME_LOOKBACK=200
FLOW_ALERT_MIN_VOLUME_SAMPLES=80
FLOW_ALERT_MIN_VOL_ZSCORE=2.50
FLOW_ALERT_MIN_VOL_RATIO=6.00
FLOW_ALERT_MIN_VOLUME_NIFTY=1000000
FLOW_ALERT_MIN_VOLUME_SENSEX=150000
FLOW_ALERT_HIGH_VOLUME_DEDUPE_MS=60000
FLOW_ALERT_TRAP_WAIT_MS=300000
FLOW_ALERT_BREAK_BUFFER=2
FLOW_ALERT_PREMIUM_BIAS_MIN=4
```

Set `FLOW_ALERT_SCAN_ALL_STRIKES=false` if you want to restrict later to ATM +/- N strikes.
