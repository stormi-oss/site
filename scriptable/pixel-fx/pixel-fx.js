// PIXEL_FX_MAIN — эта метка нужна загрузчику, не удаляйте её.
// =====================================================================
//  Пиксельный конвертер валют для Scriptable (iOS)
//  Курсы: Национальный банк Республики Беларусь (api.nbrb.by)
//  Валюты: BYN, RUB, UAH, USD, EUR, CNY, KZT
//
//  Ничего настраивать в коде не нужно:
//   • первый запуск в приложении — мастер настройки;
//   • поле Parameter у виджета: BYN:RUB,USD:100  (база:цели:сумма[:сцена])
//     сцена: sign — табличка, cloud — облако, city — ночной город.
// =====================================================================

const VERSION = '1.0.0';

// Подмена даты ТОЛЬКО для сцены (сезон, время суток). null — реальное время.
// Пример: '2026-01-15T22:30:00' — зимняя ночь.
const DEBUG_NOW = null;

const DECIMAL_SEP = '.';              // разделитель дробной части в суммах
const CURRENCIES = ['BYN', 'RUB', 'UAH', 'USD', 'EUR', 'CNY', 'KZT'];
const CUR_NAMES = {
  BYN: 'белорусский рубль', RUB: 'российский рубль', UAH: 'гривна',
  USD: 'доллар США', EUR: 'евро', CNY: 'юань', KZT: 'тенге',
};
// Порядок, которым добираем валюты до трёх на большом виджете.
const FILL_ORDER = ['USD', 'EUR', 'RUB', 'CNY', 'UAH', 'KZT', 'BYN'];

const API_RATES = 'https://api.nbrb.by/exrates/rates?periodicity=0';
const API_DYNAMICS = (id, from, to) =>
  `https://api.nbrb.by/exrates/rates/dynamics/${id}?startdate=${from}&enddate=${to}`;

const NET_TIMEOUT_S = 10;             // таймаут одного запроса
const REFRESH_MIN = 30;               // как часто просить iOS обновить виджет
const HISTORY_DAYS = 14;
const HISTORY_KEEP_DAYS = 21;         // сколько дней храним в кэше
const RATE_PREC = 1000000n;           // курсы храним как целые × 10^6
const CACHE_VERSION = 2;

const CELL = 5;                       // размер «пикселя» сцены в точках iOS
const CHAR_W = 0.62;                  // ширина символа моноширинного шрифта, доля от кегля

const SCENES = {
  sign: 'Поле: курс на табличке',
  cloud: 'Поле: курс в облаке',
  city: 'Ночной город',
};
const DEFAULT_SETTINGS = { base: 'BYN', targets: ['RUB', 'USD'], amount: '1', scene: 'sign' };

// ---------------------------------------------------------------------
//  Палитра: 20 цветов, общая для всех сцен
// ---------------------------------------------------------------------
const PAL = {
  nightDeep: '#0b1030', night: '#25306b', dayTop: '#3d8be0', dayBottom: '#a9dcf7',
  duskOrange: '#f5a05a', duskPink: '#d8607e', cloud: '#f6f8fc', cloudShade: '#aeb9d0',
  grassDeep: '#1d4d2a', grassDark: '#2f7a34', grass: '#4fae4c', grassLight: '#a4d36a',
  trunk: '#734a2a', trunkDark: '#43291a', wood: '#e3b87f',
  leafOrange: '#e9822c', gold: '#f7c936', red: '#de4459', water: '#78b4e6', ink: '#17151f',
};
// Затемнение земли и предметов ночью / в сумерках — внутри той же палитры.
const NIGHT_MAP = {
  grassLight: 'grassDark', grass: 'grassDark', grassDark: 'grassDeep', grassDeep: 'nightDeep',
  cloud: 'cloudShade', cloudShade: 'night', wood: 'trunk', trunk: 'trunkDark', trunkDark: 'ink',
  leafOrange: 'trunk', gold: 'leafOrange', red: 'trunk', water: 'night',
};
const DUSK_MAP = {
  grassLight: 'grass', grass: 'grassDark', grassDark: 'grassDeep',
  cloud: 'cloudShade', wood: 'leafOrange', leafOrange: 'red',
};

// =====================================================================
//  Ошибки
// =====================================================================
class UserError extends Error {}      // текст можно показывать как есть

// =====================================================================
//  Файлы: настройки и кэш в FileManager.local()
// =====================================================================
const fm = FileManager.local();
const DATA_DIR = fm.joinPath(fm.documentsDirectory(), 'pixel-fx');
const SETTINGS_FILE = 'settings.json';
const CACHE_FILE = 'rates-cache.json';

function filePath(name) { return fm.joinPath(DATA_DIR, name); }

function readJSON(name) {
  try {
    const p = filePath(name);
    if (!fm.fileExists(p)) return null;
    return JSON.parse(fm.readString(p));
  } catch (e) {
    log(`[pixel-fx] не прочитал ${name}: ${e}`);
    return null;
  }
}

function writeJSON(name, obj) {
  try {
    if (!fm.fileExists(DATA_DIR)) fm.createDirectory(DATA_DIR, true);
    fm.writeString(filePath(name), JSON.stringify(obj));
  } catch (e) {
    log(`[pixel-fx] не записал ${name}: ${e}`);
  }
}

// =====================================================================
//  Даты
// =====================================================================
const pad2 = (n) => String(n).padStart(2, '0');
function ymdLocal(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
// Арифметика по строкам YYYY-MM-DD через UTC — без сюрпризов с переводом часов.
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ddmm(ymd) { return `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`; }
function ddmmyyyy(ymd) { return `${ddmm(ymd)}.${ymd.slice(0, 4)}`; }
function sceneNow() { return DEBUG_NOW ? new Date(DEBUG_NOW) : new Date(); }

// =====================================================================
//  Точная арифметика: курсы и суммы — BigInt, без float
// =====================================================================
// Курс НБРБ: Cur_OfficialRate BYN за Cur_Scale единиц. Храним micro = rate × 10^6.
function toMicro(rate) {
  if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) return null;
  return BigInt(Math.round(rate * 1e6)); // у НБРБ 4 знака, погрешность float тут < 1e-9
}

// Сколько BYN стоит 1 единица валюты — дробь num/den.
function unitInByn(cur, rates) {
  if (cur === 'BYN') return { num: 1n, den: 1n };
  const r = rates[cur];
  if (!r) return null;
  return { num: BigInt(r.micro), den: BigInt(r.scale) * RATE_PREC };
}

// Сколько единиц `to` дают за 1 единицу `from` (кросс через BYN) — дробь n/d.
function cross(from, to, rates) {
  const a = unitInByn(from, rates);
  const b = unitInByn(to, rates);
  if (!a || !b) return null;
  return { n: a.num * b.den, d: a.den * b.num };
}

// Деление с округлением половины вверх (для неотрицательных чисел).
function roundDiv(n, d) { return (n * 2n + d) / (2n * d); }

// Сумма в копейках (×100) → сумма в копейках другой валюты.
function convertMinor(minor, from, to, rates) {
  const r = cross(from, to, rates);
  return r ? roundDiv(minor * r.n, r.d) : null;
}

// Кросс-курс с 4 знаками (целое × 10^4).
function rate4(from, to, rates) {
  const r = cross(from, to, rates);
  return r ? roundDiv(r.n * 10000n, r.d) : null;
}

// Тренд по точным дробям. Изменение меньше 0,005 % считаем «без изменений».
function trendOf(from, to, nowRates, prevRates) {
  if (!prevRates) return null;
  const a = cross(from, to, nowRates);
  const b = cross(from, to, prevRates);
  if (!a || !b) return null;
  const x = a.n * b.d;
  const y = b.n * a.d;
  const diff = x - y;
  const abs = diff < 0n ? -diff : diff;
  if (abs * 20000n < y) return 'eq';
  return diff > 0n ? 'up' : 'down';
}

// Целое с `dec` знаками после запятой → строка «1 234.56».
function formatFixed(v, dec, group = true) {
  if (v === null || v === undefined) return '—';
  const neg = v < 0n;
  let s = (neg ? -v : v).toString().padStart(dec + 1, '0');
  let int = dec ? s.slice(0, -dec) : s;
  const frac = dec ? s.slice(-dec) : '';
  if (group) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + int + (dec ? DECIMAL_SEP + frac : '');
}
const fmtMoney = (minor) => formatFixed(minor, 2);
const fmtRate = (r4) => formatFixed(r4, 4);
// Сумма-основание: «100», «99.90».
function fmtAmount(minor) {
  return minor % 100n === 0n ? formatFixed(minor / 100n, 0) : formatFixed(minor, 2);
}

