// The price a seller types, and the price the protocol fills against.
//
// The market page takes "0.5 XVG per coin" and has to turn it into an order the node fills with,
// which counts in XVG atomic units per ATOMIC rune unit. That conversion is a divisibility factor,
// and every divisibility factor on this project has been got wrong at least once: a balance shown a
// hundred times too big and a price shown a hundred times too small, in the same afternoon.
//
// So this runs the PAGE'S arithmetic and the NODE'S side by side and requires them to agree, rather
// than checking either against a number somebody wrote down.
//
// Run: node test/runes-trade-price.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { priceFor: nodePriceFor } = require('../src/runes/order');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };
const COIN = 1e6;

/** The page's own functions, executed rather than reimplemented. */
function pageMath() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'runes-trade.js'), 'utf8');
  const grab = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `${name} could not be located in runes-trade.js`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`${name} is not closed`);
  };
  // eslint-disable-next-line no-new-func
  return new Function('COIN',
    grab('priceRatio') + grab('perCoin') + grab('priceFor')
    + '\nreturn { priceRatio, perCoin, priceFor };')(COIN);
}
const page = pageMath();

test('THE ROUND TRIP: what you type is what one coin costs', () => {
  for (const div of [0, 1, 2, 3, 6]) {
    for (const xvg of [0.000001, 0.001, 0.5, 1, 20, 1234.5]) {
      const ratio = page.priceRatio(xvg, div);
      assert.strictEqual(page.perCoin(ratio, div), Math.round(xvg * COIN),
        `${xvg} XVG per coin at ${div} decimals must come back as itself`);
    }
  }
});

test('both sides of the ratio are whole numbers, at every divisibility', () => {
  // A ratio is used rather than a single number for exactly this: a coin with six decimals sold at
  // a thousandth of an XVG needs a third of an atomic unit if the division happens too early.
  for (const div of [0, 1, 2, 3, 6]) {
    const r = page.priceRatio(0.001, div);
    assert.ok(Number.isInteger(r.units) && Number.isInteger(r.per), `${div} decimals gave ${JSON.stringify(r)}`);
    assert.ok(r.units > 0 && r.per > 0);
  }
});

test('the page and the node compute the same bill, to the unit', () => {
  const cases = [
    { div: 2, xvg: 0.3, coins: 110 },
    { div: 2, xvg: 0.3, coins: 1 },
    { div: 0, xvg: 5, coins: 3 },
    { div: 6, xvg: 0.000001, coins: 1 },
    { div: 6, xvg: 12.5, coins: 0.000001 },
    { div: 3, xvg: 7.25, coins: 1234.567 },
  ];
  for (const c of cases) {
    const ratio = page.priceRatio(c.xvg, c.div);
    const atomic = Math.round(c.coins * Math.pow(10, c.div));
    const order = { minPrice: ratio };
    assert.strictEqual(page.priceFor(order, atomic), nodePriceFor(order, atomic),
      `page and node disagree on ${c.coins} at ${c.xvg} XVG, ${c.div} decimals`);
  }
});

test('A WHOLE COIN COSTS WHAT WAS ASKED, which is the number on the screen', () => {
  // 0.3 XVG for one ALPHA, a two-decimal coin. The listing screen says 0.3 and the bill for one
  // coin has to be 0.3, or somebody signs for a hundred times what they read.
  const ratio = page.priceRatio(0.3, 2);
  assert.strictEqual(nodePriceFor({ minPrice: ratio }, 100), 300000, '0.3 XVG in atomic XVG');
  assert.strictEqual(nodePriceFor({ minPrice: ratio }, 100) / COIN, 0.3);
});

test('CONTROL: dropping the divisibility from the ratio is caught', () => {
  // The mistake this file is here to prevent, made deliberately.
  const wrong = { units: Math.round(0.3 * COIN), per: 1 };
  assert.notStrictEqual(nodePriceFor({ minPrice: wrong }, 100), 300000);
  assert.strictEqual(nodePriceFor({ minPrice: wrong }, 100), 30000000, 'a hundredfold overcharge');
});

test('the bill rounds UP, so a seller is never paid a unit short', () => {
  // 1 XVG for a 3-decimal coin is 1000 atomic XVG per atomic unit... but ask for a price that does
  // not divide, and the fraction has to land in the seller's favour.
  const ratio = page.priceRatio(1, 3);
  const one = nodePriceFor({ minPrice: ratio }, 1);
  assert.strictEqual(one, page.priceFor({ minPrice: ratio }, 1));
  assert.ok(one * 1000 >= COIN, 'a thousand of them covers the whole coin');
});

test('a price too small to express rounds to nothing and is refused, not silently zero', () => {
  // The page checks units <= 0 before it offers to publish. Half a millionth of an XVG is below
  // what an XVG can represent, and an order at zero would be a gift.
  assert.strictEqual(page.priceRatio(0.0000004, 2).units, 0);
  assert.strictEqual(page.priceRatio(0.000001, 2).units, 1);
});

console.log(`\n${passed} trade price tests passed`);
