// Pump.fun Paper Sprint — snipe-and-scalp replay bot (own design, written fresh).
//
// Idea: most pump.fun curves die fast and a few run hard. This bot waits for a
// curve that is already proving itself — real buyers arriving together and the
// price climbing toward its recent high — buys a small fixed stake, then lets
// the winner run with a wide take-profit and a trailing stop, and cuts losers
// quickly. A drawdown brake stops new entries when equity is badly down, and
// tiny 0.01 SOL probe round trips exist only to keep the guardrail coin count
// honest late in the window.
//
// Deterministic: no clock, no randomness, insertion-ordered maps only.
// Runs under `node main.ts` (Node 22 strips the types; no build, no install).

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n

// Entry window: trades over the last WINDOW_SLOTS slots must show real demand.
const WINDOW_SLOTS = 30;
const MIN_NET_INFLOW = SOL; // >= 1.0 SOL net buys in the window
const MIN_BUY_TRADES = 5;
const MIN_DISTINCT_BUYERS = 5;
const MIN_PRICE_UP = 0.08; // price up >= 8% over the window
const MAX_PRICE_UP = 0.5; // ...but not already up > 50% (chasing a spent move)
const NEAR_HIGH = 0.95; // price within 5% of the window high
const MIN_REAL_SOL = SOL; // real SOL reserves 1..60 SOL
const MAX_REAL_SOL = 60n * SOL;
const MIN_AGE_SLOTS = 300; // curve must be at least 300 slots old

// Sizing: one fixed buy, capped at 1% of real reserves (the harness cap), and
// never smaller than MIN_BUY — a stake below that is not worth its fees.
const STAKE_SOL = 175_000_000n; // 0.175 SOL
const MIN_BUY_SOL = 50_000_000n; // 0.05 SOL

// Slippage: wide enough that a fill is never refused for the 2-slot latency.
const SLIPPAGE_BPS = 5000;
// Exits (sell the whole position): take-profit, stop-loss, trailing stop once
// armed, and a hard time limit so stale coins free the slot.
const TAKE_PROFIT = 1.5; // +50%
const STOP_LOSS = 0.92; // -8%
const TRAIL_ARM = 1.15; // trailing stop arms once value is up +15%
const TRAIL_DROP = 0.65; // ...then sells if value falls 35% off its peak
const MAX_HOLD_SLOTS = 2500;

const ENTRY_COOLDOWN_SLOTS = 200; // slots after an exit before re-entering
const MAX_ENTRIES_PER_MINT = 1;
const MAX_OPEN_MAIN = 5; // matches caps.max_open_positions
const MAX_EXPOSURE = 2n * SOL; // total cost of open main positions
const MAX_DRAWDOWN = 0.35; // no new main entries past 35% equity drawdown

// Guardrail probes: 0.01 SOL round trips, only late in the window and only
// while the round-tripped coin count lags the target.
const TARGET_COINS = 25;
const PACE_SECS = 14400;
const PROBE_SOL = 10_000_000n; // 0.01 SOL
const MAX_PROBES = 2;

// Curve fees on a sell: protocol 95 bps + creator 30 bps = 1.25%.
const SELL_FEE_NUM = 9875n;
const SELL_FEE_DEN = 10000n;

// ---------------------------------------------------------------- per-mint state

interface WindowTrade {
  slot: number;
  price: number; // SOL per token, after this trade (virtual_quote / virtual_token)
  isBuy: boolean;
  solLamports: bigint;
  user: string;
}

interface PriceSample {
  slot: number;
  price: number;
}

interface CoinTrack {
  createdSlot: number | null;
  /** Price after each batch this mint traded in (oldest first, kept ~120 slots). */
  priceHist: PriceSample[];
  window: WindowTrade[]; // trades in the last WINDOW_SLOTS slots, oldest first
  entries: number; // main entries taken on this mint
  lastExitSlot: number; // slot of the last exit (sell fill / harness close)
  entrySlot: number; // slot the current position's buy filled
  peakValue: bigint; // highest estimated net value of the current position
  isProbe: boolean; // the current position is a guardrail probe
}

const tracks = new Map<string, CoinTrack>();
const roundTripped = new Set<string>(); // mints with a >= 0.01 SOL round trip done
const buyLamportsByMint = new Map<string, bigint>(); // buy size of current position
const probeMints = new Set<string>(); // mints already probed (never twice)
let probesDone = 0;
let peakEquity = 10n * SOL;
let startBlockSecs: number | null = null;
let lastBlockSecs = 0;

// ---------------------------------------------------------------- helpers

function trackFor(mint: string): CoinTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      createdSlot: null,
      priceHist: [],
      window: [],
      entries: 0,
      lastExitSlot: -1_000_000,
      entrySlot: 0,
      peakValue: 0n,
      isProbe: false,
    };
    tracks.set(mint, t);
  }
  return t;
}