// «1 234,5» / «99.90» → копейки (BigInt) или null.
function parseAmount(input) {
  const s = String(input || '').replace(/[\s  ]/g, '').replace(',', '.');
  const m = s.match(/^(\d{1,12})(?:\.(\d{0,2}))?$/);
  if (!m) return null;
  const minor = BigInt(m[1]) * 100n + BigInt((m[2] || '').padEnd(2, '0'));
  return minor > 0n ? minor : null;
}

// =====================================================================
//  Сеть и кэш курсов
// =====================================================================
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = Timer.schedule(ms, false, () => {
      if (done) return;
      done = true;
      reject(new Error(message));
    });
    promise.then(
      (v) => { if (!done) { done = true; timer.invalidate(); resolve(v); } },
      (e) => { if (!done) { done = true; timer.invalidate(); reject(e); } },
    );
  });
}

async function fetchJSON(url) {
  const req = new Request(url);
  req.timeoutInterval = NET_TIMEOUT_S;
  req.headers = { Accept: 'application/json' };
  // Дублируем таймаут своим таймером: в виджете системный иногда не срабатывает.
  const json = await withTimeout(req.loadJSON(), (NET_TIMEOUT_S + 1) * 1000, 'НБРБ не ответил за 10 секунд');
  const code = req.response && req.response.statusCode;
  if (code && code !== 200) throw new Error(`НБРБ ответил кодом ${code}`);
  return json;
}

// Ответ /exrates/rates?periodicity=0 — массив объектов
// { Cur_ID, Date: "2026-11-19T00:00:00", Cur_Abbreviation, Cur_Scale, Cur_Name, Cur_OfficialRate }
function parseRates(json) {
  if (!Array.isArray(json)) throw new Error('НБРБ вернул неожиданный формат данных');
  const rates = {};
  let date = null;
  for (const item of json) {
    if (!item || !CURRENCIES.includes(item.Cur_Abbreviation)) continue;
    const scale = Number(item.Cur_Scale);
    const micro = toMicro(item.Cur_OfficialRate);
    if (!Number.isInteger(scale) || scale <= 0 || micro === null) continue;
    rates[item.Cur_Abbreviation] = { id: item.Cur_ID, scale, micro: micro.toString() };
    if (!date && typeof item.Date === 'string') date = item.Date.slice(0, 10);
  }
  if (!rates.USD || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('В ответе НБРБ нет нужных курсов');
  }
  return { rates, date };
}

function snapshot(rates) {
  const s = {};
  for (const [cur, r] of Object.entries(rates)) s[cur] = [r.micro, r.scale];
  return s;
}

function pruneHistory(history, lastDate) {
  const minDate = addDays(lastDate, -HISTORY_KEEP_DAYS);
  for (const d of Object.keys(history)) if (d < minDate || d > lastDate) delete history[d];
}

// История: если за последние 14 дней мало точек — один раз в день догружаем dynamics.
async function fillHistory(data, today) {
  const from = addDays(data.rateDate, -HISTORY_DAYS - 1);
  const have = Object.keys(data.history).filter((d) => d >= from && d < data.rateDate).length;
  if (have >= HISTORY_DAYS - 2 || data.historyTriedOn === today) return false;
  data.historyTriedOn = today;
  const jobs = Object.entries(data.rates).map(async ([cur, r]) => {
    try {
      // Ответ dynamics: [{ Cur_ID, Date, Cur_OfficialRate }] — без Cur_Scale,
      // поэтому берём масштаб из сегодняшнего курса (меняется он крайне редко).
      const rows = await fetchJSON(API_DYNAMICS(r.id, from, data.rateDate));
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const d = typeof row.Date === 'string' ? row.Date.slice(0, 10) : null;
        const micro = toMicro(row.Cur_OfficialRate);
        if (!d || micro === null) continue;
        (data.history[d] = data.history[d] || {})[cur] = [micro.toString(), r.scale];
      }
    } catch (e) {
      log(`[pixel-fx] история ${cur}: ${e.message || e}`);
    }
  });
  await Promise.all(jobs);
  return true;
}

// Главная функция данных. Без сети возвращает кэш с offline = true.
async function loadData(force = false) {
  const today = ymdLocal(new Date());
  let data = readJSON(CACHE_FILE);
  if (!data || data.v !== CACHE_VERSION || !data.rates) data = null;
  let offline = false;
  let netError = null;

  // Курс НБРБ меняется раз в сутки: если в кэше уже сегодняшний — сеть не трогаем.
  if (force || !data || data.rateDate !== today) {
    try {
      const fresh = parseRates(await fetchJSON(API_RATES));
      const history = (data && data.history) || {};
      history[fresh.date] = snapshot(fresh.rates);
      data = {
        v: CACHE_VERSION, rates: fresh.rates, rateDate: fresh.date,
        fetchedAt: Date.now(), history, historyTriedOn: data && data.historyTriedOn,
      };
      writeJSON(CACHE_FILE, data);
    } catch (e) {
      netError = e;
      log(`[pixel-fx] сеть: ${e.message || e}`);
      if (!data) {
        throw new UserError('Нет связи с НБРБ, а сохранённых курсов ещё нет.\nПроверьте интернет и откройте виджет позже.');
      }
      offline = true;
    }
  }

  if (!offline) {
    try {
      if (await fillHistory(data, today)) writeJSON(CACHE_FILE, data);
    } catch (e) {
      log(`[pixel-fx] история: ${e.message || e}`);
    }
  }
  pruneHistory(data.history, data.rateDate);

  // Для расчётов превращаем снимки истории в тот же формат, что и rates.
  const asRates = (snap) => {
    const out = {};
    for (const [cur, [micro, scale]] of Object.entries(snap || {})) out[cur] = { micro, scale };
    return out;
  };
  const dates = Object.keys(data.history).sort();
  const prevDate = dates.filter((d) => d < data.rateDate).pop() || null;
  return {
    rates: data.rates,
    rateDate: data.rateDate,
    prevRates: prevDate ? asRates(data.history[prevDate]) : null,
    historyDates: dates.filter((d) => d <= data.rateDate).slice(-HISTORY_DAYS),
    historyAt: (d) => asRates(data.history[d]),
    offline,
    netError: netError ? String(netError.message || netError) : null,
  };
}

// =====================================================================
//  Настройки и параметр виджета
// =====================================================================
function loadSettings() {
  const s = readJSON(SETTINGS_FILE);
  if (!s || !CURRENCIES.includes(s.base)) return null;
  return {
    base: s.base,
    targets: (Array.isArray(s.targets) ? s.targets : []).filter((c) => CURRENCIES.includes(c) && c !== s.base).slice(0, 2),
    amount: parseAmount(s.amount) ? String(s.amount) : '1',
    scene: SCENES[s.scene] ? s.scene : 'sign',
  };
}

function normalizeTargets(base, targets) {
  const out = [];
  for (const t of targets) if (CURRENCIES.includes(t) && t !== base && !out.includes(t)) out.push(t);
  return out;
}

// Параметр: «BYN:RUB,USD:100» или «BYN:RUB,USD:100:cloud». Любая часть может отсутствовать.
function parseParam(param) {
  const parts = param.split(':').map((p) => p.trim());
  const res = {};
  const bad = () => new UserError(`Не понял Parameter «${param}».\nПример: BYN:RUB,USD:100`);
  if (parts[0]) {
    const b = parts[0].toUpperCase();
    if (!CURRENCIES.includes(b)) throw bad();
    res.base = b;
  }
  if (parts[1]) {
    const ts = parts[1].split(/[,;\s]+/).filter(Boolean).map((t) => t.toUpperCase());
    if (!ts.length || ts.some((t) => !CURRENCIES.includes(t))) throw bad();
    res.targets = ts;
  }
  if (parts[2]) {
    if (!parseAmount(parts[2])) throw bad();
    res.amount = parts[2];
  }
  if (parts[3]) {
    const sc = parts[3].toLowerCase();
    if (!SCENES[sc]) throw bad();
    res.scene = sc;
  }
  return res;
}

function resolveConfig(param, settings) {
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const p = param ? parseParam(param) : {};
  const base = p.base || s.base;
  let targets = normalizeTargets(base, p.targets || s.targets);
  if (!targets.length) targets = normalizeTargets(base, FILL_ORDER).slice(0, 1);
  const amount = p.amount || s.amount;
  return {
    base,
    targets: targets.slice(0, 3),
    amountMinor: parseAmount(amount),
    scene: p.scene || s.scene,
  };
}

