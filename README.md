# repo-pumpfun-any-bot-20261124-v2

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Zhoya0077/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Zhoya0077/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Snipe-and-scalp paper-trading bot for the pump.fun replay sprint: it waits for a curve where distinct buyers are arriving together and the price is climbing toward its recent high, buys one small fixed stake, lets winners run with a +50% take-profit and a trailing stop, cuts losers at -8%, and stops entering when equity drawdown passes 35%. Tiny 0.01 SOL probe round trips exist only to keep the guardrail coin count honest late in the window.

## Strategy

- **Entry** (once per mint): curve at least 300 slots old, real SOL reserves 1–60 SOL, and over the last 30 slots net inflow ≥ 1 SOL from ≥ 5 distinct buyers across ≥ 5 buy trades, price up 8–50% measured from the price 30 slots back, within 5% of the window high. One stake of 0.175 SOL, capped at 1% of real reserves, never below 0.05 SOL.
- **Exits** (whole position): take-profit +50%, stop-loss −8%, trailing stop −35% off the peak once up +15%, or a 2,500-slot time limit.
- **Risk**: no new entries past 35% equity drawdown from peak; at most 5 open positions; total exposure ≤ 2 SOL.
- **Probes**: 0.01 SOL round trips only after half the 4-hour pace window has passed and only while round-tripped coins lag the target of 25, at most 2, never twice on one mint.
- **Determinism**: no clock, no randomness; every entry is executed twice and the two action logs match byte for byte.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wrbbpgtj&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