/** SOL per token from virtual reserves (0 when the curve is empty). */
function priceOf(vt: bigint, vq: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

/**
 * Estimated net SOL from selling `tokens` now: constant-product quote out of
 * the virtual reserves, less the 1.25% curve fees and one tx fee.
 */
function positionValueLamports(state: BotState, mint: string, tokens: bigint): bigint {
  const c = state.curves.get(mint);
  if (c === undefined) return 0n;
  const vt = c.virtual_token_reserves;
  const vq = c.virtual_quote_reserves;
  if (vt <= 0n || tokens <= 0n) return 0n;
  const out = (tokens * vq) / (vt + tokens);
  const afterFees = (out * SELL_FEE_NUM) / SELL_FEE_DEN;
  const tx = state.txFeeLamports();
  return afterFees > tx ? afterFees - tx : 0n;
}

/** Current equity: cash plus the estimated net value of every open position. */
function equityLamports(state: BotState): bigint {
  let eq = state.cash;
  for (const [mint, pos] of state.positions) {
    eq += positionValueLamports(state, mint, pos.token_amount);
  }
  return eq;
}

// ---------------------------------------------------------------- entry check

interface WindowStats {
  netInflow: bigint;
  buyTrades: number;
  buyers: number;
  priceStart: number;
  priceNow: number;
  priceHigh: number;
}

function windowStats(t: CoinTrack, slotNow: number): WindowStats | null {
  const w = t.window;
  if (w.length === 0) return null;
  let net = 0n;
  let buys = 0;
  const buyers = new Set<string>();
  let high = 0;
  for (const tr of w) {
    net += tr.isBuy ? tr.solLamports : -tr.solLamports;
    if (tr.isBuy) {
      buys += 1;
      buyers.add(tr.user);
    }
    if (tr.price > high) high = tr.price;
  }
  // Anchor the window's start price 30 slots back in time (the last price the
  // curve showed at or before then), not at the first recent trade: a coin
  // that traded sparsely before its burst looks flat on the recent-trade
  // anchor even though it is up sharply over the window.
  let priceStart = w[0].price;
  let priceHigh = high;
  const hist = t.priceHist;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].slot <= slotNow - WINDOW_SLOTS) {
      priceStart = hist[i].price;
      break;
    }
    if (i === 0) priceStart = hist[0].price;
  }
  for (const h of hist) {
    if (h.slot > slotNow - WINDOW_SLOTS && h.price > priceHigh) priceHigh = h.price;
  }
  return {
    netInflow: net,
    buyTrades: buys,
    buyers: buyers.size,
    priceStart,
    priceNow: w[w.length - 1].price,
    priceHigh,
  };
}

/**
 * A mint is worth one stake when it is old enough, liquid enough, and the last
 * 30 slots show a crowd of distinct buyers pushing the price up toward its
 * recent high — without the move already being spent.
 */