function configToParam(cfg) {
  return `${cfg.base}:${cfg.targets.join(',')}:${fmtAmount(cfg.amountMinor).replace(/ /g, '')}:${cfg.scene}`;
}

// Для большого виджета добираем список до трёх валют.
function threeTargets(cfg) {
  return normalizeTargets(cfg.base, cfg.targets.concat(FILL_ORDER)).slice(0, 3);
}

// =====================================================================
//  Модель для отрисовки
// =====================================================================
function buildModel(cfg, data, targets) {
  const rows = targets.map((code) => ({
    code,
    value: fmtMoney(convertMinor(cfg.amountMinor, cfg.base, code, data.rates)),
    rate: fmtRate(rate4(cfg.base, code, data.rates)),
    trend: trendOf(cfg.base, code, data.rates, data.prevRates),
  }));
  return {
    base: cfg.base,
    amount: fmtAmount(cfg.amountMinor),
    rows,
    trend: rows[0] ? rows[0].trend : null,
    dateLabel: data.offline ? `офлайн · курс от ${ddmm(data.rateDate)}` : `НБРБ · ${ddmmyyyy(data.rateDate)}`,
    shortDate: data.offline ? `офлайн ${ddmm(data.rateDate)}` : `НБРБ ${ddmm(data.rateDate)}`,
    offline: data.offline,
  };
}

// Ряд кросс-курса base→target за 14 дней (числа — только для рисования).
function buildSeries(cfg, target, data) {
  const out = [];
  for (const d of data.historyDates) {
    const r = d === data.rateDate ? data.rates : data.historyAt(d);
    // 10 знаков: у пар вроде KZT→USD курс 0.0019 и 4 знаков для графика мало.
    const c = cross(cfg.base, target, r);
    if (c) out.push({ date: d, v: Number(roundDiv(c.n * 10000000000n, c.d)) / 1e10 });
  }
  return out;
}

// =====================================================================
//  Детерминированный рандом
// =====================================================================
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
// Стабильный шум по координатам (форма кроны не прыгает между обновлениями).
function noise2(x, y, salt = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// =====================================================================
//  Окружение сцены: сезон, время суток, ветер
// =====================================================================
function seasonOf(date) {
  const m = date.getMonth();
  if (m === 11 || m <= 1) return 'winter';
  if (m <= 4) return 'spring';
  if (m <= 7) return 'summer';
  return 'autumn';
}

// Границы суток примерно для широты Минска/Москвы, по сезону.
const DAY_BOUNDS = {
  winter: [7.5, 9, 15.5, 17], spring: [5.5, 7, 18.5, 20],
  summer: [4, 5.5, 20.5, 22], autumn: [6.5, 8, 17, 18.5],
};
function timeOfDay(date, season) {
  const h = date.getHours() + date.getMinutes() / 60;
  const [dawn, day, dusk, night] = DAY_BOUNDS[season];
  if (h >= dawn && h < day) return 'dawn';
  if (h >= day && h < dusk) return 'day';
  if (h >= dusk && h < night) return 'dusk';
  return 'night';
}

function makeEnv(trend, overrides = {}) {
  const date = sceneNow();
  const season = overrides.season || seasonOf(date);
  const tod = overrides.tod || timeOfDay(date, season);
  // seed меняется раз в 15 минут: дата + час + четверть часа.
  const seed = hashStr(`${ymdLocal(date)}|${date.getHours()}|${Math.floor(date.getMinutes() / 15)}|${overrides.salt || ''}`);
  const rng = makeRng(seed);
  const windPower = [0, 1, 1, 2, 2, 2, 3, 3][rng.int(0, 7)];
  let dark = false;
  try { dark = Device.isUsingDarkAppearance(); } catch (e) { dark = false; }
  if (overrides.dark !== undefined) dark = overrides.dark;
  return {
    season, tod, rng,
    trend: overrides.trend !== undefined ? overrides.trend : trend,
    wind: { power: windPower, dir: rng.chance(0.75) ? 1 : -1 },
    dark,
  };
}

// =====================================================================
//  Пиксельный холст
// =====================================================================
const colorCache = {};
function color(key, alpha = 1) {
  const id = `${key}|${alpha}`;
  if (!colorCache[id]) colorCache[id] = new Color(PAL[key] || key, alpha);
  return colorCache[id];
}
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

class Pix {
  constructor(W, H, cell) {
    this.W = W; this.H = H; this.cell = cell;
    const ctx = new DrawContext();
    ctx.size = new Size(W * cell, H * cell);
    ctx.opaque = true;
    ctx.respectScreenScale = true; // рисуем в точках, iOS умножит на @3x — края остаются чёткими
    this.ctx = ctx;
    this.map = null;
    this.current = null;
  }
  mapKey(k, lit) { return (!lit && this.map && this.map[k]) || k; }
  setFill(k, alpha, lit) {
    const key = this.mapKey(k, lit);
    const id = `${key}|${alpha}`;
    if (this.current !== id) { this.ctx.setFillColor(color(key, alpha)); this.current = id; }
  }
  // Прямоугольник в клетках. lit = не затемнять ночью (свет, небо, табличка).
  rect(x, y, w, h, k, lit = false, alpha = 1) {
    let x0 = Math.max(0, Math.round(x)); let y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.W, Math.round(x + w)); const y1 = Math.min(this.H, Math.round(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    this.setFill(k, alpha, lit);
    this.ctx.fillRect(new Rect(x0 * this.cell, y0 * this.cell, (x1 - x0) * this.cell, (y1 - y0) * this.cell));
  }
  px(x, y, k, lit = false) { this.rect(x, y, 1, 1, k, lit); }
  line(x0, y0, x1, y1, k, lit = false) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let i = 0; i < 400; i++) {
      this.px(x0, y0, k, lit);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  disc(cx, cy, r, k, lit = false) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      const dy = y + 0.5 - cy;
      if (Math.abs(dy) > r) continue;
      const half = Math.sqrt(r * r - dy * dy);
      const xa = Math.round(cx - half); const xb = Math.round(cx + half);
      if (xb > xa) this.rect(xa, y, xb - xa, 1, k, lit);
    }
  }
  // Смесь двух цветов «сеткой Байера»: ratio 0 — только A, 1 — только B.
  dither(x, y, w, h, kA, kB, ratio, lit = false) {
    if (ratio <= 0) return this.rect(x, y, w, h, kA, lit);
    if (ratio >= 1) return this.rect(x, y, w, h, kB, lit);
    if (kA) this.rect(x, y, w, h, kA, lit);
    const lim = ratio * 16;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (BAYER[((yy % 4) + 4) % 4][((xx % 4) + 4) % 4] < lim) this.px(xx, yy, kB, lit);
      }
    }
  }
  overlay(k, alpha) { this.rect(0, 0, this.W, this.H, k, true, alpha); }
  // Для текста и графиков — координаты в точках.
  ptRect(x, y, w, h, c) { this.current = null; this.ctx.setFillColor(c); this.ctx.fillRect(new Rect(x, y, w, h)); }
  image() { return this.ctx.getImage(); }
}

// =====================================================================
//  Элементы сцены
// =====================================================================
const SKIES = {
  dawn: [['night', 0], ['duskPink', 0.55], ['duskOrange', 1]],
  day: [['dayTop', 0], ['water', 0.5], ['dayBottom', 1]],
  grey: [['water', 0], ['cloudShade', 1]],
  dusk: [['nightDeep', 0], ['night', 0.3], ['duskPink', 0.72], ['duskOrange', 1]],
  night: [['nightDeep', 0], ['night', 1]],
};

function drawSky(P, stops, horizon) {
  for (let y = 0; y < horizon; y++) {
    const t = horizon <= 1 ? 0 : y / (horizon - 1);
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][1]) i++;
    const [a, ta] = stops[i];
    const [b, tb] = stops[i + 1];
    const local = tb > ta ? (t - ta) / (tb - ta) : 0;
    // Чистые полосы цвета и узкая полоса дизеринга на стыке — как в пиксель-арте.
    const q = local < 0.36 ? 0 : local < 0.46 ? 0.25 : local < 0.54 ? 0.5 : local < 0.64 ? 0.75 : 1;
    P.dither(0, y, P.W, 1, a, b, q, true);
  }
}

function drawStars(P, env, horizon, many) {
  const n = Math.round((P.W * horizon) / (many ? 45 : 80));
  for (let i = 0; i < n; i++) {
    const x = env.rng.int(0, P.W - 1);
    const y = env.rng.int(0, Math.max(0, Math.floor(horizon * 0.75)));
    const k = env.rng.chance(0.2) ? 'gold' : 'cloud';
    P.px(x, y, k, true);
    if (env.rng.chance(0.12)) { // мерцающая звезда-крестик
      P.px(x - 1, y, 'cloudShade', true); P.px(x + 1, y, 'cloudShade', true);
      P.px(x, y - 1, 'cloudShade', true); P.px(x, y + 1, 'cloudShade', true);
    }
  }
}

