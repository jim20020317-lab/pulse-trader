'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
assert.ok(script, 'index.html must contain an inline script');
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(script[1], sandbox, { filename: 'index.html#inline-engine' });
const TradingEngine = sandbox.module.exports;
assert.equal(typeof TradingEngine, 'function', 'inline script must export TradingEngine');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`PASS ${name}`);
}
function engine(options = {}) {
  return new TradingEngine({ warmupSeconds: 0, ...options });
}
function drivePrices(instance, prices) {
  let index = 0;
  instance._advancePrice = function advanceFixedPrice() {
    this._price = prices[index++];
    this._time += 1;
  };
}
function closeWithPrice(side, exitPrice, opts = {}) {
  const instance = engine({ initialPrice: 100 });
  instance.openPosition(side, { sizePercent: 10, ...opts });
  return instance.closePosition('manual', exitPrice);
}

check('seed replay, volatility changes, and positive prices', () => {
  const a = engine({ seed: 711, warmupSeconds: 120 });
  const b = engine({ seed: 711, warmupSeconds: 120 });
  const before = a.getCandles('1s');
  assert.deepEqual(a.getCandles('1s'), b.getCandles('1s'));
  a.step(180);
  b.step(180);
  assert.deepEqual(a.getCandles('1s'), b.getCandles('1s'));
  const existing = a.getCandles('1s');
  a.volatility = 0.03;
  assert.deepEqual(a.getCandles('1s'), existing, 'changing volatility must not rewrite recorded history');
  a.step(500);
  assert.ok(a.price > 0);
  assert.ok(a.getCandles('1s').every((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0));
  assert.ok(before.length > 1);
});

check('1s OHLC records movement and 1m candles aggregate the same ticks', () => {
  const instance = engine({ volatility: 0.001 });
  const prices = Array.from({ length: 180 }, (_, i) => 100 + Math.sin(i / 3) * 15 + Math.cos(i / 11) * 4);
  drivePrices(instance, prices);
  instance.step(180);
  const seconds = instance.getCandles('1s', 500);
  assert.ok(seconds.some((c) => c.high > c.open || c.low < c.open), '1s candle should capture price movement');
  const expected = [];
  for (let i = 0; i < seconds.length; i += 60) {
    const group = seconds.slice(i, i + 60);
    expected.push({
      time: Math.floor(group[0].time / 60) * 60,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close
    });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(instance.getCandles('1m', 500))), expected);
});

check('SMA 5/10 and 20-point population Z-score', () => {
  const instance = engine();
  const candles = Array.from({ length: 25 }, (_, i) => ({ close: i + 1 }));
  const indicators = instance.getIndicators(candles);
  assert.equal(indicators.ma5[3], null);
  assert.equal(indicators.ma5[4], 3);
  assert.equal(indicators.ma10[8], null);
  assert.equal(indicators.ma10[9], 5.5);
  assert.equal(indicators.zscore[18], null);
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  const mean = 10.5;
  const populationStd = Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 20);
  assert.ok(Math.abs(indicators.zscore[19] - (20 - mean) / populationStd) < 1e-12);
  assert.equal(instance.getIndicators(Array.from({ length: 20 }, () => ({ close: 7 }))).zscore[19], 0);
});

check('one position lock and blank size defaults to 10%', () => {
  const instance = engine();
  const position = instance.openPosition('long', { sizePercent: null });
  assert.equal(position.sizePercent, 10);
  assert.equal(position.notional, 1000);
  assert.throws(() => instance.openPosition('short'), /已有未平倉/);
});

check('rejects invalid size and TP/SL values', () => {
  for (const value of [0, 101, Number.NaN]) {
    assert.throws(() => engine().openPosition('long', { sizePercent: value }), /部位大小/);
  }
  for (const field of ['tpPercent', 'slPercent']) {
    for (const value of [0, 100, Number.NaN]) {
      assert.throws(() => engine().openPosition('long', { [field]: value }), /百分比/);
    }
  }
});

check('long and short PnL use direction-correct fills', () => {
  const long = closeWithPrice('long', 110);
  const short = closeWithPrice('short', 110);
  assert.equal(long.pnl, 100);
  assert.equal(short.pnl, -100);
  assert.equal(closeWithPrice('short', 90).pnl, 100);
  assert.equal(closeWithPrice('long', 90).pnl, -100);
});

check('automatic TP and SL fill at exact thresholds for long and short', () => {
  const cases = [
    ['long', 'tpPercent', 101, 'tp'], ['long', 'slPercent', 99, 'sl'],
    ['short', 'tpPercent', 99, 'tp'], ['short', 'slPercent', 101, 'sl']
  ];
  for (const [side, field, nextPrice, reason] of cases) {
    const instance = engine();
    instance.openPosition(side, { [field]: 1 });
    drivePrices(instance, [nextPrice]);
    instance.step();
    assert.equal(instance.trades.length, 1);
    assert.equal(instance.trades[0].reason, reason);
    assert.equal(instance.trades[0].exitPrice, nextPrice);
  }
});

check('first crossed threshold wins when a tick crosses both targets', () => {
  const instance = engine();
  instance.openPosition('long', { tpPercent: 1, slPercent: 1 });
  instance._checkPosition(98, 102);
  assert.equal(instance.trades[0].reason, 'sl');
  assert.equal(instance.trades[0].exitPrice, 99);
});

check('closing at a paused timestamp updates history without duplicate times', () => {
  const instance = engine();
  instance.openPosition('long');
  instance.closePosition('manual', 101);
  const history = instance.equityHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].time, 0);
  assert.equal(history[0].realizedPnl, 10);
  assert.equal(new Set(history.map((p) => p.time)).size, history.length);
});

check('rejects new positions after equity reaches zero', () => {
  const instance = engine();
  instance.openPosition('long', { sizePercent: 100 });
  instance.closePosition('manual', 0);
  assert.equal(instance.balance, 0);
  assert.throws(() => instance.openPosition('short'), /餘額為 0/);
});

check('caps equity history and tick memory', () => {
  const instance = engine({ volatility: 0 });
  instance.step(12010);
  assert.ok(instance.equityHistory.length <= 5000);
  assert.ok(instance._ticks.length <= 10000);
});

check('interval changes retain an open position', () => {
  const instance = engine({ seed: 92 });
  instance.openPosition('short');
  const position = instance.position;
  instance.getCandles('1s');
  instance.getCandles('1m');
  assert.deepEqual(instance.position, position);
});

console.log(`\n${checks} engine checks passed against index.html inline script.`);