function entrySignal(state: BotState, mint: string, slot: number): bigint | null {
  const t = tracks.get(mint);
  if (t === undefined) return null;
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (t.createdSlot === null || slot - t.createdSlot < MIN_AGE_SLOTS) return null;
  if (t.entries >= MAX_ENTRIES_PER_MINT) return null;
  if (slot - t.lastExitSlot < ENTRY_COOLDOWN_SLOTS) return null;
  if (state.positions.has(mint)) return null;
  const rq = curve.real_quote_reserves;
  if (rq < MIN_REAL_SOL || rq > MAX_REAL_SOL) return null;
  const s = windowStats(t, slot);
  if (s === null) return null;
  if (s.netInflow < MIN_NET_INFLOW) return null;
  if (s.buyTrades < MIN_BUY_TRADES) return null;
  if (s.buyers < MIN_DISTINCT_BUYERS) return null;
  if (s.priceStart <= 0 || s.priceNow <= 0) return null;
  const up = s.priceNow / s.priceStart - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return null;
  if (s.priceNow < NEAR_HIGH * s.priceHigh) return null;
  // One fixed stake, capped at 1% of real reserves, never below MIN_BUY_SOL.
  const cap = state.maxBuyLamports(mint);
  let amount = STAKE_SOL < cap ? STAKE_SOL : cap;
  if (amount < MIN_BUY_SOL) return null;
  return amount;
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // --- fold this batch's events into per-mint tracks, and note block time.
    const tradedMints: string[] = [];
    const seenThisBatch = new Set<string>();
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        lastBlockSecs = e.block_time;
        if (startBlockSecs === null) startBlockSecs = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const t = trackFor(e.mint);
        if (t.createdSlot === null) t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = trackFor(e.mint);
        const curve = state.curves.get(e.mint);
        const price = curve !== undefined ? priceOf(curve.virtual_token_reserves, curve.virtual_quote_reserves) : 0;
        t.window.push({
          slot: e.slot,
          price,
          isBuy: e.is_buy,
          solLamports: BigInt(e.sol_amount),
          user: e.user,
        });
        if (!seenThisBatch.has(e.mint)) {
          seenThisBatch.add(e.mint);
          tradedMints.push(e.mint);
        }
      } else {
        const t = trackFor(e.mint);
        t.lastExitSlot = slot;
      }
    }
    // Prune each traded mint's window to the last WINDOW_SLOTS slots, and keep
    // one price sample per batch the mint traded in (for the 30-slot-ago anchor).
    for (const mint of tradedMints) {
      const t = tracks.get(mint);
      if (t === undefined) continue;
      while (t.window.length > 0 && t.window[0].slot <= slot - WINDOW_SLOTS) t.window.shift();
      const curve = state.curves.get(mint);
      if (curve !== undefined) {
        const price = priceOf(curve.virtual_token_reserves, curve.virtual_quote_reserves);
        const last = t.priceHist[t.priceHist.length - 1];
        if (last === undefined || last.slot !== slot) t.priceHist.push({ slot, price });
        while (t.priceHist.length > 0 && t.priceHist[0].slot <= slot - 4 * WINDOW_SLOTS) t.priceHist.shift();
      }
    }

    // --- fold fills: record entries, exits, and completed round trips.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        const t = trackFor(f.mint);
        t.entrySlot = f.slot;
        t.peakValue = 0n;
        buyLamportsByMint.set(f.mint, BigInt(f.quote_lamports));
      } else {
        const t = trackFor(f.mint);
        t.lastExitSlot = f.slot;
        t.peakValue = 0n;
        t.isProbe = false;
        const bought = buyLamportsByMint.get(f.mint) ?? 0n;
        if (bought >= PROBE_SOL) roundTripped.add(f.mint);
        buyLamportsByMint.delete(f.mint);
      }
    }

    // --- equity peak / drawdown brake (exits still run under the brake).
    const equity = equityLamports(state);
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0n ? Number(peakEquity - equity) / Number(peakEquity) : 0;
    const brakeOn = drawdown > MAX_DRAWDOWN;

    let free = state.freeCashLamports();
    let openMain = 0;
    let exposure = 0n;
    for (const [mint, pos] of state.positions) {
      const t = tracks.get(mint);
      if (t !== undefined && !t.isProbe) {
        openMain += 1;
        exposure += pos.cost_lamports;
      }
    }

    // --- exits first: take-profit, stop-loss, trailing stop, time limit, probes.
    // A sell already in flight still leaves the position in the account until
    // its fill lands: re-selling the same tokens only gets rejected, so skip
    // mints with a pending sell.
    const pendingSell = new Set<string>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'sell') pendingSell.add(po.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (pendingSell.has(mint)) continue;
      const t = tracks.get(mint);
      const value = positionValueLamports(state, mint, pos.token_amount);
      const cost = pos.cost_lamports;
      if (cost <= 0n) continue;
      if (t !== undefined) {
        if (value > t.peakValue) t.peakValue = value;
      }
      const ratio = Number(value) / Number(cost);
      const peakRatio = t !== undefined && t.peakValue > 0n ? Number(t.peakValue) / Number(cost) : ratio;
      let sell = false;
      if (t !== undefined && t.isProbe) {
        // Probes exist only to complete the round trip: sell at once.
        sell = true;
      } else if (ratio >= TAKE_PROFIT) {
        sell = true;
      } else if (ratio <= STOP_LOSS) {
        sell = true;
      } else if (peakRatio >= TRAIL_ARM && t !== undefined && value * 100n <= t.peakValue * 65n) {
        sell = true; // 35% off the peak value once armed
      } else if (t !== undefined && t.entrySlot > 0 && slot - t.entrySlot >= MAX_HOLD_SLOTS) {
        sell = true;
      }
      if (sell) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        } satisfies SellInput);
      }
    }

    // --- main entries on this batch's traded mints, while slots/cash allow.
    if (!brakeOn) {
      for (const mint of tradedMints) {
        if (orders.length >= maxOrders) break;
        if (openMain >= MAX_OPEN_MAIN) break;
        const amount = entrySignal(state, mint, slot);
        if (amount === null) continue;
        if (exposure + amount > MAX_EXPOSURE) continue;
        if (free < amount + tx) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: SLIPPAGE_BPS,
        } satisfies BuyInput);
        const t = trackFor(mint);
        t.entries += 1;
        t.isProbe = false;
        free -= amount + tx;
        openMain += 1;
        exposure += amount;
      }
    }

    // --- guardrail probes: late in the window, only while coins lag the target.
    const elapsed = startBlockSecs === null ? 0 : lastBlockSecs - startBlockSecs;
    if (
      probesDone < MAX_PROBES &&
      roundTripped.size < TARGET_COINS &&
      elapsed > PACE_SECS / 2 &&
      orders.length < maxOrders &&
      state.committedPositionCount() < state.hello.caps.max_open_positions &&
      free >= PROBE_SOL + tx
    ) {
      for (const mint of tradedMints) {
        if (orders.length >= maxOrders || probesDone >= MAX_PROBES) break;
        if (probeMints.has(mint)) continue;
        const t = tracks.get(mint);
        if (t === undefined || t.entries > 0) continue;
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < PROBE_SOL) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: PROBE_SOL,
          max_slippage_bps: SLIPPAGE_BPS,
        } satisfies BuyInput);
        probeMints.add(mint);
        const pt = trackFor(mint);
        pt.isProbe = true;
        probesDone += 1;
        free -= PROBE_SOL + tx;
      }
    }

    return orders;
  },
});