function drawMoon(P, x, y, r) {
  P.dither(x - r - 2, y - r - 2, r * 2 + 5, r * 2 + 5, null, 'night', 0.25, true);
  P.disc(x + 0.5, y + 0.5, r, 'cloud', true);
  P.px(x - 1, y, 'cloudShade', true);
  P.px(x + 1, y + 1, 'cloudShade', true);
  if (r >= 3) P.px(x, y - 2, 'cloudShade', true);
}

function drawSun(P, x, y, r, low, env) {
  if (low) { // рассвет/закат: большой оранжевый диск у горизонта
    P.disc(x + 0.5, y + 0.5, r + 1, 'duskOrange', true);
    P.disc(x + 0.5, y + 0.5, r - 0.5, 'gold', true);
    return;
  }
  P.disc(x + 0.5, y + 0.5, r, 'gold', true);
  const d = r + 2;
  const long = env.rng.chance(0.5);
  [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
    P.px(x + dx * d, y + dy * d, 'gold', true);
    if (long) P.px(x + dx * (d + 1), y + dy * (d + 1), 'gold', true);
  });
  [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([dx, dy]) => P.px(x + dx * (d - 1), y + dy * (d - 1), 'gold', true));
}

// Пухлое облако: несколько кругов + плоское дно с тенью.
function drawCloud(P, x, y, w, body = 'cloud', shade = 'cloudShade', lit = false) {
  const h = Math.max(2, Math.round(w / 4));
  const bumps = Math.max(2, Math.round(w / 4));
  for (let i = 0; i < bumps; i++) {
    const cx = x + ((i + 0.5) * w) / bumps;
    const r = (i === 0 || i === bumps - 1 ? 0.55 : 0.85) * h + noise2(x + i, y, 3) * 1.2;
    P.disc(cx, y + h - r * 0.6, r, body, lit);
  }
  P.rect(x, y + h - 1, w, 1, body, lit);
  P.rect(x + 1, y + h, w - 2, 1, shade, lit);
}

function drawRain(P, env, x0, x1, yTop, yBottom, amount) {
  const slant = env.wind.dir * Math.min(env.wind.power, 2);
  for (let i = 0; i < amount; i++) {
    const x = env.rng.int(x0, x1);
    const y = env.rng.int(yTop, yBottom - 2);
    P.px(x, y, 'water', true);
    P.px(x + (slant >= 2 ? env.wind.dir : 0), y + 1, 'water', true);
  }
}

function drawSnowflakes(P, env, yMax, amount) {
  for (let i = 0; i < amount; i++) {
    const x = env.rng.int(0, P.W - 1);
    const y = env.rng.int(0, yMax);
    P.px(x, y, 'cloud', true);
    if (env.rng.chance(0.15)) { // крупная снежинка
      P.px(x - 1, y, 'cloud', true); P.px(x + 1, y, 'cloud', true);
      P.px(x, y - 1, 'cloud', true); P.px(x, y + 1, 'cloud', true);
    }
  }
}

// Дальние холмы + поле + травинки по ветру.
function drawField(P, env, ground) {
  const s = env.season;
  const phase = noise2(1, 2, 7) * 6;
  for (let x = 0; x < P.W; x++) {
    const hill = Math.round(1.6 + 1.4 * Math.sin(x * 0.13 + phase) + Math.sin(x * 0.31) * 0.6);
    P.rect(x, ground - hill, 1, hill, s === 'winter' ? 'cloudShade' : 'grassDeep');
  }
  const base = s === 'winter' ? 'cloud' : s === 'autumn' ? 'grass' : 'grass';
  P.rect(0, ground, P.W, P.H - ground, base);
  if (s === 'winter') {
    P.dither(0, ground, P.W, 1, null, 'cloudShade', 0.5);
  } else {
    P.rect(0, ground, P.W, 1, 'grassDark');
  }
  // Пятна текстуры на земле.
  for (let i = 0; i < (P.W * (P.H - ground)) / (s === 'winter' ? 25 : 6); i++) {
    const x = env.rng.int(0, P.W - 1); const y = env.rng.int(ground + 1, P.H - 1);
    const k = s === 'winter' ? 'cloudShade' : s === 'autumn' ? env.rng.pick(['grassDark', 'gold', 'grassLight']) : env.rng.pick(['grassDark', 'grassLight']);
    P.px(x, y, k);
  }
  // Травинки: 1–3 пикселя, наклон по ветру растёт к верхушке.
  const lean = env.wind.power * env.wind.dir;
  const density = s === 'winter' ? 0.12 : 0.55;
  for (let y = ground; y < P.H; y += 2) {
    const near = (y - ground) / Math.max(1, P.H - ground); // ближе к зрителю — выше травинки
    for (let x = 0; x < P.W; x++) {
      if (!env.rng.chance(density)) continue;
      const h = 1 + Math.floor(env.rng.next() * (2 + near * 1.5));
      let top = null;
      for (let j = 1; j <= h; j++) {
        const dx = Math.round((lean * j * j) / 9);
        const k = j === h ? (s === 'autumn' ? env.rng.pick(['gold', 'grassLight']) : s === 'winter' ? 'grassDark' : 'grassLight') : (s === 'winter' ? 'trunk' : 'grassDark');
        P.px(x + dx, y - j, k);
        top = [x + dx, y - j];
      }
      // Весной — цветы на верхушках.
      if (s === 'spring' && top && env.rng.chance(0.12)) P.px(top[0], top[1], env.rng.pick(['red', 'gold', 'cloud']));
      if (s === 'summer' && top && env.rng.chance(0.03)) P.px(top[0], top[1], 'gold');
    }
  }
  if (s === 'winter') { // сугробы
    for (let i = 0; i < P.W / 8; i++) {
      const x = env.rng.int(0, P.W - 1);
      P.rect(x, ground - 1, env.rng.int(2, 5), 1, 'cloud');
    }
  }
}

// Дерево. Возвращает центр кроны (для листьев).
function drawTree(P, env, t, ground) {
  const s = env.season;
  const tx = t.x;
  const top = ground - t.trunkH;
  const sway = Math.round(env.wind.power * env.wind.dir * 0.5);
  // Ствол 2 пикселя + корни.
  P.rect(tx, top, 2, t.trunkH, 'trunk');
  P.rect(tx + 1, top, 1, t.trunkH, 'trunkDark');
  P.px(tx - 1, ground - 1, 'trunk'); P.px(tx + 2, ground - 1, 'trunkDark');
  const cx = tx + 1 + sway;
  const cy = top - t.ry * 0.55;

  if (s === 'winter') {
    // Голые ветки со снегом.
    const branches = [[-1, -0.9, 0.9], [1, -0.85, 0.95], [-0.6, -1, 0.6], [0.6, -1.05, 0.65], [0, -1.15, 0.8]];
    for (const [bx, by, len] of branches) {
      const x1 = cx + bx * t.rx * len; const y1 = top + by * t.ry * 1.2 * len;
      P.line(tx + (bx > 0 ? 1 : 0), top + 1, x1, y1, 'trunkDark');
      P.line(x1, y1, x1 + bx * 2, y1 - 1, 'trunkDark');
      P.px(x1, y1 - 1, 'cloud'); P.px(x1 + bx * 2, y1 - 2, 'cloud');
    }
    P.rect(tx, top - 1, 2, 1, 'cloud');
    return { cx, cy };
  }

  const palette = {
    spring: ['grassLight', 'grass', 'grassDark'],
    summer: ['grassLight', 'grass', 'grassDark'],
    autumn: ['gold', 'leafOrange', 'red'],
  }[s];
  // Ветки рисуем до кроны — из-под листвы видны только их кончики.
  P.line(tx, top, cx - t.rx * 0.6, cy + t.ry * 0.3, 'trunkDark');
  P.line(tx + 1, top, cx + t.rx * 0.55, cy + t.ry * 0.2, 'trunkDark');
  const holes = s === 'autumn' ? 0.42 : 0.28;
  for (let y = Math.floor(cy - t.ry - 1); y <= Math.ceil(cy + t.ry + 1); y++) {
    for (let x = Math.floor(cx - t.rx - 2); x <= Math.ceil(cx + t.rx + 2); x++) {
      // Верх кроны клонится по ветру.
      const lean = ((cy - y) / t.ry) * env.wind.power * env.wind.dir * 0.4;
      const dx = (x + 0.5 - cx - lean) / t.rx;
      const dy = (y + 0.5 - cy) / t.ry;
      const n = noise2(x >> 1, y >> 1, 11) * holes; // «комки» листвы 2×2
      const d = dx * dx + dy * dy + n;
      if (d > 1) continue;
      const light = -dx * 0.6 - dy * 0.8;
      const k = light > 0.35 ? palette[0] : (d > 0.7 && light < -0.1 ? palette[2] : palette[1]);
      P.px(x, y, k);
      if (s === 'spring' && noise2(x, y, 5) < 0.07) P.px(x, y, noise2(x, y, 6) < 0.5 ? 'red' : 'cloud');
    }
  }
  return { cx, cy };
}

