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
function candles(instance) {
  return JSON.parse(JSON.stringify(instance.getCandles('1s', 10000)));
}
function returns(instance, count) {
  const values = [];
  for (let i = 0; i < count; i += 1) {
    const previous = instance.price;
    instance.step();
    values.push(Math.log(instance.price / previous) / instance.volatility);
  }
  return values;
}

const models = ['normal', 'student', 'garch', 'jump'];
check('model API exposes the four documented distributions', () => {
  const instance = engine();
  assert.equal(instance.model, 'normal');
  assert.equal(instance.lastJump, 0);
  for (const model of models) {
    instance.model = model;
    assert.equal(instance.model, model);
  }
  assert.throws(() => { instance.model = 'unknown'; }, /模型|model|分布/i);
  assert.equal(instance.model, 'jump', 'invalid assignment must preserve the selected model');
});

check('each model is deterministic, positive, and records valid OHLC', () => {
  for (const model of models) {
    const a = engine({ seed: 811, model });
    const b = engine({ seed: 811, model });
    a.step(1200);
    b.step(1200);
    assert.equal(a.price, b.price, `${model} price must replay from the same seed`);
    assert.deepEqual(candles(a), candles(b), `${model} candles must replay from the same seed`);
    assert.ok(a.price > 0 && Number.isFinite(a.price));
    assert.ok(candles(a).every((c) => c.open > 0 && c.low > 0 && c.high >= c.low && c.close > 0));
  }
  const paths = models.map((model) => engine({ seed: 4, model }).step(200));
  assert.equal(new Set(paths).size, models.length, 'different distributions should produce distinguishable seeded paths');
});

check('model changes preserve session state and same-model assignment preserves RNG', () => {
  const a = engine({ seed: 940, model: 'normal' });
  const b = engine({ seed: 940, model: 'normal' });
  a.step(30);
  b.step(30);
  const before = { time: a.time, price: a.price, candles: candles(a), balance: a.balance };
  a.openPosition('long', { tpPercent: 30, slPercent: 30 });
  const position = a.position;
  const balance = a.balance;
  const trades = a.trades;
  const history = a.equityHistory;
  const retainedCandles = candles(a);
  a.model = 'normal';
  assert.equal(a.price, before.price);
  assert.deepEqual(candles(a), before.candles);
  a.model = 'student';
  assert.equal(a.time, before.time);
  assert.equal(a.balance, balance);
  assert.deepEqual(a.position, position);
  assert.deepEqual(a.trades, trades);
  assert.deepEqual(a.equityHistory, history);
  assert.deepEqual(candles(a), retainedCandles);

  a.model = 'normal';
  const expected = b.step();
  const actual = a.step();
  assert.equal(actual, expected, 'assigning the current model must not consume or reset RNG state');
});

check('model changes retain time, price, and prior candles', () => {
  const instance = engine({ seed: 12, model: 'garch' });
  instance.step(50);
  const state = { time: instance.time, price: instance.price, candles: candles(instance) };
  instance.model = 'jump';
  assert.equal(instance.time, state.time);
  assert.equal(instance.price, state.price);
  assert.deepEqual(candles(instance), state.candles);
  assert.ok(instance.step() > 0);
});

check('changing volatility is valid and applies to subsequent steps', () => {
  const instance = engine({ seed: 6, model: 'student', volatility: 0.0006 });
  instance.step(10);
  const oldPrice = instance.price;
  instance.volatility = 0.0012;
  assert.equal(instance.volatility, 0.0012);
  instance.step();
  assert.ok(instance.price > 0 && Number.isFinite(instance.price));
  assert.notEqual(instance.price, oldPrice);
  assert.throws(() => { instance.volatility = -1; }, /波動率/);
});

check('student-t returns are variance-standardized and have heavier tails', () => {
  const sample = returns(engine({ seed: 418, model: 'student', volatility: 0.0006 }), 40000);
  const mean = sample.reduce((sum, x) => sum + x, 0) / sample.length;
  const variance = sample.reduce((sum, x) => sum + (x - mean) ** 2, 0) / sample.length;
  const tailRate = sample.filter((x) => Math.abs(x) > 3).length / sample.length;
  assert.ok(variance > 0.85 && variance < 1.15, `standardized t variance ${variance} should be near 1`);
  assert.ok(tailRate > 0.006, `student tail rate ${tailRate} should exceed Gaussian tail rate`);
});

