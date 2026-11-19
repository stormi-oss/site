// Проверка логики (курсы, округление, параметр, кэш, офлайн) в Node: node dev/test-logic.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const here = new URL('.', import.meta.url);
globalThis.__MOCK_LOG__ = [];
new Function(readFileSync(new URL('scriptable-mock.js', here), 'utf8'))();
globalThis.__PIXELFX_TEST__ = {};
const AF = Object.getPrototypeOf(async function () {}).constructor;
await new AF(readFileSync(new URL('../pixel-fx.js', here), 'utf8'))();
const X = globalThis.__PIXELFX_TEST__.exports;
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✓', name); };

const rates = { USD: { scale: 1, micro: '2987600' }, RUB: { scale: 100, micro: '3712000' }, KZT: { scale: 1000, micro: '5793000' }, CNY: { scale: 10, micro: '4195000' } };
ok('Cur_Scale: 100 RUB = 3.71 BYN', () => assert.equal(X.fmtMoney(X.convertMinor(10000n, 'RUB', 'BYN', rates)), '3.71'));
ok('1 BYN = 26.9397 RUB (кросс)', () => assert.equal(X.fmtRate(X.rate4('BYN', 'RUB', rates)), '26.9397'));
ok('1000 KZT = 5.79 BYN', () => assert.equal(X.fmtMoney(X.convertMinor(100000n, 'KZT', 'BYN', rates)), '5.79'));
ok('100 USD → RUB через BYN', () => assert.equal(X.fmtMoney(X.convertMinor(10000n, 'USD', 'RUB', rates)), '8 048.49'));
ok('0.1+0.2 нет: 0.30 BYN → USD', () => assert.equal(X.fmtMoney(X.convertMinor(30n, 'BYN', 'USD', rates)), '0.10'));
ok('большие суммы точны', () => assert.equal(X.fmtMoney(X.convertMinor(99999999999900n, 'BYN', 'BYN', rates)), '999 999 999 999.00'));
ok('parseAmount', () => {
  assert.equal(X.parseAmount('1 234,5'), 123450n); assert.equal(X.parseAmount('99.90'), 9990n);
  assert.equal(X.parseAmount('0'), null); assert.equal(X.parseAmount('abc'), null); assert.equal(X.parseAmount('1.234'), null); assert.equal(X.parseAmount('-5'), null);
});
ok('тренд', () => {
  const prev = { ...rates, RUB: { scale: 100, micro: '3700000' } };
  assert.equal(X.trendOf('RUB', 'BYN', rates, prev), 'up');
  assert.equal(X.trendOf('BYN', 'RUB', rates, prev), 'down');
  assert.equal(X.trendOf('BYN', 'USD', rates, prev), 'eq');
  assert.equal(X.trendOf('BYN', 'USD', rates, null), null);
});
ok('параметр BYN:RUB,USD:100', () => {
  const c = X.resolveConfig('BYN:RUB,USD:100', null);
  assert.deepEqual([c.base, c.targets, c.amountMinor, c.scene], ['BYN', ['RUB', 'USD'], 10000n, 'field']);
  const d = X.resolveConfig('rub:byn::med', { base: 'BYN', targets: ['USD'], amount: '1000', scene: 'cloud' });
  assert.deepEqual([d.base, d.targets, d.amountMinor, d.scene], ['RUB', ['BYN'], 100000n, 'med']);
  assert.equal(X.resolveConfig('BYN:RUB:1:city', null).scene, 'field'); // старые названия сцен
  const e = X.resolveConfig('USD', { base: 'BYN', targets: ['USD'], amount: '1', scene: 'sign' });
  assert.deepEqual(e.targets, ['EUR']); // цель = база отброшена, подставлена другая
  assert.throws(() => X.resolveConfig('XXX:RUB', null), /Не понял Parameter/);
  assert.throws(() => X.resolveConfig('BYN:RUB:-1', null), /Не понял Parameter/);
});
ok('parseRates отвергает мусор', () => {
  assert.throws(() => X.parseRates({ error: 1 }));
  assert.throws(() => X.parseRates([{ Cur_Abbreviation: 'USD', Cur_Scale: 0, Cur_OfficialRate: 3, Date: '2026-11-19T00:00:00' }]));
});

globalThis.__MOCK_TODAY__ = new Date().toISOString().slice(0, 10);
const d1 = await X.loadData();
ok('загрузка: курсы + история 14 дней + вчерашний курс', () => {
  assert.equal(d1.offline, false); assert.ok(d1.prevRates && d1.prevRates.USD);
  assert.equal(d1.historyDates.length, 14);
});
globalThis.__MOCK_OFFLINE__ = true;
const d2 = await X.loadData(true);
ok('офлайн: отдаёт кэш с пометкой', () => { assert.equal(d2.offline, true); assert.equal(d2.rateDate, d1.rateDate); });
for (const k of Object.keys(globalThis.__MOCK_FILES__)) delete globalThis.__MOCK_FILES__[k];
let err = null; try { await X.loadData(); } catch (e) { err = e; }
ok('офлайн без кэша: понятная ошибка', () => assert.match(err.message, /Нет связи с НБРБ/));
globalThis.__MOCK_OFFLINE__ = false;
console.log(`\nВсе проверки пройдены: ${n}`);
process.exit(0);
