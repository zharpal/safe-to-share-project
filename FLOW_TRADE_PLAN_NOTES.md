# Flow Trade Plan Update

This version separates the abnormal-volume trigger from the actual option to trade.

## New columns in Backtest and Live Alerts

| Column | Meaning |
|---|---|
| Time | Confirmation/event time |
| Event | High Volume, Bear Trap CE, or Bull Trap PE |
| Trigger | Strike and side where SD200 abnormal volume appeared |
| Trade | WAIT, BUY_CE, or BUY_PE |
| Entry Spot | Spot at the alert/confirmation time |
| Trade Strike | Actual option strike/side to trade |
| Spot SL | Index-level invalidation stop-loss |
| Option SL | Option premium stop-loss based on configured percentage |
| Target | Target in index points |
| Result / Pts | Backtest-only result; live alerts show LIVE or blank |

## Default trade strike selection

Trade strike is selected from spot at confirmation time:

- BUY_CE: ATM CE by default
- BUY_PE: ATM PE by default

Set `FLOW_ALERT_TRADE_STRIKE_OFFSET_STEPS=1` if you want one-step ITM instead:

- BUY_CE: ATM - 1 step CE
- BUY_PE: ATM + 1 step PE

## Stop-loss and target

- BUY_CE spot SL = event low - buffer
- BUY_PE spot SL = event high + buffer
- Option SL = entry premium - configured percentage
- Target = configured index points

Useful Railway env vars:

```env
FLOW_ALERT_TRADE_STRIKE_OFFSET_STEPS=0
FLOW_ALERT_OPTION_SL_PCT=25
FLOW_ALERT_TARGET_POINTS_NIFTY=25
FLOW_ALERT_TARGET_POINTS_SENSEX=80
FLOW_ALERT_TARGET_POINTS_BANKNIFTY=80
FLOW_ALERT_BREAK_BUFFER=2
```