check('GARCH squared returns cluster more than normal returns', () => {
  function squaredReturnAutocorrelation(model) {
    const sample = returns(engine({ seed: 221, model, volatility: 0.0006 }), 30000).map((x) => x * x);
    const mean = sample.reduce((sum, x) => sum + x, 0) / sample.length;
    let numerator = 0;
    let denominator = 0;
    for (let i = 1; i < sample.length; i += 1) {
      numerator += (sample[i] - mean) * (sample[i - 1] - mean);
      denominator += (sample[i] - mean) ** 2;
    }
    return numerator / denominator;
  }
  const normalCorrelation = squaredReturnAutocorrelation('normal');
  const garchCorrelation = squaredReturnAutocorrelation('garch');
  assert.ok(garchCorrelation > 0.04, `GARCH squared-return autocorrelation ${garchCorrelation} should show clustering`);
  assert.ok(garchCorrelation > normalCorrelation + 0.03, `GARCH (${garchCorrelation}) should cluster more than normal (${normalCorrelation})`);
});

check('jump model records reproducible nonzero jumps', () => {
  const a = engine({ seed: 389, model: 'jump' });
  const b = engine({ seed: 389, model: 'jump' });
  let foundJump = false;
  for (let i = 0; i < 5000; i += 1) {
    a.step();
    b.step();
    assert.equal(a.price, b.price);
    assert.equal(a.lastJump, b.lastJump);
    if (a.lastJump !== 0) foundJump = true;
  }
  assert.ok(foundJump, 'a 1/600-per-second jump process should produce at least one jump in 5000 seeded steps');
});

check('jump-gap stop losses fill at the post-jump price and report slippage', () => {
  for (const [side, after] of [['long', 97], ['short', 103]]) {
    const instance = engine({ model: 'jump' });
    instance.openPosition(side, { slPercent: 1 });
    instance._checkJumpPosition(100, after);
    assert.equal(instance.trades.length, 1);
    assert.equal(instance.trades[0].reason, 'sl');
    assert.equal(instance.trades[0].exitPrice, after);
    assert.equal(instance.trades[0].slippage, 2);
  }
});

check('jump-gap take profits fill at their threshold', () => {
  const long = engine({ model: 'jump' });
  long.openPosition('long', { tpPercent: 1 });
  long._checkJumpPosition(100, 103);
  assert.equal(long.trades[0].reason, 'tp');
  assert.equal(long.trades[0].exitPrice, 101);
  assert.equal(long.trades[0].slippage, 0);

  const short = engine({ model: 'jump' });
  short.openPosition('short', { tpPercent: 1 });
  short._checkJumpPosition(100, 97);
  assert.equal(short.trades[0].reason, 'tp');
  assert.equal(short.trades[0].exitPrice, 99);
  assert.equal(short.trades[0].slippage, 0);
});

check('jump candle includes the intermediate base price and a base-leg TP stays TP', () => {
  const instance = engine({ model: 'jump', volatility: 0.01 });
  instance.openPosition('long', { tpPercent: 0.5, slPercent: 5 });
  instance._studentT6 = () => 1;
  instance._random = () => 0;
  instance._normal = () => -2;
  instance.step();

  const candle = candles(instance).at(-1);
  const basePrice = 100 * Math.exp(0.01 * Math.sqrt(0.92));
  assert.ok(Math.abs(candle.high - basePrice) < 1e-10, 'OHLC high must equal the upward base leg within floating-point tolerance');
  assert.ok(candle.low < 95, 'OHLC low must include the downward jump leg');
  assert.ok(candle.close < candle.open, 'final candle close should reflect the downward jump');
  assert.equal(instance.trades.length, 1);
  assert.equal(instance.trades[0].reason, 'tp', 'a TP hit on the base leg must close before a later jump can hit SL');
  assert.ok(Math.abs(instance.trades[0].exitPrice - 100.5) < 1e-12);
});

check('jump gap crossing both short SL and liquidation fills the SL at post-jump price', () => {
  const instance = engine({ model: 'jump' });
  instance.openPosition('short', { sizePercent: 100, slPercent: 10 });
  // For this position, the stop is 110 and the liquidation level is 200.
  instance._checkJumpPosition(100, 250);
  const trade = instance.trades[0];
  assert.equal(instance.trades.length, 1);
  assert.equal(trade.reason, 'sl', 'the stop condition takes priority over liquidation');
  assert.equal(trade.exitPrice, 250);
  assert.equal(trade.slippage, 140);
  assert.equal(instance.balance, 0);
  assert.ok(trade.pnl >= -10000, 'loss must be capped at the starting balance');
});

check('jump liquidation caps losses at the account balance', () => {
  const instance = engine({ model: 'jump' });
  instance.openPosition('short', { sizePercent: 100 });
  instance._checkJumpPosition(100, 250);
  assert.equal(instance.trades.length, 1);
  assert.equal(instance.trades[0].reason, 'liquidation');
  assert.equal(instance.balance, 0);
  assert.ok(instance.trades[0].pnl >= -10000);
});

console.log(`\n${checks} model checks passed against index.html inline script.`);