// Листья (лепестки, снежинки) срываются с кроны и летят по ветру.
function drawFlyingLeaves(P, env, crown, ground, avoid) {
  const s = env.season;
  if (s === 'winter') return;
  const n = { autumn: 5 + env.wind.power * 4, summer: env.wind.power * 2, spring: 2 + env.wind.power * 2 }[s];
  const colors = { autumn: ['gold', 'leafOrange', 'red'], summer: ['grassLight', 'grass'], spring: ['cloud', 'red', 'cloud'] }[s];
  for (let i = 0; i < n; i++) {
    const dist = env.rng.next() * P.W * (0.25 + env.wind.power * 0.2);
    const x = Math.round(crown.cx + env.wind.dir * dist + env.rng.int(-2, 2));
    const y = Math.round(crown.cy - 2 + env.rng.next() * (ground - crown.cy) + Math.sin(dist * 0.5) * 2);
    if (avoid && x >= avoid.x - 1 && x <= avoid.x + avoid.w && y >= avoid.y - 1 && y <= avoid.y + avoid.h) continue;
    const k = env.rng.pick(colors);
    P.px(x, y, k);
    const shape = env.rng.int(0, 2); // одиночный, горизонтальный, диагональный
    if (shape === 1) P.px(x + 1, y, k);
    if (shape === 2) P.px(x + env.wind.dir, y - 1, k);
  }
}

// =====================================================================
//  Таблички под текст
// =====================================================================
function drawSign(P, env, r, ground) {
  const night = env.tod === 'night' || env.tod === 'dusk';
  // Столбики до земли.
  const posts = [r.x + 3, r.x + r.w - 5];
  for (const px of posts) {
    P.rect(px, r.y + r.h, 2, ground - (r.y + r.h) + 1, 'trunk');
    P.rect(px + 1, r.y + r.h, 1, ground - (r.y + r.h) + 1, 'trunkDark');
  }
  if (night) { // тёплые блики на траве под табличкой, гуще у центра
    const mid = r.x + r.w / 2;
    for (let y = ground - 1; y < Math.min(P.H, ground + 3); y++) {
      for (let x = r.x - 2; x < r.x + r.w + 2; x++) {
        const k = 1 - Math.abs(x - mid) / (r.w / 2 + 2);
        if (noise2(x, y, 21) < 0.35 * k) P.px(x, y, noise2(x, y, 22) < 0.5 ? 'duskOrange' : 'gold', true);
      }
    }
  }
  P.rect(r.x, r.y, r.w, r.h, 'trunk', true);
  P.rect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 'wood', true);
  P.rect(r.x + 1, r.y + r.h - 2, r.w - 2, 1, 'duskOrange', true); // нижняя тень доски
  P.px(r.x + 1, r.y + 1, 'trunkDark', true); // гвозди
  P.px(r.x + r.w - 2, r.y + 1, 'trunkDark', true);
  if (night) { // фонарик над левым углом и ореол вокруг него
    const lx = r.x + 2; const ly = r.y - 2;
    P.dither(lx - 2, Math.max(0, ly - 3), 7, 5, null, 'duskOrange', 0.25, true);
    P.px(lx + 1, ly - 1, 'trunkDark', true);
    P.rect(lx, ly, 3, 2, 'trunkDark', true);
    P.px(lx + 1, ly, 'gold', true);
    P.px(lx + 1, ly + 1, 'gold', true);
  }
  if (env.season === 'winter') { // снег на табличке
    for (let x = r.x; x < r.x + r.w; x++) if (noise2(x, r.y, 9) < 0.7) P.px(x, r.y - 1, 'cloud');
  }
}

function drawCloudPlate(P, env, r) {
  const body = 'cloud'; const shade = 'cloudShade';
  const lit = true;
  // Кочки сверху и по бокам — получается облако.
  const n = Math.max(3, Math.round(r.w / 7));
  for (let i = 0; i < n; i++) {
    const cx = r.x + 2 + ((i + 0.5) * (r.w - 4)) / n;
    const rad = 2.2 + noise2(i, r.w, 4) * 1.8;
    P.disc(cx, r.y + 1.5, rad, body, lit);
  }
  P.disc(r.x + 1.5, r.y + r.h * 0.5, Math.min(3, r.h * 0.35), body, lit);
  P.disc(r.x + r.w - 1.5, r.y + r.h * 0.5, Math.min(3, r.h * 0.35), body, lit);
  P.rect(r.x + 1, r.y, r.w - 2, r.h, body, lit);
  P.rect(r.x, r.y + 1, r.w, r.h - 2, body, lit);
  P.rect(r.x + 2, r.y + r.h, r.w - 4, 1, shade, lit);
  P.rect(r.x + 1, r.y + r.h - 1, 1, 1, shade, lit);
  P.rect(r.x + r.w - 2, r.y + r.h - 1, 1, 1, shade, lit);
}

function drawGlassPlate(P, r) {
  P.rect(r.x, r.y, r.w, r.h, 'ink', true, 0.84);
  P.rect(r.x + 1, r.y, r.w - 2, 1, 'night', true);
  P.rect(r.x + 1, r.y + r.h - 1, r.w - 2, 1, 'night', true);
  P.rect(r.x, r.y + 1, 1, r.h - 2, 'night', true);
  P.rect(r.x + r.w - 1, r.y + 1, 1, r.h - 2, 'night', true);
}

// =====================================================================
//  Сцены
// =====================================================================
// Раскладка в клетках по размеру виджета: W×H сетка, линия земли, дерево, табличка.
function layoutFor(family) {
  switch (family) {
    case 'small':
      return { W: 32, H: 32, ground: 25, tree: { x: 3, trunkH: 7, rx: 4.5, ry: 4 }, plate: { x: 10, y: 2, w: 21, h: 20 }, sun: [4, 3] };
    case 'large':
      return { W: 68, H: 71, ground: 55, tree: { x: 10, trunkH: 16, rx: 9, ry: 8 }, plate: { x: 25, y: 3, w: 41, h: 47 }, sun: [6, 6] };
    case 'extraLarge':
      return { W: 144, H: 68, ground: 52, tree: { x: 20, trunkH: 16, rx: 13, ry: 10 }, plate: { x: 46, y: 4, w: 92, h: 43 }, sun: [6, 6] };
    case 'medium':
    default:
      return { W: 68, H: 32, ground: 24, tree: { x: 11, trunkH: 7, rx: 8, ry: 6 }, plate: { x: 27, y: 2, w: 39, h: 19 }, sun: [4, 3] };
  }
}

function weatherSky(env) {
  if (env.tod === 'day' && env.trend !== 'up' && env.trend !== null) return SKIES.grey;
  return SKIES[env.tod];
}

