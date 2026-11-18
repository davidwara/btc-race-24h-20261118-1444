// Dip-buy BTC bot, retuned for the falling dev window: buys a sharp dip below the
// 2h EMA with NO uptrend regime filter, then exits on a +2.0% take-profit or a 1.0%
// trailing stop from the peak close. Long only, one position, full size, and at most
// ONE round trip per window: after the first completed round trip the bot stops
// entering, because in both 24h windows the profit came from a single V-shaped
// recovery and every later trade bled in the grind-down that followed.
//
// Why this shape: the dev window fell -2.80% ($65,083 -> $63,261) with one deep
// V (dip to ~$63,100, recovery past $65,100). The old bot (0.25% dip, uptrend
// regime, +1.5% TP) lost -$7.16 here: its regime filter barely let it trade and
// its shallow dip caught the falling knife early. Dropping the regime filter and
// deepening the dip to 0.75% below the slow EMA catches only the real dislocation,
// and the +2.0% take-profit banks the full V. The trailing stop caps a loser at
// ~1% below its peak. Stopping after one round trip keeps the second, losing
// trade of the grind-down half out entirely.
//
// Dev window (grade-local --driver process, verified): +$16.52 net PnL, 1 round
// trip (buy bar 119 @ $63,724 -> sell bar 505 @ $65,046 TP). Same parameters on
// the previous race's dev window: +$16.80, also 1 round trip. So the result is
// not a knife-edge optimum on one window: the same single-trade shape wins on
// both, while the unlimited version of it makes +$8.72 / +$18.18 (its second
// trade loses -$7.80 on this window). Round-trip cost ~26 bps at full size.
//
// The bot tracks the position from the account the harness reports, never from
// a flag of its own: if a buy were ever rejected (cash, caps, slippage), the
// bookkeeping is dropped and the next dip can be entered, instead of the bot
// wedging itself out of every later trade. A sell the market refuses is sent
// again on the next bar while the position is still held; the round-trip counter
// counts each exit once, so a re-sent sell never double-counts.
//
// Deterministic: no clock, no environment, no randomness. EMAs are float64, seeded
// as the mean of their first span of closes, exactly like the published EMA
// baselines, so two runs on the same bars give the same orders.

import { runBars, type BarsState } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 30; // 30 minutes
const SLOW_SPAN = 120; // 2 hours
const DIP_BPS = 75; // enter 0.75% below the slow EMA (no regime filter)
const TRAIL_BPS = 100; // exit 1.0% below the peak close since entry
const TAKE_PROFIT_BPS = 200; // exit 2.0% above the entry close
const COOLDOWN_BARS = 30; // bars to wait after an exit before re-entering
const MAX_ROUND_TRIPS = 1; // stop entering after the first completed round trip
const MAX_SLIPPAGE_BPS = 10_000; // wide open: 1m bars barely gap, never get rejected

// One EMA: seeded as the mean of its first span of closes, then moves 2/(span+1)
// of the way to each new close.
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function makeEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function stepEma(e: Ema, close: number): number | null {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return e.value;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  return e.value;
}

const fast = makeEma(FAST_SPAN);
const slow = makeEma(SLOW_SPAN);
let peak = 0; // highest close since entry, in dollars
let entry = 0; // entry close, in dollars
let cool = 0; // bars of cooldown left after an exit
let armed = false; // a buy was decided and not yet seen filled
let roundTrips = 0; // completed round trips (exits issued once each)
let selling = false; // a sell for the live position has been issued

await runBars({
  onBatch(state: BarsState) {
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig) / 1e5;
    const fv = stepEma(fast, close);
    const sv = stepEma(slow, close);
    if (fv === null || sv === null) return [];
    if (cool > 0) cool -= 1;
    const held = state.positions.get(SYMBOL)?.qty ?? 0n;
    if (held > 0n) {
      // A position is live: manage the exit.
      if (close > peak) peak = close;
      const trailHit = close < peak * (1 - TRAIL_BPS / 10000);
      const tpHit = close >= entry * (1 + TAKE_PROFIT_BPS / 10000);
      if (trailHit || tpHit) {
        if (!selling) {
          roundTrips += 1;
          selling = true;
          cool = COOLDOWN_BARS;
        }
        return [{ side: 'sell', symbol: SYMBOL, qty: held, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    // No position: a sell that filled clears the selling flag; a buy decided but
    // never filled leaves no bookkeeping behind.
    selling = false;
    if (armed) armed = false;
    if (cool > 0) return [];
    // One round trip per window: bank the V and stop, don't bleed in the grind.
    if (roundTrips >= MAX_ROUND_TRIPS) return [];
    // Deep dip below the slow EMA, no regime filter: in a falling window the
    // fast EMA sits below the slow one most of the time, so requiring an
    // uptrend would mean almost never trading at all.
    if (close < sv * (1 - DIP_BPS / 10000)) {
      armed = true;
      peak = close;
      entry = close;
      if (state.cash === 0n) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
