#!/usr/bin/env node
/*
 * Проверка всех заданий: структура данных и решаемость.
 * Запуск из корня репозитория: node it-kids/tools/check-levels.js
 * Код выхода 1, если найдена ошибка.
 */
'use strict';
const path = require('path');
const { WORLDS, RU_ALPHABET } = require(path.join(__dirname, '..', 'levels.js'));

const COLORS = new Set(['k', 'r', 'y', 'g', 'b', 'o', 'p', 'n', 's']);
const KEY_CHARS = new Set('1234567890йцукенгшщзхъфывапролджэячсмитьбю '.split(''));
const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };

let errors = 0;
let total = 0;
const fail = (where, msg) => { errors++; console.error(`✗ ${where}: ${msg}`); };

function isRect(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every(r => typeof r === 'string' && r.length === rows[0].length);
}

// Минимальное число блоков (направление + повтор), чтобы собрать все звёзды и закончить на флажке.
function robotMinBlocks(map, allowRepeat) {
  const H = map.length, W = map[0].length;
  let start, goal; const stars = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = map[y][x];
    if (c === 'R') start = [x, y];
    if (c === 'G') goal = [x, y];
    if (c === '*') stars.push(`${x},${y}`);
  }
  if (!start || !goal) return { err: 'нет R или G' };
  const full = (1 << stars.length) - 1;
  const key = (x, y, m) => `${x},${y},${m}`;
  let frontier = [[start[0], start[1], 0]];
  const seen = new Set([key(start[0], start[1], 0)]);
  for (let depth = 1; depth <= 40; depth++) {
    const next = [];
    for (const [x0, y0, m0] of frontier) {
      for (const [dx, dy] of Object.values(DIRS)) {
        let x = x0, y = y0, m = m0;
        for (let n = 1; n <= (allowRepeat ? 9 : 1); n++) {
          x += dx; y += dy;
          if (x < 0 || y < 0 || x >= W || y >= H || map[y][x] === '#') break;
          const si = stars.indexOf(`${x},${y}`);
          if (si >= 0) m |= 1 << si;
          if (x === goal[0] && y === goal[1] && m === full) return { min: depth };
          const k = key(x, y, m);
          if (!seen.has(k)) { seen.add(k); next.push([x, y, m]); }
        }
      }
    }
    frontier = next;
  }
  return { err: 'нет решения' };
}

function evalRule(rule, on) {
  if (typeof rule === 'string') return !!on[rule];
  const [op, ...args] = rule;
  if (op === 'and') return args.every(a => evalRule(a, on));
  if (op === 'or') return args.some(a => evalRule(a, on));
  if (op === 'not') return !evalRule(args[0], on);
  throw new Error('неизвестная операция ' + op);
}

const checks = {
  robot(L, where) {
    if (!isRect(L.map)) return fail(where, 'карта не прямоугольная');
    const counts = { R: 0, G: 0 };
    L.map.join('').split('').forEach(c => { if (c in counts) counts[c]++; if (!'.#RG*'.includes(c)) fail(where, `символ «${c}»`); });
    if (counts.R !== 1 || counts.G !== 1) fail(where, 'должно быть ровно по одному R и G');
    const res = robotMinBlocks(L.map, !!L.repeat);
    if (res.err) return fail(where, res.err);
    if (L.maxBlocks && res.min > L.maxBlocks) fail(where, `нужно минимум ${res.min} блоков, а разрешено ${L.maxBlocks}`);
    (L.preset || []).forEach(p => { const d = Array.isArray(p) ? p[0] : p; if (!DIRS[d]) fail(where, 'плохой preset'); });
  },
  pixel(L, where) {
    if (!isRect(L.target)) return fail(where, 'target не прямоугольный');
    if (L.target[0].length > 8) fail(where, 'шире 8 клеток — не влезет на телефон');
    const used = new Set(L.target.join('').replace(/\./g, '').split(''));
    used.forEach(c => { if (!COLORS.has(c)) fail(where, `неизвестный цвет «${c}»`); });
    if (L.mode === 'binary' && used.size !== 1) fail(where, 'в двоичном режиме нужен ровно один цвет');
    if (!['copy', 'coords', 'binary', 'rle'].includes(L.mode)) fail(where, 'режим ' + L.mode);
  },
  binary(L, where) {
    if (L.value < 1 || L.value >= 2 ** L.bits) fail(where, 'число не помещается в лампочки');
    if (!['set', 'read'].includes(L.mode)) fail(where, 'режим ' + L.mode);
  },
  order(L, where) {
    if (L.items.length < 3) fail(where, 'мало карточек');
    const texts = L.items.map(i => i.t);
    if (new Set(texts).size !== texts.length) fail(where, 'одинаковые карточки');
  },
  bins(L, where) {
    const ids = new Set(L.bins.map(b => b.id));
    L.items.forEach(i => { if (!ids.has(i.bin)) fail(where, `коробки «${i.bin}» нет`); });
    L.bins.forEach(b => { if (!L.items.some(i => i.bin === b.id)) fail(where, `коробка «${b.id}» пустая`); });
  },
  logic(L, where) {
    const n = L.switches.length;
    let solutions = 0;
    for (let mask = 0; mask < 2 ** n; mask++) {
      const on = {}; L.switches.forEach((s, i) => { on[s] = !!(mask & (1 << i)); });
      if (L.lamps.every(l => evalRule(l.rule, on) === l.want)) solutions++;
    }
    if (!solutions) fail(where, 'нет решения');
    // Стартовое состояние (всё выключено) не должно быть сразу решением
    const off = {}; L.switches.forEach(s => { off[s] = false; });
    if (L.lamps.every(l => evalRule(l.rule, off) === l.want)) fail(where, 'решено с самого начала');
  },
  cipher(L, where) {
    for (const ch of L.answer) if (!RU_ALPHABET.includes(ch)) fail(where, `буква «${ch}» не из алфавита`);
    if (L.mode === 'table') {
      const letters = new Set(L.table.map(p => p[1]));
      for (const ch of L.answer) if (!letters.has(ch)) fail(where, `в ключе нет «${ch}»`);
      const syms = L.table.map(p => p[0]);
      if (new Set(syms).size !== syms.length) fail(where, 'одинаковые значки в ключе');
    } else if (!['caesar', 'reverse'].includes(L.mode)) fail(where, 'режим ' + L.mode);
  },
  pattern(L, where) {
    if (L.blanks < 1 || L.blanks >= L.full.length - 2) fail(where, 'неудачное число пустых клеток');
  },
  keys(L, where) {
    for (const ch of L.text) if (!KEY_CHARS.has(ch)) fail(where, `символа «${ch}» нет на клавиатуре`);
  }
};

const worldIds = new Set();
for (const W of WORLDS) {
  if (worldIds.has(W.id)) fail(W.id, 'повторный id мира');
  worldIds.add(W.id);
  if (!checks[W.type]) { fail(W.id, 'неизвестный тип ' + W.type); continue; }
  W.levels.forEach((L, i) => {
    total++;
    const where = `${W.id} #${i + 1} «${L.title}»`;
    if (!L.title || !L.goal || !L.hint) fail(where, 'нет title / goal / hint');
    try { checks[W.type](L, where); } catch (e) { fail(where, e.message); }
  });
  console.log(`${W.icon}  ${W.title}: ${W.levels.length}`);
}

console.log(`\nВсего заданий: ${total}. Ошибок: ${errors}.`);
process.exit(errors ? 1 : 0);