function renderFieldScene(P, L, env, variant) {
  const ground = L.ground;
  drawSky(P, weatherSky(env), ground);
  const night = env.tod === 'night';
  if (night) drawStars(P, env, ground, env.trend === 'up');
  // Небесное светило.
  if (night) drawMoon(P, L.sun[0] + 1, L.sun[1], 2);
  else if (env.trend === 'up' || env.trend === null) {
    if (env.tod === 'day') drawSun(P, L.sun[0], L.sun[1], 2, false, env);
    else drawSun(P, Math.round(L.W * 0.08), ground - 3, 3, true, env);
  }
  // Облака по тренду: = облачно, ▲ одно маленькое, ▼ тучка с дождём.
  const plate = L.plate;
  const freeClouds = env.trend === 'eq' ? 3 : env.trend === 'up' ? 1 : 1;
  for (let i = 0; i < freeClouds; i++) {
    const w = env.rng.int(6, 10);
    const x = env.rng.int(-2, L.W - w + 2);
    const y = env.rng.int(0, Math.max(1, Math.round(ground * 0.3)));
    drawCloud(P, x, y, w);
  }
  if (night) P.map = NIGHT_MAP; else if (env.tod !== 'day') P.map = DUSK_MAP;
  drawField(P, env, ground);
  const crown = drawTree(P, env, L.tree, ground);
  // Дождь или снегопад (зимой вместо дождя — снег).
  if (env.trend === 'down') {
    // Серая тучка над деревом, из неё — дождь.
    const cw = Math.min(14, Math.round(L.W / 3));
    const cx = Math.max(0, Math.round(crown.cx - cw / 2));
    const cy = Math.max(0, Math.round(crown.cy - L.tree.ry - 6));
    drawCloud(P, cx, cy, cw, 'cloudShade', 'night');
    if (env.season === 'winter') drawSnowflakes(P, env, ground, Math.round(L.W * L.H / 50));
    else drawRain(P, env, cx, cx + cw, cy + 4, ground, Math.round(cw * 1.6));
  } else if (env.season === 'winter') {
    drawSnowflakes(P, env, ground, Math.round(L.W * L.H / 110));
  }
  if (variant === 'sign') {
    drawFlyingLeaves(P, env, crown, ground, plate);
    P.map = null;
    if (env.dark) P.overlay('ink', 0.22);
    drawSign(P, env, plate, ground);
  } else {
    drawFlyingLeaves(P, env, crown, ground, plate);
    P.map = null;
    if (env.dark) P.overlay('ink', 0.22);
    drawCloudPlate(P, env, plate);
  }
}

function renderCityScene(P, L, env) {
  const ground = L.H - Math.max(3, Math.round(L.H * 0.1));
  drawSky(P, SKIES.night, ground);
  drawStars(P, env, ground, env.trend === 'up');
  drawMoon(P, Math.min(L.sun[0] + 1, L.plate.x - 4), L.sun[1] + 1, L.H > 40 ? 3 : 2);
  if (env.trend === 'eq') for (let i = 0; i < 3; i++) drawCloud(P, env.rng.int(0, L.W - 10), env.rng.int(1, 8), env.rng.int(7, 11), 'cloudShade', 'night', true);
  // Силуэты домов.
  const plate = L.plate;
  let x = -1;
  while (x < L.W) {
    const w = env.rng.int(4, 9);
    const h = env.rng.int(Math.round(L.H * 0.22), Math.round(L.H * 0.48));
    const top = ground - h;
    const k = env.rng.pick(['nightDeep', 'ink', 'night']);
    P.rect(x, top, w, h, k, true);
    if (env.rng.chance(0.25)) { // антенна с красным огоньком
      const ax = x + Math.floor(w / 2);
      P.rect(ax, top - 3, 1, 3, 'ink', true);
      P.px(ax, top - 4, 'red', true);
    }
    if (env.season === 'winter') P.rect(x, top - 1, w, 1, 'cloud', true);
    for (let wy = top + 2; wy < ground - 1; wy += 2) {
      for (let wx = x + 1; wx < x + w - 1; wx += 2) {
        const r = env.rng.next();
        if (r < 0.35) P.px(wx, wy, 'gold', true);
        else if (r < 0.45) P.px(wx, wy, 'duskOrange', true);
        else if (r < 0.5) P.px(wx, wy, 'water', true);
      }
    }
    x += w + (env.rng.chance(0.3) ? 1 : 0);
  }
  // Дорога с разметкой.
  P.rect(0, ground, L.W, L.H - ground, 'ink', true);
  P.rect(0, ground, L.W, 1, 'night', true);
  for (let rx = 1; rx < L.W; rx += 6) P.rect(rx, ground + Math.floor((L.H - ground) / 2), 3, 1, 'gold', true);
  if (env.trend === 'down') {
    if (env.season === 'winter') drawSnowflakes(P, env, ground, Math.round(L.W * L.H / 45));
    else drawRain(P, env, 0, L.W - 1, 0, ground, Math.round(L.W * L.H / 40));
  } else if (env.season === 'winter') {
    drawSnowflakes(P, env, ground, Math.round(L.W * L.H / 110));
  }
  drawGlassPlate(P, plate);
}

// =====================================================================
//  Текст на табличке
// =====================================================================
function themeFor(scene) {
  if (scene === 'city') {
    return { text: color('cloud'), sub: color('cloud', 0.72), up: 'grassLight', down: 'red', eq: 'cloudShade', bar: 'cloudShade', hi: 'gold' };
  }
  return { text: color('ink'), sub: color('ink', 0.65), up: 'grassDark', down: 'red', eq: 'trunk', bar: scene === 'cloud' ? 'cloudShade' : 'trunk', hi: scene === 'cloud' ? 'water' : 'leafOrange' };
}

function fitSize(chars, widthPt, max, min = 7) {
  return Math.max(min, Math.min(max, Math.floor(widthPt / (Math.max(1, chars) * CHAR_W))));
}

function drawText(P, s, x, y, w, size, col, align = 'left', medium = false) {
  const c = P.ctx;
  c.setFont(medium ? Font.mediumMonospacedSystemFont(size) : Font.boldMonospacedSystemFont(size));
  c.setTextColor(col);
  if (align === 'right') c.setTextAlignedRight();
  else if (align === 'center') c.setTextAlignedCenter();
  else c.setTextAlignedLeft();
  c.drawTextInRect(s, new Rect(x, y, w, size * 1.35));
}

// Пиксельная стрелка тренда (рисуем сами — не зависим от глифов ▲▼ в шрифте).
const ARROWS = {
  up: ['..#..', '.###.', '#####'],
  down: ['#####', '.###.', '..#..'],
  eq: ['#####', '.....', '#####'],
};
function drawArrow(P, trend, x, y, unit, theme) {
  const shape = ARROWS[trend];
  if (!shape) return;
  const c = color(theme[trend]);
  shape.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') P.ptRect(x + rx * unit, y + ry * unit, unit, unit, c);
  });
}

// Внутренняя область таблички в точках: отступаем от рамки и нижней тени доски.
function plateInnerPt(r, scene) {
  const side = scene === 'cloud' ? 1 : 1.6;
  return { x: (r.x + side) * CELL, y: (r.y + 1) * CELL + 2, w: (r.w - side * 2) * CELL, h: (r.h - 3) * CELL - 2 };
}

// Небольшой виджет: одна пара.
function drawSmallContent(P, box, model, theme) {
  const row = model.rows[0];
  const head = `${model.amount} ${model.base} =`;
  const hs = fitSize(head.length, box.w, 13);
  const vs = fitSize(row.value.length, box.w, 28);
  const cs = Math.min(18, vs);
  const fs = 9;
  const unit = Math.max(2, Math.round(cs / 6));
  const total = hs * 1.3 + vs * 1.25 + cs * 1.3 + fs * 1.3;
  const gap = Math.max(0, (box.h - total) / 3);
  let y = box.y;
  drawText(P, head, box.x, y, box.w, hs, theme.sub);
  y += hs * 1.3 + gap;
  drawText(P, row.value, box.x, y, box.w, vs, theme.text);
  y += vs * 1.25 + gap;
  drawText(P, row.code, box.x, y, box.w, cs, theme.text);
  drawArrow(P, row.trend, box.x + row.code.length * cs * CHAR_W + unit * 2, y + cs * 0.35, unit, theme);
  y += cs * 1.3 + gap;
  drawText(P, model.shortDate, box.x, y, box.w, fs, theme.sub, 'left', true);
}

// Средний и большой: строки «RUB   3 012.45 ▲».
function drawRowsContent(P, box, model, theme, opts) {
  const rows = model.rows;
  const head = `${model.amount} ${model.base} =`;
  const hs = fitSize(head.length, box.w, opts.headMax);
  const arrowW = Math.max(2, Math.round(opts.rowMax / 6)) * 7; // стрелка 5 «пикселей» + зазор
  const maxChars = Math.max(...rows.map((r) => r.code.length + 1 + r.value.length));
  const rs = fitSize(maxChars, box.w - arrowW, opts.rowMax, 9);
  const fs = opts.footSize;
  const chartH = opts.chartH || 0;
  const total = hs * 1.3 + rows.length * rs * 1.3 + chartH + fs * 1.3;
  const gap = Math.max(0, (box.h - total) / (rows.length + (chartH ? 2 : 1)));
  let y = box.y;
  drawText(P, head, box.x, y, box.w, hs, theme.sub);
  y += hs * 1.3 + gap * 0.6;
  const unit = Math.max(2, Math.round(rs / 6));
  for (const r of rows) {
    drawText(P, r.code, box.x, y, box.w, rs, theme.text);
    drawText(P, r.value, box.x, y, box.w - arrowW, rs, theme.text, 'right');
    drawArrow(P, r.trend, box.x + box.w - unit * 5, y + rs * 0.38, unit, theme);
    y += rs * 1.3 + gap;
  }
  if (chartH) {
    opts.drawChart(box.x, y, box.w, chartH);
    y += chartH + gap * 0.5;
  }
  drawText(P, model.dateLabel, box.x, box.y + box.h - fs * 1.3, box.w, fs, theme.sub, 'left', true);
}

// Мини-график: столбики за 14 дней, сегодняшний подсвечен.
function drawChart(P, x, y, w, h, series, label, theme) {
  const ls = 9;
  if (series.length < 2) {
    drawText(P, 'История курса копится…', x, y + h / 2 - ls, w, ls, theme.sub, 'left', true);
    return;
  }
  const vals = series.map((p) => p.v);
  const min = Math.min(...vals); const max = Math.max(...vals);
  const fmt = (v) => (v >= 100 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toPrecision(5));
  drawText(P, `${label}  ${fmt(min)}–${fmt(max)}`, x, y, w, ls, theme.sub, 'left', true);
  const top = y + ls * 1.5;
  const u = CELL / 2; // пиксель графика — половина клетки сцены
  const rows = Math.floor((h - ls * 1.5) / u) - 1;
  const n = series.length;
  const totalUnits = Math.floor(w / u);
  const barW = Math.max(1, Math.floor((totalUnits - (n - 1)) / n));
  const x0 = x + (w - (n * barW + (n - 1)) * u) / 2;
  const barCol = color(theme.bar); const hiCol = color(theme.hi); const baseCol = theme.sub;
  series.forEach((p, i) => {
    const hh = max === min ? Math.round(rows / 2) : 2 + Math.round(((p.v - min) / (max - min)) * (rows - 2));
    const bx = x0 + i * (barW + 1) * u;
    const by = top + (rows - hh) * u;
    P.ptRect(bx, by, barW * u, hh * u, i === n - 1 ? hiCol : barCol);
  });
  P.ptRect(x0, top + rows * u, (n * barW + (n - 1)) * u, u, baseCol);
}

// =====================================================================
//  Виджеты
// =====================================================================
function scriptUrl(cfg) {
  try {
    return `${URLScheme.forRunningScript()}?action=convert&p=${encodeURIComponent(configToParam(cfg))}`;
  } catch (e) {
    return null;
  }
}

function renderImageWidget(family, cfg, data, overrides) {
  const L = layoutFor(family);
  const targets = family === 'small' ? cfg.targets.slice(0, 1)
    : family === 'medium' ? cfg.targets.slice(0, 2)
      : threeTargets(cfg);
  const model = buildModel(cfg, data, targets);
  const env = makeEnv(model.trend, overrides);
  const scene = cfg.scene;
  const P = new Pix(L.W, L.H, CELL);
  if (scene === 'city') renderCityScene(P, L, env);
  else renderFieldScene(P, L, env, scene === 'cloud' ? 'cloud' : 'sign');

  const theme = themeFor(scene);
  const box = plateInnerPt(L.plate, scene);
  if (family === 'small') {
    drawSmallContent(P, box, model, theme);
  } else if (family === 'medium') {
    drawRowsContent(P, box, model, theme, { headMax: 13, rowMax: 21, footSize: 9 });
  } else {
    const series = buildSeries(cfg, targets[0], data);
    const xl = family === 'extraLarge';
    drawRowsContent(P, box, model, theme, {
      headMax: xl ? 18 : 15, rowMax: xl ? 30 : 24, footSize: 10, chartH: xl ? 64 : 80,
      drawChart: (x, y, w, h) => drawChart(P, x, y, w, h, series, `${cfg.base}→${targets[0]}, 14 дн.`, theme),
    });
  }
  const w = new ListWidget();
  w.backgroundImage = P.image();
  w.backgroundColor = color('nightDeep');
  w.setPadding(0, 0, 0, 0);
  return w;
}

const ARROW_CHAR = { up: '▲', down: '▼', eq: '=' };

function renderAccessory(family, cfg, data) {
  const model = buildModel(cfg, data, cfg.targets.slice(0, 2));
  const w = new ListWidget();
  const r0 = model.rows[0];
  if (family === 'accessoryInline') {
    const arrow = r0.trend === 'up' || r0.trend === 'down' ? ` ${ARROW_CHAR[r0.trend]}` : '';
    w.addText(`${model.amount} ${model.base} = ${r0.value} ${r0.code}${arrow}`);
    return w;
  }
  if (family === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const code = w.addText(r0.code); code.font = Font.boldSystemFont(10); code.centerAlignText();
    const v = w.addText(r0.value.replace(/ /g, '')); v.font = Font.boldMonospacedSystemFont(14);
    v.minimumScaleFactor = 0.4; v.lineLimit = 1; v.centerAlignText();
    const a = w.addText(ARROW_CHAR[r0.trend] || '·'); a.font = Font.boldSystemFont(10); a.centerAlignText();
    return w;
  }
  // accessoryRectangular
  const head = w.addText(`${model.amount} ${model.base} · ${model.shortDate}`);
  head.font = Font.semiboldSystemFont(11); head.textOpacity = 0.75; head.lineLimit = 1; head.minimumScaleFactor = 0.6;
  for (const r of model.rows) {
    const t = w.addText(`${ARROW_CHAR[r.trend] || '·'} ${r.value} ${r.code}`);
    t.font = Font.boldMonospacedSystemFont(15); t.lineLimit = 1; t.minimumScaleFactor = 0.5;
  }
  return w;
}

function errorWidget(family, err) {
  const w = new ListWidget();
  const text = err instanceof UserError ? err.message : `Что-то пошло не так:\n${err && err.message ? err.message : err}`;
  if (family && family.startsWith('accessory')) {
    const t = w.addText(family === 'accessoryInline' ? 'Курсы: ошибка' : text);
    t.font = Font.systemFont(11); t.minimumScaleFactor = 0.5;
    return w;
  }
  const g = new LinearGradient();
  g.colors = [color('nightDeep'), color('night')];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(12, 12, 12, 12);
  const title = w.addText('Курсы НБРБ');
  title.font = Font.boldMonospacedSystemFont(13); title.textColor = color('gold');
  w.addSpacer(6);
  const body = w.addText(text);
  body.font = Font.systemFont(12); body.textColor = color('cloud'); body.minimumScaleFactor = 0.6;
  w.addSpacer();
  const hint = w.addText('Нажмите, чтобы открыть');
  hint.font = Font.systemFont(9); hint.textColor = color('cloudShade');
  return w;
}

async function buildWidget(family, cfg, data, overrides) {
  const w = family.startsWith('accessory') ? renderAccessory(family, cfg, data) : renderImageWidget(family, cfg, data, overrides);
  const url = scriptUrl(cfg);
  if (url) w.url = url;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);
  return w;
}

async function runWidget(param) {
  const family = config.widgetFamily || 'medium';
  let widget;
  try {
    const cfg = resolveConfig(param, loadSettings());
    const data = await loadData();
    widget = await buildWidget(family, cfg, data);
  } catch (e) {
    log(`[pixel-fx] виджет: ${e.stack || e}`);
    widget = errorWidget(family, e);
    widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  }
  Script.setWidget(widget);
}

// =====================================================================
//  Приложение: мастер, меню, конвертер
// =====================================================================
async function choose(title, message, options, cancel = 'Отмена') {
  const a = new Alert();
  a.title = title;
  if (message) a.message = message;
  options.forEach((o) => a.addAction(o));
  if (cancel) a.addCancelAction(cancel);
  return a.presentSheet(); // -1 — отмена
}

async function info(title, message) {
  const a = new Alert();
  a.title = title; a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}

const curLabel = (c) => `${c} — ${CUR_NAMES[c]}`;

async function wizard(current) {
  const base0 = await choose('Шаг 1 из 4', 'Базовая валюта — из какой считаем?', CURRENCIES.map(curLabel));
  if (base0 < 0) return null;
  const base = CURRENCIES[base0];

  const rest = CURRENCIES.filter((c) => c !== base);
  const t1i = await choose('Шаг 2 из 4', `В какую валюту переводим ${base}?`, rest.map(curLabel));
  if (t1i < 0) return null;
  const t1 = rest[t1i];

  const rest2 = rest.filter((c) => c !== t1);
  const t2i = await choose('Шаг 2 из 4', 'Добавить вторую валюту?', ['Не нужно'].concat(rest2.map(curLabel)));
  if (t2i < 0) return null;
  const targets = t2i === 0 ? [t1] : [t1, rest2[t2i - 1]];

  const amounts = ['1', '100', '1000'];
  const ai = await choose('Шаг 3 из 4', `Сколько ${base} показывать на виджете?`, amounts.map((a) => `${a} ${base}`));
  if (ai < 0) return null;

  const sceneKeys = Object.keys(SCENES);
  const si = await choose('Шаг 4 из 4', 'Какую картинку нарисовать?', sceneKeys.map((k) => SCENES[k]));
  if (si < 0) return null;

  const settings = { base, targets, amount: amounts[ai], scene: sceneKeys[si] };
  writeJSON(SETTINGS_FILE, settings);
  await info('Готово!', 'Настройки сохранены. Сейчас покажу, как будет выглядеть виджет.\n\nДобавьте виджет Scriptable на экран «Домой» и выберите этот скрипт.');
  return settings;
}

function resultText(base, amountMinor, targets, data) {
  const lines = [];
  for (const t of targets) {
    const v = convertMinor(amountMinor, base, t, data.rates);
    const tr = trendOf(base, t, data.rates, data.prevRates);
    lines.push(`${fmtMoney(v)} ${t} ${ARROW_CHAR[tr] || ''}`.trim());
  }
  return lines;
}

async function converter(cfg) {
  let data;
  try {
    data = await loadData();
  } catch (e) {
    await info('Нет курсов', e.message || String(e));
    return;
  }
  let base = cfg.base;
  let targets = cfg.targets.slice();
  let amountText = fmtAmount(cfg.amountMinor).replace(/ /g, '');
  let copied = false;

  for (;;) {
    const ask = new Alert();
    ask.title = 'Конвертер';
    ask.message = `Сколько ${base}?`;
    const tf = ask.addTextField('Сумма', amountText);
    tf.setDecimalPadKeyboard();
    ask.addAction('Посчитать');
    ask.addCancelAction('Закрыть');
    if ((await ask.presentAlert()) < 0) return;
    const minor = parseAmount(ask.textFieldValue(0));
    if (!minor) {
      await info('Не поняла сумму 🙂', 'Введите число, например 150 или 99.90');
      continue;
    }
    amountText = fmtAmount(minor).replace(/ /g, '');

    // Экран результата: можно скопировать, перевернуть направление, ввести новую сумму.
    for (;;) {
      const lines = resultText(base, minor, targets, data);
      const rates = targets.map((t) => `1 ${base} = ${fmtRate(rate4(base, t, data.rates))} ${t}`);
      const res = new Alert();
      res.title = `${copied ? '✓ Скопировано\n' : ''}${fmtAmount(minor)} ${base} =`;
      res.message = `${lines.join('\n')}\n\n${rates.join('\n')}\n${data.offline ? `офлайн · курс от ${ddmm(data.rateDate)}` : `Курс НБРБ на ${ddmmyyyy(data.rateDate)}`}`;
      res.addAction('Скопировать');
      res.addAction(`Поменять направление (${targets[0]} → ${base})`);
      res.addAction('Другая сумма');
      res.addCancelAction('Готово');
      const i = await res.presentAlert();
      copied = false;
      if (i < 0) return;
      if (i === 0) {
        Pasteboard.copy(lines.map((l) => `${fmtAmount(minor)} ${base} = ${l.replace(/ [▲▼=]$/, '')}`).join('\n'));
        copied = true;
        continue;
      }
      if (i === 1) {
        const newBase = targets[0];
        targets = [base].concat(targets.slice(1)).filter((c) => c !== newBase);
        base = newBase;
        continue;
      }
      break; // «Другая сумма»
    }
  }
}

async function pickFamily() {
  const fams = ['small', 'medium', 'large', 'accessoryRectangular', 'accessoryInline'];
  const i = await choose('Какой размер?', null, ['Маленький', 'Средний', 'Большой', 'Экран блокировки (прямоугольный)', 'Экран блокировки (строка)']);
  return i < 0 ? null : fams[i];
}

async function presentWidget(w, family) {
  const fn = {
    small: 'presentSmall', medium: 'presentMedium', large: 'presentLarge', extraLarge: 'presentExtraLarge',
    accessoryRectangular: 'presentAccessoryRectangular', accessoryInline: 'presentAccessoryInline', accessoryCircular: 'presentAccessoryCircular',
  }[family];
  if (typeof w[fn] === 'function') await w[fn]();
  else await w.presentMedium();
}

async function previewWidget(cfg, overrides) {
  const family = await pickFamily();
  if (!family) return;
  try {
    const data = await loadData();
    const w = await buildWidget(family, cfg, data, overrides);
    await presentWidget(w, family);
  } catch (e) {
    await presentWidget(errorWidget(family, e), family);
  }
}

// Тест сцен: сезон, время суток, тренд — без подмены даты в коде.
async function sceneTest(cfg) {
  const seasons = ['spring', 'summer', 'autumn', 'winter'];
  const si = await choose('Сезон', null, ['Весна', 'Лето', 'Осень', 'Зима']);
  if (si < 0) return;
  const tods = ['dawn', 'day', 'dusk', 'night'];
  const ti = await choose('Время суток', null, ['Рассвет', 'День', 'Закат', 'Ночь']);
  if (ti < 0) return;
  const trends = ['up', 'down', 'eq'];
  const ri = await choose('Курс', null, ['▲ вырос — солнце', '▼ упал — дождь', '= не изменился — облачно']);
  if (ri < 0) return;
  const sceneKeys = Object.keys(SCENES);
  const ci = await choose('Сцена', null, sceneKeys.map((k) => SCENES[k]));
  if (ci < 0) return;
  const di = await choose('Тема', null, ['Как в системе', 'Светлая', 'Тёмная']);
  if (di < 0) return;
  const overrides = { season: seasons[si], tod: tods[ti], trend: trends[ri], salt: String(Date.now()) };
  if (di > 0) overrides.dark = di === 2;
  await previewWidget(Object.assign({}, cfg, { scene: sceneKeys[ci] }), overrides);
}

async function menu(settings) {
  for (;;) {
    const cfg = resolveConfig('', settings);
    const i = await choose(`Курсы НБРБ · v${VERSION}`, `${fmtAmount(cfg.amountMinor)} ${cfg.base} → ${cfg.targets.join(', ')}`,
      ['Конвертер', 'Настройки', 'Посмотреть виджет', 'Тест сцен (сезон, время)', 'Обновить курсы'], 'Закрыть');
    if (i < 0) return;
    if (i === 0) await converter(cfg);
    if (i === 1) { const s = await wizard(settings); if (s) { settings = s; await previewWidget(resolveConfig('', s)); } }
    if (i === 2) await previewWidget(cfg);
    if (i === 3) await sceneTest(cfg);
    if (i === 4) {
      try {
        const d = await loadData(true);
        await info(d.offline ? 'Нет связи' : 'Курсы обновлены', d.offline ? `Показываю сохранённый курс от ${ddmmyyyy(d.rateDate)}.\n${d.netError || ''}` : `Курс НБРБ на ${ddmmyyyy(d.rateDate)}.`);
      } catch (e) {
        await info('Нет связи', e.message || String(e));
      }
    }
  }
}

async function main() {
  const query = args.queryParameters || {};
  const param = String(args.widgetParameter || query.p || '').trim();

  if (config.runsInWidget || config.runsInAccessoryWidget) {
    await runWidget(param);
    return;
  }

  try {
    let settings = loadSettings();
    if (!settings) {
      settings = await wizard();
      if (!settings) return;
      await previewWidget(resolveConfig('', settings));
      return;
    }
    if (query.action === 'convert') {
      // Тап по виджету: открываем конвертер с парой именно этого виджета.
      let cfg;
      try { cfg = resolveConfig(param, settings); } catch (e) { cfg = resolveConfig('', settings); }
      await converter(cfg);
      return;
    }
    await menu(settings);
  } catch (e) {
    log(`[pixel-fx] ${e.stack || e}`);
    await info('Ошибка', e instanceof UserError ? e.message : String(e.message || e));
  } finally {
    Script.complete();
  }
}

// Тестовый стенд (dev/preview.html) подключает скрипт без запуска main().
if (typeof globalThis.__PIXELFX_TEST__ === 'object' && globalThis.__PIXELFX_TEST__) {
  globalThis.__PIXELFX_TEST__.exports = {
    renderImageWidget, renderAccessory, buildWidget, loadData, resolveConfig, parseParam, parseAmount,
    convertMinor, rate4, trendOf, fmtMoney, fmtRate, parseRates, errorWidget, layoutFor,
  };
} else {
  await main();
}
