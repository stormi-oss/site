// PIXEL_FX_MAIN — эта метка нужна загрузчику, не удаляйте её.
// =====================================================================
//  Курсы НБРБ — живописный виджет-конвертер для Scriptable (iOS)
//  Курсы: Национальный банк Республики Беларусь (api.nbrb.by)
//  Валюты: BYN, RUB, UAH, USD, EUR, CNY, KZT
//
//  Ничего настраивать в коде не нужно:
//   • первый запуск в приложении — мастер настройки;
//   • поле Parameter у виджета: BYN:RUB,USD:100  (база:цели:сумма[:сцена])
//     сцена: field — ночное поле, med — медицинский монитор.
//   • тап по виджету — конвертер; в меню — живая анимация сцены.
// =====================================================================

const VERSION = '2.0.0';

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

const SCENES = {
  field: 'Ночное поле',
  med: 'Медицина: монитор',
};
// Старые названия сцен из версии 1.x продолжают работать.
const SCENE_ALIASES = { sign: 'field', cloud: 'field', city: 'field', night: 'field', medicine: 'med', monitor: 'med' };
const sceneKey = (k) => { const v = String(k || '').toLowerCase(); return SCENES[v] ? v : SCENE_ALIASES[v] || null; };
const DEFAULT_SETTINGS = { base: 'BYN', targets: ['RUB', 'USD'], amount: '1', scene: 'field' };


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
    scene: sceneKey(s.scene) || 'field',
  };
}

function normalizeTargets(base, targets) {
  const out = [];
  for (const t of targets) if (CURRENCIES.includes(t) && t !== base && !out.includes(t)) out.push(t);
  return out;
}

// Параметр: «BYN:RUB,USD:100» или «BYN:RUB,USD:100:med». Любая часть может отсутствовать.
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
    const sc = sceneKey(parts[3]);
    if (!sc) throw bad();
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
//  SceneKit — движок сцен. Чистый JS без API Scriptable:
//  один и тот же код рисует кадр виджета (DrawContext) и живую
//  анимацию в WebView (canvas). Поэтому внутри — только математика
//  и вызовы «художника» P: rect, ellipse, poly, path, strokes,
//  vgrad, glow, rrect, text.
// =====================================================================
function SceneKit() {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const mod = (a, n) => ((a % n) + n) % n;
  const alphaOf = (c) => (c.length > 3 ? c[3] : 1);
  const hex = (h, a) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a === undefined ? 1 : a]; };
  const A = (c, a) => [c[0], c[1], c[2], a];
  const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t), lerp(alphaOf(c1), alphaOf(c2), t)];
  const WHITE = [255, 255, 255, 1];
  const BLACK = [0, 0, 0, 1];

  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // Детерминированный генератор: одинаковый seed — одинаковая картинка.
  function rng(seed) {
    let a = seed >>> 0;
    const f = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = (lo, hi) => lo + f() * (hi - lo);
    f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
    f.chance = (p) => f() < p;
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    return f;
  }
  function sampleStops(stops, t) {
    t = clamp(t, 0, 1);
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [ta, ca] = stops[i];
    const [tb, cb] = stops[i + 1];
    return mix(ca, cb, tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0);
  }

  // ---------- текст: оценка ширины (у DrawContext нет измерения текста) ----------
  const CHAR_W = { mono: 0.62, round: 0.6 };
  function fit(str, width, max, min, kind) {
    const n = Math.max(1, String(str).length);
    return Math.max(min || 7, Math.min(max, Math.floor(width / (n * CHAR_W[kind || 'mono']))));
  }
  function arrow(P, trend, x, y, s, th) {
    const c = th[trend];
    if (!c) return;
    if (trend === 'up') P.poly([x, y + s * 0.85, x + s / 2, y + s * 0.1, x + s, y + s * 0.85], c);
    else if (trend === 'down') P.poly([x, y + s * 0.15, x + s, y + s * 0.15, x + s / 2, y + s * 0.9], c);
    else { P.rrect(x, y + s * 0.28, s, s * 0.15, s * 0.07, c); P.rrect(x, y + s * 0.58, s, s * 0.15, s * 0.07, c); }
  }
  const fmtNum = (v) => (v >= 100 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toPrecision(5));

  // =====================================================================
  //  СЦЕНА 1. Ночное поле: небо, облака под луной, холмы, поле,
  //  одинокое дерево, старая машина, светлячки.
  // =====================================================================
  const SKY = {
    night: { sky: [[0, '#02040a'], [0.45, '#071121'], [0.8, '#0f2238'], [1, '#1b3a52']], cloudLit: '#f1dcab', cloudMid: '#6c7275', cloudShadow: '#121a25', hill: '#0a161b', rim: '#35585a', light: '#f8ecd2', tint: '#040b15', tintAmt: 0.5, stars: 1, haze: '#1f4256' },
    dusk: { sky: [[0, '#151938'], [0.4, '#463360'], [0.75, '#bd6679'], [1, '#f3a86b']], cloudLit: '#ffc890', cloudMid: '#a05e7b', cloudShadow: '#2c2346', hill: '#241e3a', rim: '#d68a6a', light: '#ffb470', tint: '#2a1c3a', tintAmt: 0.32, stars: 0.35, haze: '#e39a76' },
    dawn: { sky: [[0, '#1a2250'], [0.45, '#5c5a8e'], [0.8, '#e5a0a2'], [1, '#ffd4a2']], cloudLit: '#ffe2ba', cloudMid: '#b78aa7', cloudShadow: '#464571', hill: '#33355a', rim: '#f0b090', light: '#ffdaa8', tint: '#2a2c55', tintAmt: 0.3, stars: 0.25, haze: '#f2c2a8' },
    day: { sky: [[0, '#1f62ad'], [0.55, '#5d9fd8'], [1, '#d2e8f3']], cloudLit: '#ffffff', cloudMid: '#dbe4ee', cloudShadow: '#8ea3b9', hill: '#4c7c64', rim: '#a8c9a0', light: '#fff4d6', tint: '#000000', tintAmt: 0, stars: 0, haze: '#d2e8f3' },
  };
  const SEASON = {
    summer: { grass: ['#2b6828', '#378030', '#47943a', '#5ea947', '#80c05a'], far: '#4c8a3e', near: '#3a8331', crown: ['#143a1c', '#225428', '#377234', '#579545'], flowers: ['#f1d76a', '#ffffff', '#8fb8f0'], flowerRate: 0.6, leaves: ['#47943a', '#80c05a'] },
    spring: { grass: ['#387a2b', '#489135', '#60a742', '#7ebc51', '#a2d169'], far: '#5a9945', near: '#478f37', crown: ['#224f29', '#387234', '#589845', '#84bf5e'], flowers: ['#f6d36b', '#ffffff', '#f4a6c6', '#9fc0ff'], flowerRate: 1.5, blossom: ['#f7c9d9', '#ffffff', '#f19bbb'], leaves: ['#f7c9d9', '#ffffff'] },
    autumn: { grass: ['#56682a', '#76782e', '#8c8234', '#a38a3a', '#677830'], far: '#78783a', near: '#686e2f', crown: ['#6a2f10', '#9a4515', '#c96a20', '#eeaa45'], flowers: ['#e8c060'], flowerRate: 0.15, leaves: ['#c3611c', '#eaa23c', '#a8321c'] },
    winter: { grass: ['#93a5ba', '#b6c4d4', '#7b8ca2'], far: '#c7d4e3', near: '#eef3f8', crown: null, flowers: [], flowerRate: 0, leaves: null, snow: true },
  };

  function fieldPalette(S) {
    const b = SKY[S.tod] || SKY.night;
    const se = SEASON[S.season] || SEASON.summer;
    const tint = (h, k) => mix(hex(h), hex(b.tint), b.tintAmt * (k === undefined ? 1 : k));
    return {
      b, se,
      sky: b.sky.map(([t, h]) => [t, hex(h)]),
      cloudLit: hex(b.cloudLit), cloudMid: hex(b.cloudMid), cloudShadow: hex(b.cloudShadow),
      hill: hex(b.hill), rim: hex(b.rim), light: hex(b.light), haze: hex(b.haze),
      grass: se.grass.map((h) => tint(h, 0.8)), far: tint(se.far, 0.95), near: tint(se.near, 0.75),
      crown: se.crown ? se.crown.map((h) => tint(h, 1.05)) : null,
      flowers: se.flowers.map((h) => tint(h, 0.55)),
      blossom: se.blossom ? se.blossom.map((h) => tint(h, 0.6)) : null,
      leaves: se.leaves ? se.leaves.map((h) => tint(h, 0.6)) : null,
      trunk: tint('#2c2218', 0.9), bark: tint('#5a4632', 0.9), snow: tint('#f4f8fc', 0.45),
      car: tint(S.tod === 'day' ? '#3e5c5e' : '#34484b', 0.9), carDark: tint('#121719', 0.4),
      glass: tint('#6d8a96', 0.9), chrome: tint('#d5dde0', 0.7),
    };
  }

  // Раскладка поля по размеру виджета (в точках).
  function fieldLayout(S) {
    const W = S.W; const H = S.H; const f = S.family;
    if (f === 'small') return { horizon: H * 0.58, tree: { x: W * 0.68, s: H * 0.2 }, car: false, panel: { x: 8, y: H * 0.5, w: W - 16, h: H * 0.5 - 8 }, light: [W * 0.18, H * 0.16] };
    if (f === 'medium') return { horizon: H * 0.64, tree: { x: W * 0.77, s: H * 0.25 }, car: true, panel: { x: 10, y: 10, w: W * 0.55, h: H - 20 }, light: [W * 0.94, H * 0.15] };
    if (f === 'large') return { horizon: H * 0.6, tree: { x: W * 0.74, s: H * 0.2 }, car: true, panel: { x: 12, y: 12, w: W * 0.6, h: H * 0.56 }, light: [W * 0.88, H * 0.09] };
    if (f === 'extraLarge') return { horizon: H * 0.66, tree: { x: W * 0.77, s: H * 0.2 }, car: true, panel: { x: 14, y: 14, w: W * 0.48, h: H - 28 }, light: [W * 0.6, H * 0.13] };
    // live — полноэкранная анимация (портрет)
    const ph = Math.min(H * 0.34, 300);
    return { horizon: H * 0.7, tree: { x: W * 0.64, s: Math.min(W, H) * 0.2 }, car: true, panel: { x: 16, y: Math.max(54, H * 0.07), w: W - 32, h: ph }, light: [W * 0.22, Math.max(54, H * 0.07) + ph + H * 0.07] };
  }

  function drawStars(P, S, C, L, t, twinkleOnly) {
    if (C.b.stars <= 0) return;
    const R = rng(S.seedDay ^ 0x51ed);
    const n = Math.round((P.W * L.horizon) / 230 * C.b.stars * (S.trend === 'up' ? 1.3 : 1));
    for (let i = 0; i < n; i++) {
      const x = R() * P.W;
      const y = Math.pow(R(), 1.3) * L.horizon * 0.92;
      const r = 0.3 + Math.pow(R(), 3) * 1.1;
      const fade = 1 - (y / L.horizon) * 0.65;
      let a = (0.25 + R() * 0.75) * fade;
      const warm = R() < 0.25;
      const tw = R() < 0.18;
      const ph = R() * 6.28;
      if (twinkleOnly !== tw) continue; // мерцающие рисуются в динамическом слое
      if (tw) a *= 0.55 + 0.45 * Math.sin(t * (1.5 + ph * 0.3) + ph);
      const c = warm ? [255, 232, 196, a] : [235, 242, 255, a];
      P.ellipse(x, y, r, r, c);
      if (r > 1.05) {
        P.glow(x, y, r * 6, A(c, a * 0.35));
        P.strokes([x - r * 4, y, x + r * 4, y, x, y - r * 4, x, y + r * 4], A(c, a * 0.35), 0.5);
      }
    }
  }

  function fieldBack(P, S, C, L) {
    const W = P.W;
    P.vgrad(0, 0, W, Math.ceil(L.horizon) + 2, C.sky);
    drawStars(P, S, C, L, 0, false);
    const [lx, ly] = L.light;
    const k = Math.min(W, P.H) / 160;
    if (S.tod === 'night') {
      P.glow(lx, ly, 70 * k, A(C.light, 0.22));
      P.glow(lx, ly, 22 * k, A(C.light, 0.45));
      P.ellipse(lx, ly, 7 * k, 7 * k, C.light);
      P.ellipse(lx - 2 * k, ly + 1.5 * k, 1.8 * k, 1.5 * k, A(mix(C.light, C.cloudMid, 0.5), 0.5));
      P.ellipse(lx + 2.5 * k, ly - 2 * k, 1.2 * k, 1.1 * k, A(mix(C.light, C.cloudMid, 0.5), 0.45));
    } else if (S.tod === 'day') {
      if (S.trend !== 'down') { P.glow(lx, ly, 90 * k, A(C.light, 0.5)); P.ellipse(lx, ly, 9 * k, 9 * k, A(WHITE, 0.95)); }
    } else { // низкое солнце у горизонта
      const sx = S.tod === 'dawn' ? W * 0.12 : W * 0.3;
      P.glow(sx, L.horizon, 140 * k, A(C.light, 0.55));
      P.glow(sx, L.horizon, 40 * k, A(C.light, 0.7));
    }
    // дымка у горизонта
    P.vgrad(0, L.horizon - P.H * 0.14, W, P.H * 0.14 + 1, [[0, A(C.haze, 0)], [1, A(C.haze, 0.3)]]);
  }

  // Кучевое облако: «купол» из множества клубов. Каждый клуб затеняется целиком
  // (тень → полутон → освещённая шапка), рисуем снизу вверх — верхние клубы
  // перекрывают нижние, и получается объём, как на живописных фонах.
  function cloud(P, x, y, w, C, seed, dark, light) {
    const R = rng(seed);
    const h = w * 0.42;
    const lit = mix(C.cloudLit, C.cloudShadow, dark);
    const mid = mix(C.cloudMid, C.cloudShadow, dark * 0.6);
    const sh = C.cloudShadow;
    const cx0 = x + w / 2; const base = y + h;
    let lx = light[0] - cx0; let ly = Math.min(light[1] - (y + h / 2), -Math.abs(light[0] - cx0) * 0.5 - 20);
    const ln = Math.hypot(lx, ly) || 1; lx /= ln; ly /= ln;
    // рваные тёмные «хвосты» снизу
    for (let i = 0; i < 6; i++) P.ellipse(x + R() * w, base - h * (0.05 + R() * 0.12), w * (0.12 + R() * 0.22), h * (0.04 + R() * 0.05), A(sh, 0.25 + R() * 0.3));
    const puffs = [];
    const m = 26 + Math.round(w / 6);
    const peak = 0.3 + R() * 0.4; // где самая высокая «башня»
    for (let i = 0; i < m; i++) {
      const u = R();
      const dome = Math.max(0, 1 - Math.pow(Math.abs(u - peak) / (u < peak ? peak : 1 - peak), 1.6));
      const r = w * (0.035 + 0.06 * R()) * (0.55 + dome * 0.8);
      const py = base - r * 0.6 - dome * h * (0.35 + 0.55 * R());
      puffs.push([x + w * (0.04 + 0.92 * u), py, r]);
    }
    // Слои по всей массе облака: тень → полутон → мягкий свет. Мягкий свет — это
    // размытые пятна (glow), поэтому клубы сливаются, а не выглядят как «монетки».
    const ryOf = (py, r) => Math.min(r * 0.92, (base - py) + r * 0.25); // плоское дно
    for (const [px, py, r] of puffs) P.ellipse(px, py, r * 1.05, ryOf(py, r), A(sh, 0.97));
    for (const [px, py, r] of puffs) P.ellipse(px + lx * r * 0.18, py + ly * r * 0.2, r * 0.82, ryOf(py, r) * 0.78, A(mid, 0.55));
    for (const [px, py, r] of puffs) P.glow(px + lx * r * 0.4, py + ly * r * 0.42, r * 0.95, A(lit, 0.75), 6);
    for (const [px, py, r] of puffs) if (R() < 0.35) P.glow(px + lx * r * 0.55, py + ly * r * 0.55, r * 0.45, A(mix(lit, WHITE, 0.4), 0.6), 5);
    P.glow(cx0 + lx * w * 0.2, y + h * 0.4, w * 0.5, A(lit, 0.06));
  }

  // Облака дрейфуют: позиция зависит от времени, поэтому каждое обновление виджета — новый кадр.
  function fieldClouds(P, S, C, L, t) {
    const R = rng(S.seedDay ^ 0x9e37);
    const n = { up: 2, eq: 5, down: 6 }[S.trend] || 3;
    const T = S.epoch + t;
    // «главное» облако рядом со светом: оно всегда в кадре и медленно покачивается
    const hw = P.W * (S.family === 'small' ? 0.55 : 0.36);
    const side = L.light[0] > P.W / 2 ? -1 : 1;
    const hx = L.light[0] + side * hw * 0.15 - hw / 2 + Math.sin(T * 0.03) * P.W * 0.04;
    const hy = L.light[1] + P.H * 0.04;
    cloud(P, hx, hy, hw, C, (S.seedDay ^ 0x4e1d) >>> 0, S.trend === 'down' ? 0.55 : 0, L.light);
    for (let i = 0; i < n; i++) {
      const w = P.W * (0.26 + R() * 0.26) * (n > 4 ? 1.05 : 1.15);
      const y = L.horizon * (0.02 + R() * 0.42);
      const x0 = R() * (P.W + w);
      const speed = (3 + R() * 5) * (0.6 + S.wind.power * 0.25);
      const span = P.W + w * 1.6;
      const x = mod(x0 + T * speed * S.wind.dir, span) - w * 0.8;
      cloud(P, x, y, w, C, (S.seedDay + i * 7919) >>> 0, S.trend === 'down' ? 0.55 : 0, L.light);
    }
    drawStars(P, S, C, L, t, true);
  }

  function hills(P, C, hz, list) {
    for (const [cf, hf, wf] of list) {
      const cx = cf * P.W; const hh = hf * P.H; const ww = wf * P.W;
      const pts = [];
      for (let x = cx - ww; x <= cx + ww + 0.1; x += 4) {
        const u = (x - cx) / ww;
        const bell = (Math.cos(Math.PI * clamp(u, -1, 1)) + 1) / 2;
        pts.push([x, hz - hh * Math.pow(bell, 0.8) - Math.sin(x * 0.07) * 0.6]);
      }
      const cmds = [['M', cx - ww, hz + 1]].concat(pts.map((p) => ['L', p[0], p[1]])).concat([['L', cx + ww, hz + 1], ['Z']]);
      P.path(cmds, C.hill);
      P.path(pts.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]), A(C.rim, 0.35), 1);
    }
  }

  function treeBase(S, L) {
    const gy = L.horizon + (S.H - L.horizon) * 0.14;
    return { tx: L.tree.x, gy, s: L.tree.s };
  }

  // Голое зимнее дерево — рекурсивные ветки со снегом.
  function bareTree(P, C, tx, gy, s, sway) {
    const byDepth = [];
    const snow = [];
    const R = rng(4242);
    const grow = (x, y, ang, len, d) => {
      const x2 = x + Math.cos(ang) * len + sway * (7 - d) * 0.15;
      const y2 = y + Math.sin(ang) * len;
      (byDepth[d] = byDepth[d] || []).push(x, y, x2, y2);
      if (d >= 2 && R() < 0.6) snow.push(x, y - 0.8, x2, y2 - 0.8);
      if (d >= 7) return;
      const spread = 0.32 + R() * 0.25;
      grow(x2, y2, ang - spread, len * (0.68 + R() * 0.1), d + 1);
      grow(x2, y2, ang + spread, len * (0.68 + R() * 0.1), d + 1);
      if (d < 3 && R() < 0.5) grow(x2, y2, ang + (R() - 0.5) * 0.3, len * 0.6, d + 2);
    };
    grow(tx, gy - s * 0.95, -Math.PI / 2, s * 0.45, 1);
    byDepth.forEach((segs, d) => { if (segs) P.strokes(segs, C.trunk, Math.max(0.5, s * 0.07 * Math.pow(0.68, d))); });
    P.strokes(snow, A(C.snow, 0.75), 0.9);
  }

  function trunk(P, C, tx, gy, s, bare) {
    const h = s * 1.0;
    P.path([['M', tx - s * 0.08, gy + 1], ['Q', tx - s * 0.03, gy - h * 0.5, tx - s * 0.04, gy - h], ['L', tx + s * 0.04, gy - h], ['Q', tx + s * 0.03, gy - h * 0.5, tx + s * 0.09, gy + 1], ['Z']], C.trunk);
    P.path([['M', tx - s * 0.05, gy], ['Q', tx - s * 0.02, gy - h * 0.5, tx - s * 0.03, gy - h]], A(C.bark, 0.5), 0.8);
    if (!bare) {
      P.strokes([tx, gy - h * 0.75, tx - s * 0.5, gy - h * 1.2, tx, gy - h * 0.85, tx + s * 0.45, gy - h * 1.3, tx, gy - h, tx + s * 0.05, gy - h * 1.5], C.trunk, s * 0.035);
    }
  }

  // Крона из «комков» листвы: тёмный слой → средний → блики к свету. sway — покачивание от ветра.
  function crown(P, S, C, L, t) {
    const { tx, gy, s } = treeBase(S, L);
    if (!C.crown) { bareTree(P, C, tx, gy, s, Math.sin((S.epoch + t) * 0.7) * S.wind.power * 0.4); return; }
    const R = rng(S.seedStable);
    const cx = tx; const cy = gy - s * 1.38; const rx = s * 1.05; const ry = s * 0.8;
    let lx = L.light[0] - cx; let ly = Math.min(L.light[1] - cy, -40);
    const ln = Math.hypot(lx, ly) || 1; lx /= ln; ly /= ln;
    const T = S.epoch + t;
    const autumn = S.season === 'autumn';
    const clumps = [];
    const K = 95;
    for (let k = 0; k < K; k++) {
      const ang = R() * Math.PI * 2; const rr = Math.sqrt(R());
      const u = Math.cos(ang) * rr; let v = Math.sin(ang) * rr;
      if (v > 0.5) v = 0.5 + (v - 0.5) * 0.6;
      const r = s * (0.1 + R() * 0.11) * (1 - rr * 0.25);
      if (autumn && R() < 0.22) continue; // осенью крона реже
      const sway = Math.sin(T * 0.9 + u * 1.8) * s * 0.03 * (0.4 + S.wind.power * 0.4) * (1 - v) * 0.5;
      clumps.push([cx + u * rx + sway, cy + v * ry, r, u, v]);
    }
    // сначала теневая масса, затем каждый комок от тёмной стороны к светлой
    P.ellipse(cx + s * 0.05, cy + s * 0.1, rx * 0.92, ry * 0.85, C.crown[0]);
    clumps.sort((a, b) => (a[3] * lx + a[4] * ly) - (b[3] * lx + b[4] * ly));
    for (const [x, y, r, u, v] of clumps) {
      const f = u * lx + v * ly; // насколько комок повёрнут к свету
      P.ellipse(x + s * 0.02, y + s * 0.03, r * 1.05, r * 0.92, A(C.crown[0], 0.6));
      P.ellipse(x + lx * r * 0.14, y + ly * r * 0.14, r * 0.88, r * 0.78, C.crown[1]);
      if (f > -0.35) P.ellipse(x + lx * r * 0.32, y + ly * r * 0.32, r * 0.58, r * 0.5, A(C.crown[2], clamp(0.55 + f * 0.5, 0.3, 1)));
      if (f > 0.35) P.ellipse(x + lx * r * 0.48, y + ly * r * 0.48, r * 0.26, r * 0.22, A(C.crown[3], S.tod === 'night' ? 0.4 : 0.75));
    }
    // фактура листвы: сотни мелких листочков разного тона
    const R4 = rng(S.seedStable ^ 0x5eed);
    for (let i = 0; i < 320; i++) {
      const ang = R4() * Math.PI * 2; const rr = Math.sqrt(R4()) * 0.95;
      const u = Math.cos(ang) * rr; const v = Math.sin(ang) * rr;
      const f = u * lx + v * ly;
      const c = f > 0.25 ? C.crown[2] : f > -0.3 ? C.crown[1] : C.crown[0];
      P.ellipse(cx + u * rx, cy + v * ry, 0.8 + R4() * 1.1, 0.6 + R4() * 0.8, A(c, 0.55));
    }
    // мелкие листья по контуру — рваный живой край
    const R2 = rng(S.seedStable ^ 77);
    for (let i = 0; i < 90; i++) {
      const ang = R2() * Math.PI * 2; const rr = 0.85 + R2() * 0.25;
      const x = cx + Math.cos(ang) * rx * rr + Math.sin(T * 1.3 + i) * 0.5 * S.wind.power;
      const y = cy + Math.sin(ang) * ry * rr * 0.95;
      const lit = Math.cos(ang) * lx + Math.sin(ang) * ly > 0.2;
      P.ellipse(x, y, 1 + R2() * 1.2, 0.9 + R2() * 0.9, A(C.crown[lit ? 2 : 1], 0.9));
    }
    if (C.blossom) {
      for (const [x, y, r] of clumps) if (R2() < 0.7) P.ellipse(x + (R2() - 0.5) * r, y + (R2() - 0.5) * r, 1.1, 1, A(R2.pick(C.blossom), 0.9));
    }
  }

  // Старый седан (смотрит влево): кузов, стёкла, хром, колёса, задний фонарь.
  function car(P, S, C, x, gy, len) {
    const L2 = len;
    P.ellipse(x + L2 * 0.5, gy + 1, L2 * 0.56, L2 * 0.05, A(BLACK, 0.4));
    P.path([['M', x + L2 * 0.02, gy - L2 * 0.07], ['Q', x - L2 * 0.01, gy - L2 * 0.15, x + L2 * 0.05, gy - L2 * 0.2],
      ['L', x + L2 * 0.28, gy - L2 * 0.215], ['L', x + L2 * 0.37, gy - L2 * 0.33], ['L', x + L2 * 0.66, gy - L2 * 0.335],
      ['Q', x + L2 * 0.71, gy - L2 * 0.33, x + L2 * 0.77, gy - L2 * 0.22], ['L', x + L2 * 0.97, gy - L2 * 0.2],
      ['Q', x + L2 * 1.01, gy - L2 * 0.15, x + L2 * 0.99, gy - L2 * 0.07], ['Z']], C.car);
    P.poly([x + L2 * 0.385, gy - L2 * 0.22, x + L2 * 0.415, gy - L2 * 0.31, x + L2 * 0.52, gy - L2 * 0.313, x + L2 * 0.52, gy - L2 * 0.22], A(C.glass, 0.85));
    P.poly([x + L2 * 0.545, gy - L2 * 0.22, x + L2 * 0.545, gy - L2 * 0.313, x + L2 * 0.65, gy - L2 * 0.31, x + L2 * 0.73, gy - L2 * 0.22], A(C.glass, 0.85));
    P.strokes([x + L2 * 0.42, gy - L2 * 0.3, x + L2 * 0.5, gy - L2 * 0.305], A(C.light, 0.3), 0.7);
    P.strokes([x + L2 * 0.04, gy - L2 * 0.145, x + L2 * 0.97, gy - L2 * 0.145, x + L2 * 0.0, gy - L2 * 0.07, x + L2 * 0.12, gy - L2 * 0.07, x + L2 * 0.9, gy - L2 * 0.07, x + L2 * 1.0, gy - L2 * 0.07], A(C.chrome, 0.45), 0.9);
    P.strokes([x + L2 * 0.38, gy - L2 * 0.333, x + L2 * 0.65, gy - L2 * 0.338], A(C.light, 0.25), 0.8);
    for (const wx of [0.2, 0.8]) {
      P.ellipse(x + L2 * wx, gy - L2 * 0.065, L2 * 0.078, L2 * 0.078, C.carDark);
      P.ellipse(x + L2 * wx, gy - L2 * 0.065, L2 * 0.035, L2 * 0.035, A(C.chrome, 0.45));
    }
    const red = [255, 70, 55, 1];
    P.rect(x + L2 * 0.975, gy - L2 * 0.175, L2 * 0.02, L2 * 0.04, red);
    if (S.tod !== 'day') P.glow(x + L2 * 0.99, gy - L2 * 0.155, L2 * 0.16, A(red, 0.45));
  }

  function fieldLand(P, S, C, L) {
    const W = P.W; const H = P.H; const hz = L.horizon;
    const k = Math.min(W, H) / 160;
    const R = rng(S.seedStable ^ 0x1234);
    hills(P, C, hz, [[0.02, 0.09, 0.36], [0.9, 0.065, 0.32], [0.5, 0.022, 0.22]]);
    P.vgrad(0, Math.floor(hz), W, H - Math.floor(hz), [[0, C.far], [1, C.near]]);
    // светлые «волны» ветра по траве
    for (let i = 0; i < 9; i++) P.ellipse(R() * W, hz + (0.15 + R() * 0.8) * (H - hz), W * (0.12 + R() * 0.22), (H - hz) * (0.03 + R() * 0.06), A(C.grass[C.grass.length - 1], 0.12));
    // фактура травы: тысячи коротких штрихов, по цвету — пачками (один вызов на цвет)
    const bins = C.grass.map(() => []);
    const N = Math.round((W * (H - hz)) / 9);
    const lean = S.wind.dir * S.wind.power * 0.22;
    for (let i = 0; i < N; i++) {
      const d = Math.pow(R(), 0.75);
      const y = hz + 1 + d * (H - hz);
      const len = lerp(1.2, 7, d) * k;
      const x = R() * W;
      const ci = Math.min(C.grass.length - 1, Math.floor(R() * C.grass.length * (0.5 + d * 0.6)));
      bins[ci].push(x, y, x + lean * len + (R() - 0.5) * len * 0.5, y - len);
    }
    bins.forEach((segs, i) => P.strokes(segs, A(C.grass[i], 0.85), 0.9));
    // цветы на переднем плане
    const nf = Math.round((W * (H - hz)) / 380 * C.se.flowerRate);
    for (let i = 0; i < nf; i++) {
      const d = 0.35 + R() * 0.65;
      const r = (0.6 + R() * 0.9) * k * d;
      P.ellipse(R() * W, hz + d * (H - hz), r, r, A(R.pick(C.flowers), 0.85));
    }
    if (S.season === 'winter') { // сугробы и следы на снегу
      for (let i = 0; i < 9; i++) P.ellipse(R() * W, hz + R() * (H - hz), W * (0.05 + R() * 0.1), 2 * k, A(WHITE, S.tod === 'night' ? 0.08 : 0.35));
    }
    const { tx, gy, s } = treeBase(S, L);
    P.ellipse(tx + s * 0.35, gy + 2, s * 0.9, s * 0.12, A(BLACK, 0.32));
    trunk(P, C, tx, gy, s, !C.crown);
    if (L.car) car(P, S, C, tx + s * 0.28, gy + s * 0.06, s * 1.25);
  }

  // Живой передний план: крона, светлячки, листья/снег/дождь, травинки у самого края.
  function fieldLife(P, S, C, L, t) {
    const W = P.W; const H = P.H; const hz = L.horizon;
    const T = S.epoch + t;
    const k = Math.min(W, H) / 160;
    crown(P, S, C, L, t);
    const R = rng(S.seedTime ^ 0xabc);
    const { tx, gy, s } = treeBase(S, L);
    if (S.tod !== 'day' && S.season !== 'winter') { // светлячки
      const n = S.tod === 'night' ? 16 : 8;
      for (let i = 0; i < n; i++) {
        const x0 = tx + (R() - 0.5) * W * 0.8; const y0 = lerp(gy - s * 1.6, H * 0.97, R());
        const ph = R() * 6.28;
        const x = x0 + Math.sin(T * (0.3 + R() * 0.4) + ph) * 14 * k;
        const y = y0 + Math.cos(T * (0.25 + R() * 0.3) + ph) * 6 * k;
        const a = 0.35 + 0.65 * Math.max(0, Math.sin(T * (1 + R()) + ph));
        P.glow(x, y, 5 * k, [255, 226, 120, 0.35 * a]);
        P.ellipse(x, y, 0.9 * k, 0.9 * k, [255, 244, 190, a]);
      }
    }
    if (C.leaves && (S.season !== 'summer' || S.wind.power >= 2)) { // летящие листья / лепестки
      const n = S.season === 'autumn' ? 16 : S.season === 'spring' ? 12 : 5;
      for (let i = 0; i < n; i++) {
        const sp = 10 + R() * 18;
        const x = mod(tx + R() * W + T * sp * S.wind.dir, W + 40) - 20;
        const y = mod(gy - s * 1.6 + R() * H * 0.6 + T * (6 + R() * 6), H + 20) - 10;
        const ang = T * (1 + R() * 2) + R() * 6;
        const lw = (1.6 + R() * 1.4) * k; const lh = lw * 0.45;
        const ca = Math.cos(ang); const sa = Math.sin(ang);
        P.poly([x + ca * lw, y + sa * lw, x - sa * lh, y + ca * lh, x - ca * lw, y - sa * lw, x + sa * lh, y - ca * lh], A(R.pick(C.leaves), 0.9));
      }
    }
    if (S.season === 'winter') { // снегопад
      const n = S.trend === 'down' ? 220 : 110;
      for (let i = 0; i < n; i++) {
        const r = (0.5 + R() * 1.2) * k;
        const x = mod(R() * W + Math.sin(T * 0.6 + i) * 6 + T * 8 * S.wind.dir * (0.5 + r / k), W);
        const y = mod(R() * H + T * (10 + r * 9), H);
        P.ellipse(x, y, r, r, A(C.snow, 0.5 + R() * 0.4));
      }
    } else if (S.trend === 'down') { // дождь
      const segs = [];
      const n = Math.round(W * H / 380);
      const vx = S.wind.dir * (30 + S.wind.power * 25); const vy = 420;
      for (let i = 0; i < n; i++) {
        const x = mod(R() * W + T * vx, W); const y = mod(R() * H + T * vy, H);
        const l = (6 + R() * 8) * k;
        segs.push(x, y, x + vx / vy * l, y + l);
      }
      P.strokes(segs, [190, 210, 230, 0.28], 0.7);
    }
    // травинки переднего плана — изгибаются и качаются на ветру
    const bins = C.grass.map(() => []);
    const R3 = rng(S.seedStable ^ 0x77);
    const n = Math.round(W / 1.6);
    for (let i = 0; i < n; i++) {
      const x = R3() * W; const y = H * (0.86 + R3() * 0.16);
      const len = (7 + R3() * 13) * k;
      const sw = Math.sin(T * 1.6 + x * 0.045) * len * 0.2 * (0.4 + S.wind.power * 0.35) + S.wind.dir * S.wind.power * len * 0.12;
      const ci = Math.floor(R3() * C.grass.length);
      bins[ci].push(['M', x, y], ['Q', x + sw * 0.3, y - len * 0.6, x + sw, y - len]);
    }
    bins.forEach((cmds, i) => { if (cmds.length) P.path(cmds, A(mix(C.grass[i], BLACK, 0.15), 0.95), 1.1); });
  }

  // =====================================================================
  //  Панель с курсами для поля
  // =====================================================================
  function fieldTheme(S) {
    return { text: [247, 241, 226, 1], sub: [247, 241, 226, 0.7], up: [142, 240, 168, 1], down: [255, 138, 128, 1], eq: [205, 214, 224, 1], line: [242, 213, 138, 1], grid: [255, 255, 255, 0.12] };
  }

  function lineChart(P, x, y, w, h, series, label, th) {
    P.text(label, x, y, w * 0.5, 9, th.sub, { font: 'round' });
    if (series.length < 2) { P.text('История курса копится…', x, y + h / 2 - 6, w, 9, th.sub, { font: 'round' }); return; }
    const vals = series.map((p) => p.v);
    const mn = Math.min(...vals); const mx = Math.max(...vals);
    P.text(`${fmtNum(mn)}–${fmtNum(mx)}`, x, y, w, 9, th.sub, { align: 'right', bold: false });
    const y0 = y + 15; const h0 = h - 17; const n = series.length;
    const pts = series.map((p, i) => [x + (i * w) / (n - 1), y0 + h0 - ((p.v - mn) / ((mx - mn) || 1)) * h0 * 0.8 - h0 * 0.1]);
    P.rect(x, y0 + h0, w, 1, th.grid);
    P.poly([x, y0 + h0].concat(...pts).concat([x + w, y0 + h0]), A(th.line, 0.14));
    const cmds = [['M', pts[0][0], pts[0][1]]];
    for (let i = 1; i < n; i++) {
      const mxp = (pts[i - 1][0] + pts[i][0]) / 2; const myp = (pts[i - 1][1] + pts[i][1]) / 2;
      cmds.push(['Q', pts[i - 1][0], pts[i - 1][1], mxp, myp]);
    }
    cmds.push(['L', pts[n - 1][0], pts[n - 1][1]]);
    P.path(cmds, A(th.line, 0.25), 4);
    P.path(cmds, th.line, 1.7);
    const last = pts[n - 1];
    P.glow(last[0], last[1], 9, A(th.line, 0.6));
    P.ellipse(last[0], last[1], 2.2, 2.2, WHITE);
  }

  function ratesContent(P, S, box, th) {
    const m = S.model; const fam = S.family;
    const head = `${m.amount} ${m.base} =`;
    if (fam === 'small') {
      const r = m.rows[0];
      const hs = fit(head, box.w, 12, 8, 'round');
      const vs = fit(r.value, box.w, 28, 10);
      const cs = Math.min(14, vs);
      const gap = Math.max(0, (box.h - hs * 1.3 - vs * 1.2 - cs * 1.3) / 2);
      let y = box.y;
      P.text(head, box.x, y, box.w, hs, th.sub, { font: 'round' });
      y += hs * 1.3 + gap;
      P.text(r.value, box.x, y, box.w, vs, th.text);
      y += vs * 1.2 + gap;
      P.text(r.code, box.x, y, box.w, cs, th.text, { font: 'round' });
      arrow(P, r.trend, box.x + r.code.length * cs * 0.68 + 6, y + cs * 0.22, cs * 0.7, th);
      P.text(m.shortDate, box.x, y + cs * 0.25, box.w, 8, th.sub, { align: 'right', bold: false });
      return;
    }
    const big = fam !== 'medium';
    const rows = m.rows;
    const hs = fit(head, box.w, big ? 15 : 12, 8, 'round');
    const maxChars = Math.max(...rows.map((r) => r.code.length * 0.8 + 1 + r.value.length));
    const rsMax = fam === 'extraLarge' ? 30 : big ? 25 : 20;
    const as0 = rsMax * 0.6;
    const rs = Math.min(rsMax, Math.floor((box.w - as0 - 8) / (maxChars * 0.62)));
    const as = rs * 0.6;
    const fs = 9;
    const chartH = big ? Math.min(box.h * 0.34, 110) : 0;
    const used = hs * 1.3 + rows.length * rs * 1.3 + chartH + fs * 1.4;
    const gap = Math.max(0, (box.h - used) / (rows.length + (chartH ? 2 : 1)));
    let y = box.y;
    P.text(head, box.x, y, box.w, hs, th.sub, { font: 'round' });
    y += hs * 1.3 + gap * 0.6;
    for (const r of rows) {
      P.text(r.code, box.x, y, box.w, rs * 0.82, th.text, { font: 'round' });
      P.text(r.value, box.x, y, box.w - as - 8, rs, th.text, { align: 'right' });
      arrow(P, r.trend, box.x + box.w - as, y + rs * 0.3, as, th);
      y += rs * 1.3 + gap;
    }
    if (chartH) lineChart(P, box.x, y, box.w, chartH, S.series, `${m.chartLabel}, 14 дн.`, th);
    P.text(m.dateLabel, box.x, box.y + box.h - fs * 1.3, box.w, fs, th.sub, { font: 'round', bold: false });
  }

  function fieldUI(P, S, C, L) {
    if (S.dark && S.tod === 'day') P.rect(0, 0, P.W, P.H, [0, 0, 0, 0.18]);
    const r = L.panel;
    P.rrect(r.x, r.y, r.w, r.h, 14, [5, 11, 20, S.tod === 'day' ? 0.4 : 0.5]);
    P.rrect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 14, [255, 255, 255, 0.14], 1);
    P.rect(r.x + 14, r.y + 1, r.w - 28, 1, [255, 255, 255, 0.08]);
    const pad = S.family === 'small' ? 10 : 12;
    ratesContent(P, S, { x: r.x + pad, y: r.y + pad - 2, w: r.w - pad * 2, h: r.h - pad * 2 + 2 }, fieldTheme(S));
  }

  function fieldLayers(S) {
    const C = fieldPalette(S); const L = fieldLayout(S);
    return [
      { static: true, draw: (P) => fieldBack(P, S, C, L) },
      { static: false, draw: (P, t) => fieldClouds(P, S, C, L, t) },
      { static: true, draw: (P) => fieldLand(P, S, C, L) },
      { static: false, draw: (P, t) => fieldLife(P, S, C, L, t) },
      { static: true, draw: (P) => fieldUI(P, S, C, L) },
    ];
  }

  // =====================================================================
  //  СЦЕНА 2. Медицина: прикроватный монитор. Курсы — как показатели,
  //  ЭКГ и плетизмограмма бегут развёрткой, график — тренд за 14 дней.
  // =====================================================================
  const MED = {
    bg: hex('#020608'), screen: hex('#04100f'), grid: hex('#0b2a22'), grid2: hex('#124034'), frame: hex('#163a33'),
    ecg: hex('#3dff8f'), pleth: hex('#3fd9ff'), amber: hex('#ffd34a'), red: hex('#ff4d5e'), white: hex('#e9f5f1'), dim: hex('#6f938c'),
  };
  const VITAL = [MED.ecg, MED.pleth, MED.amber];

  // ЭКГ: сумма гауссиан — зубцы P, Q, R, S, T.
  function ecgWave(p) {
    p = mod(p, 1);
    const g = (c, w) => Math.exp(-((p - c) * (p - c)) / (2 * w * w));
    return 0.11 * g(0.16, 0.022) - 0.1 * g(0.36, 0.009) + 1.0 * g(0.39, 0.011) - 0.26 * g(0.42, 0.011) + 0.3 * g(0.66, 0.045);
  }
  function plethWave(p) {
    p = mod(p, 1);
    const g = (c, w) => Math.exp(-((p - c) * (p - c)) / (2 * w * w));
    return 0.9 * g(0.24, 0.08) + 0.36 * g(0.5, 0.07) + 0.05;
  }
  function bpmOf(S) {
    const base = { up: 72, eq: 64, down: 96 }[S.trend] || 68;
    return base + rng(S.seedTime)() * 6;
  }

  function medLayout(S) {
    const W = S.W; const H = S.H; const f = S.family;
    const bar = { x: 0, y: 0, w: W, h: f === 'small' ? 22 : 24 };
    const top = bar.h + 2;
    if (f === 'small') {
      const eh = H * 0.32;
      return { bar, ecg: { x: 6, y: top, w: W - 12, h: eh }, vitals: [{ x: 6, y: top + eh + 5, w: W - 12, h: H - top - eh - 11 }] };
    }
    if (f === 'medium') {
      const lw = W * 0.46; const ah = H - top - 8;
      return { bar, ecg: { x: 6, y: top, w: lw, h: ah * 0.6 }, pleth: { x: 6, y: top + ah * 0.6 + 4, w: lw, h: ah * 0.4 - 4 },
        vitals: [0, 1].map((i) => ({ x: lw + 14, y: top + i * (ah / 2 + 2), w: W - lw - 20, h: ah / 2 - 2 })) };
    }
    if (f === 'extraLarge') {
      const lw = W * 0.5; const ah = H - top - 8;
      return { bar, ecg: { x: 8, y: top, w: lw, h: ah * 0.36 }, pleth: { x: 8, y: top + ah * 0.36 + 5, w: lw, h: ah * 0.24 }, trend: { x: 8, y: top + ah * 0.6 + 10, w: lw, h: ah * 0.4 - 10 },
        vitals: [0, 1, 2].map((i) => ({ x: lw + 18, y: top + i * (ah / 3 + 1), w: W - lw - 26, h: ah / 3 - 3 })) };
    }
    // large и live
    const live = f === 'live';
    const t0 = live ? Math.max(50, H * 0.06) : 0;
    const bar2 = live ? { x: 0, y: t0 - 26, w: W, h: 24 } : bar;
    const y0 = live ? t0 + 4 : top;
    const ah = H - y0 - (live ? 30 : 8);
    const eh = ah * (live ? 0.2 : 0.24); const ph = live ? ah * 0.12 : 0; const vh = ah * (live ? 0.42 : 0.47);
    const L = { bar: bar2, ecg: { x: 8, y: y0, w: W - 16, h: eh } };
    let y = y0 + eh + 5;
    if (live) { L.pleth = { x: 8, y, w: W - 16, h: ph }; y += ph + 5; }
    L.vitals = [0, 1, 2].map((i) => ({ x: 8, y: y + i * (vh / 3), w: W - 16, h: vh / 3 - 4 }));
    y += vh + 2;
    L.trend = { x: 8, y, w: W - 16, h: y0 + ah - y };
    return L;
  }

  function scanlines(P) {
    for (let y = 0; y < P.H; y += 3) P.rect(0, y, P.W, 1, [255, 255, 255, 0.018]);
  }
  function gridBox(P, r) {
    P.rrect(r.x, r.y, r.w, r.h, 6, MED.screen);
    const minor = []; const major = [];
    for (let x = r.x + 6, i = 1; x < r.x + r.w; x += 6, i++) (i % 5 ? minor : major).push(x, r.y + 1, x, r.y + r.h - 1);
    for (let y = r.y + 6, i = 1; y < r.y + r.h; y += 6, i++) (i % 5 ? minor : major).push(r.x + 1, y, r.x + r.w - 1, y);
    P.strokes(minor, A(MED.grid, 0.55), 0.5);
    P.strokes(major, A(MED.grid2, 0.9), 0.7);
    P.rrect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 6, MED.frame, 1);
  }
  function redCross(P, x, y, s, c) {
    P.rrect(x + s * 0.35, y, s * 0.3, s, s * 0.06, c);
    P.rrect(x, y + s * 0.35, s, s * 0.3, s * 0.06, c);
  }
  function heart(P, x, y, s, c) {
    P.ellipse(x - s * 0.24, y, s * 0.28, s * 0.27, c);
    P.ellipse(x + s * 0.24, y, s * 0.28, s * 0.27, c);
    P.poly([x - s * 0.5, y + s * 0.08, x + s * 0.5, y + s * 0.08, x, y + s * 0.62], c);
  }

  function medStatic(P, S, L) {
    const m = S.model;
    P.rect(0, 0, P.W, P.H, MED.bg);
    P.glow(P.W * 0.5, P.H * 0.45, Math.max(P.W, P.H) * 0.7, A(MED.grid2, 0.25));
    // верхняя строка монитора
    const b = L.bar;
    P.rect(b.x, b.y, b.w, b.h, [10, 26, 26, 1]);
    P.rect(b.x, b.y + b.h - 1, b.w, 1, A(MED.ecg, 0.25));
    const cs = b.h * 0.5;
    redCross(P, b.x + 8, b.y + (b.h - cs) / 2, cs, MED.red);
    const small = S.family === 'small';
    P.text(`${m.amount} ${m.base}`, b.x + 14 + cs, b.y + b.h / 2 - 6.5, b.w * 0.5, small ? 10 : 11, MED.white, { font: 'round' });
    const right = m.offline ? `ОФЛАЙН · ${m.rateDDMM}` : small ? `НБРБ ${m.rateDDMM}` : `НБРБ · ${m.rateDate} · ${S.clock}`;
    P.text(right, b.x + b.w * 0.35, b.y + b.h / 2 - 5.5, b.w * 0.65 - 8, small ? 8.5 : 9, m.offline ? MED.amber : MED.dim, { align: 'right', bold: false });
    // полосы с сеткой
    for (const key of ['ecg', 'pleth', 'trend']) if (L[key]) gridBox(P, L[key]);
    const tag = (r, label, c) => P.text(label, r.x + 6, r.y + 4, r.w * 0.7, 8.5, c, { font: 'round' });
    tag(L.ecg, small || S.trend === 'down' && L.ecg.w < 200 ? 'ЭКГ' : `ЭКГ · ${m.chartLabel}`, MED.ecg);
    if (L.pleth) tag(L.pleth, 'ПУЛЬС КУРСА', MED.pleth);
    // показатели
    L.vitals.forEach((r, i) => {
      const row = m.rows[i];
      if (!row) return;
      const c = VITAL[i % 3];
      P.rrect(r.x, r.y, r.w, r.h, 7, A(c, 0.05));
      P.rrect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 7, A(c, 0.3), 1);
      const ls = Math.min(13, Math.max(9, r.h * 0.2));
      P.text(row.code, r.x + 8, r.y + 5, r.w * 0.4, ls, c, { font: 'round' });
      const th = { up: MED.ecg, down: MED.red, eq: MED.dim };
      const as = ls * 0.85;
      arrow(P, row.trend, r.x + 14 + row.code.length * ls * 0.68, r.y + 5 + ls * 0.12, as, th);
      const tall = r.h > 44;
      const vMax = Math.min(tall ? r.h * (S.family === 'medium' ? 0.44 : 0.55) : r.h * 0.5, S.family === 'small' ? 30 : 34);
      const vs = fit(row.value, tall && r.w < 220 ? r.w - 16 : r.w * 0.66, vMax, 10);
      const vy = tall && r.w < 220 ? r.y + r.h - vs * 1.15 - (r.h > 58 ? 15 : 3) : r.y + (r.h - vs * 1.2) / 2 + 2;
      P.text(row.value, r.x + 8, vy, r.w - 16, vs, c, { align: 'right' });
      if (r.h > 34) P.text(`1 ${m.base} = ${row.rate}`, r.x + 8, r.y + r.h - 13, r.w * 0.6, 8, MED.dim, { bold: false });
    });
    // тренд за 14 дней
    if (L.trend) {
      const r = L.trend;
      P.text(`ТРЕНД 14 ДН. · ${m.chartLabel}`, r.x + 6, r.y + 4, r.w * 0.7, 8.5, MED.amber, { font: 'round' });
      const s = S.series;
      if (s.length >= 2) {
        const vals = s.map((p) => p.v); const mn = Math.min(...vals); const mx = Math.max(...vals);
        P.text(`${fmtNum(mn)}–${fmtNum(mx)}`, r.x, r.y + 4, r.w - 6, 8.5, MED.dim, { align: 'right', bold: false });
        const y0 = r.y + 18; const h0 = r.h - 24; const x0 = r.x + 10; const w0 = r.w - 20;
        const pts = s.map((p, i) => [x0 + (i * w0) / (s.length - 1), y0 + h0 - ((p.v - mn) / ((mx - mn) || 1)) * h0]);
        const cmds = pts.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]);
        P.path(cmds, A(MED.amber, 0.22), 4);
        P.path(cmds, MED.amber, 1.4);
        pts.forEach((p, i) => P.ellipse(p[0], p[1], i === pts.length - 1 ? 2.6 : 1.5, i === pts.length - 1 ? 2.6 : 1.5, i === pts.length - 1 ? WHITE : MED.amber));
      } else {
        P.text('История курса копится…', r.x + 6, r.y + r.h / 2 - 5, r.w, 9, MED.dim, { bold: false });
      }
    }
    scanlines(P);
  }

  // Развёртка: кривая стоит на месте, «перо» бежит слева направо и стирает старое перед собой.
  function sweep(P, r, T, bps, fn, color, secs) {
    const base = r.y + r.h * 0.7; const amp = r.h * 0.5;
    const v = r.w / secs; const sx = r.x + mod(T * v, r.w); const gap = Math.max(8, r.w * 0.05);
    const a = []; const b = [];
    for (let x = r.x + 2; x <= r.x + r.w - 2; x += 1.2) {
      const back = mod(sx - x, r.w) / v;
      if (back > (r.w - gap) / v) continue;
      (x <= sx ? a : b).push([x, base - fn((T - back) * bps) * amp]);
    }
    for (const seg of [a, b]) {
      if (seg.length < 2) continue;
      const cmds = seg.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]);
      P.path(cmds, A(color, 0.2), 4);
      P.path(cmds, color, 1.4);
    }
    const hy = base - fn(T * bps) * amp;
    P.glow(sx, hy, 10, A(color, 0.7));
    P.ellipse(sx, hy, 1.8, 1.8, WHITE);
  }

  function medLive(P, S, L, t) {
    const T = S.epoch + t;
    const bpm = bpmOf(S); const bps = bpm / 60;
    sweep(P, L.ecg, T, bps, ecgWave, MED.ecg, 4);
    if (L.pleth) sweep(P, L.pleth, T + 0.18, bps, plethWave, MED.pleth, 4);
    // сердце бьётся в такт ЭКГ, рядом — «пульс»
    const r = L.ecg;
    const beat = Math.exp(-Math.pow(mod(T * bps, 1) - 0.39, 2) / 0.003);
    const hs = 9 + beat * 2.5;
    const hx = r.x + r.w - 52; const hy = r.y + 9;
    P.glow(hx, hy + 2, 12, A(MED.red, 0.25 + beat * 0.4));
    heart(P, hx, hy, hs, MED.red);
    P.text(String(Math.round(bpm)), hx + 10, hy - 6, 40, 13, MED.ecg, {});
    // тревога, если курс упал
    if (S.trend === 'down') { // мигающая плашка тревоги в полосе ЭКГ, слева от сердца
      const a = 0.45 + 0.55 * Math.max(0, Math.sin(T * 4));
      const w = S.family === 'small' ? 46 : 52; const h = 15;
      const x = hx - 18 - w; const y = r.y + 3;
      P.rrect(x, y, w, h, 4, A(MED.red, 0.22 * a));
      P.rrect(x + 0.5, y + 0.5, w - 1, h - 1, 4, A(MED.red, 0.6 * a), 1);
      arrow(P, 'down', x + 5, y + 3.5, 8, { down: A(MED.red, a) });
      P.text('КУРС', x + 15, y + 2.5, w - 18, 9, A(MED.red, a), { align: 'center', font: 'round' });
    }
  }

  function medLayers(S) {
    const L = medLayout(S);
    return [
      { static: true, draw: (P) => medStatic(P, S, L) },
      { static: false, draw: (P, t) => medLive(P, S, L, t) },
    ];
  }

  function layers(S) { return S.scene === 'med' ? medLayers(S) : fieldLayers(S); }

  // =====================================================================
  //  Живая анимация в WebView (только браузер)
  // =====================================================================
  function canvasPainter(g, W, H) {
    const css = (c) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${clamp(alphaOf(c), 0, 1)})`;
    const trace = (cmds) => {
      g.beginPath();
      for (const c of cmds) {
        if (c[0] === 'M') g.moveTo(c[1], c[2]);
        else if (c[0] === 'L') g.lineTo(c[1], c[2]);
        else if (c[0] === 'Q') g.quadraticCurveTo(c[1], c[2], c[3], c[4]);
        else if (c[0] === 'C') g.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
        else if (c[0] === 'Z') g.closePath();
      }
    };
    const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
    const ROUND = 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif';
    const P = {
      W, H,
      rect: (x, y, w, h, c) => { g.fillStyle = css(c); g.fillRect(x, y, w, h); },
      ellipse: (cx, cy, rx, ry, c) => { if (rx <= 0 || ry <= 0) return; g.fillStyle = css(c); g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.fill(); },
      poly: (pts, c) => { const cmds = []; for (let i = 0; i < pts.length; i += 2) cmds.push([i ? 'L' : 'M', pts[i], pts[i + 1]]); cmds.push(['Z']); P.path(cmds, c); },
      path: (cmds, c, w) => { trace(cmds); if (w) { g.strokeStyle = css(c); g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(); } else { g.fillStyle = css(c); g.fill(); } },
      strokes: (segs, c, w) => { if (!segs.length) return; g.beginPath(); for (let i = 0; i < segs.length; i += 4) { g.moveTo(segs[i], segs[i + 1]); g.lineTo(segs[i + 2], segs[i + 3]); } g.strokeStyle = css(c); g.lineWidth = w; g.lineCap = 'butt'; g.stroke(); },
      vgrad: (x, y, w, h, stops) => { const gr = g.createLinearGradient(0, y, 0, y + h); stops.forEach(([t, c]) => gr.addColorStop(clamp(t, 0, 1), css(c))); g.fillStyle = gr; g.fillRect(x, y, w, h); },
      glow: (cx, cy, r, c) => { const a = alphaOf(c); const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r); gr.addColorStop(0, css(A(c, a * 0.8))); gr.addColorStop(0.35, css(A(c, a * 0.3))); gr.addColorStop(1, css(A(c, 0))); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); },
      rrect: (x, y, w, h, r, c, sw) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); if (sw) { g.strokeStyle = css(c); g.lineWidth = sw; g.stroke(); } else { g.fillStyle = css(c); g.fill(); } },
      text: (s, x, y, w, size, c, o) => {
        o = o || {};
        g.font = `${o.bold === false ? 500 : 700} ${size}px ${o.font === 'round' ? ROUND : MONO}`;
        g.fillStyle = css(c); g.textBaseline = 'top';
        g.textAlign = o.align || 'left';
        g.fillText(s, o.align === 'right' ? x + w : o.align === 'center' ? x + w / 2 : x, y + size * 0.12);
      },
    };
    return P;
  }

  function runLive(canvas, S0) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    let S; let L; let cache;
    const setup = () => {
      const W = window.innerWidth; const H = window.innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      S = Object.assign({}, S0, { W, H, family: W > H * 1.25 ? 'extraLarge' : 'live' });
      L = layers(S);
      // статичные слои рисуем один раз в отдельные холсты — в кадре остаётся только движение
      cache = L.map((l) => {
        if (!l.static) return null;
        const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
        const g = c.getContext('2d'); g.scale(dpr, dpr);
        l.draw(canvasPainter(g, W, H), 0);
        return c;
      });
    };
    const t0 = performance.now();
    const frame = (now) => {
      const t = (now - t0) / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      L.forEach((l, i) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (cache[i]) ctx.drawImage(cache[i], 0, 0);
        else { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); l.draw(canvasPainter(ctx, S.W, S.H), t); }
      });
      requestAnimationFrame(frame);
    };
    setup();
    window.addEventListener('resize', setup);
    requestAnimationFrame(frame);
  }

  return { layers, runLive, canvasPainter, sampleStops, hashStr, rng, mix, hex };
}

const KIT = SceneKit();

// =====================================================================
//  Художник на DrawContext (кадр для виджета)
// =====================================================================
function dcPainter(W, H) {
  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = true;
  ctx.respectScreenScale = true; // рисуем в точках, iOS сама умножит на @2x/@3x
  const cache = {};
  const to255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const col = (c) => {
    const a = c.length > 3 ? Math.max(0, Math.min(1, c[3])) : 1;
    const key = `${to255(c[0])},${to255(c[1])},${to255(c[2])},${Math.round(a * 1000)}`;
    if (!cache[key]) cache[key] = new Color('#' + [c[0], c[1], c[2]].map((v) => to255(v).toString(16).padStart(2, '0')).join(''), a);
    return cache[key];
  };
  const pt = (x, y) => new Point(x, y);
  const build = (cmds) => {
    const p = new Path();
    for (const c of cmds) {
      if (c[0] === 'M') p.move(pt(c[1], c[2]));
      else if (c[0] === 'L') p.addLine(pt(c[1], c[2]));
      else if (c[0] === 'Q') p.addQuadCurve(pt(c[3], c[4]), pt(c[1], c[2]));
      else if (c[0] === 'C') p.addCurve(pt(c[5], c[6]), pt(c[1], c[2]), pt(c[3], c[4]));
      else if (c[0] === 'Z') p.closeSubpath();
    }
    return p;
  };
  const fillOrStroke = (c, w) => {
    if (w) { ctx.setStrokeColor(col(c)); ctx.setLineWidth(w); ctx.strokePath(); } else { ctx.setFillColor(col(c)); ctx.fillPath(); }
  };
  const P = {
    W, H,
    rect(x, y, w, h, c) { ctx.setFillColor(col(c)); ctx.fillRect(new Rect(x, y, w, h)); },
    ellipse(cx, cy, rx, ry, c) { if (rx <= 0 || ry <= 0) return; ctx.setFillColor(col(c)); ctx.fillEllipse(new Rect(cx - rx, cy - ry, rx * 2, ry * 2)); },
    poly(pts, c) { const cmds = []; for (let i = 0; i < pts.length; i += 2) cmds.push([i ? 'L' : 'M', pts[i], pts[i + 1]]); cmds.push(['Z']); P.path(cmds, c); },
    path(cmds, c, w) { if (!cmds.length) return; ctx.addPath(build(cmds)); fillOrStroke(c, w); },
    strokes(segs, c, w) {
      if (!segs.length) return;
      const p = new Path();
      for (let i = 0; i < segs.length; i += 4) { p.move(pt(segs[i], segs[i + 1])); p.addLine(pt(segs[i + 2], segs[i + 3])); }
      ctx.addPath(p); fillOrStroke(c, w);
    },
    // У DrawContext нет градиентов: заливаем полосами по 1 pt (на @3x это 3 px — без швов).
    vgrad(x, y, w, h, stops) {
      const y0 = Math.round(y); const hh = Math.round(h);
      for (let i = 0; i < hh; i++) { ctx.setFillColor(col(KIT.sampleStops(stops, i / Math.max(1, hh - 1)))); ctx.fillRect(new Rect(x, y0 + i, w, 1)); }
    },
    // Мягкое свечение: стопка полупрозрачных кругов.
    glow(cx, cy, r, c, steps) {
      const n = steps || 16; const a = c.length > 3 ? c[3] : 1;
      ctx.setFillColor(col([c[0], c[1], c[2], a * (1.6 / n)]));
      for (let i = 0; i < n; i++) { const rr = r * (1 - i / n); ctx.fillEllipse(new Rect(cx - rr, cy - rr, rr * 2, rr * 2)); }
    },
    rrect(x, y, w, h, r, c, sw) { const p = new Path(); p.addRoundedRect(new Rect(x, y, w, h), r, r); ctx.addPath(p); fillOrStroke(c, sw); },
    text(s, x, y, w, size, c, o) {
      o = o || {};
      const bold = o.bold !== false;
      ctx.setFont(o.font === 'round'
        ? (bold ? Font.boldRoundedSystemFont(size) : Font.mediumRoundedSystemFont(size))
        : (bold ? Font.boldMonospacedSystemFont(size) : Font.mediumMonospacedSystemFont(size)));
      ctx.setTextColor(col(c));
      if (o.align === 'right') ctx.setTextAlignedRight();
      else if (o.align === 'center') ctx.setTextAlignedCenter();
      else ctx.setTextAlignedLeft();
      ctx.drawTextInRect(String(s), new Rect(x, y, w, size * 1.4));
    },
    image() { return ctx.getImage(); },
  };
  return P;
}

// =====================================================================
//  Размер виджета в точках по модели iPhone (таблица Apple HIG).
//  Для неизвестных экранов — пропорционально ширине.
// =====================================================================
const WIDGET_SIZES = { // экран: [small, medium W, medium H, large H]
  '430x932': [170, 364, 170, 382], '428x926': [170, 364, 170, 382], '414x896': [169, 360, 169, 379],
  '414x736': [159, 348, 157, 357], '393x852': [158, 338, 158, 354], '390x844': [158, 338, 158, 354],
  '375x812': [155, 329, 155, 345], '360x780': [155, 329, 155, 345], '375x667': [148, 321, 148, 324], '320x568': [141, 292, 141, 311],
};
function widgetSize(family) {
  let w = 390; let h = 844;
  try { const s = Device.screenSize(); w = Math.min(s.width, s.height); h = Math.max(s.width, s.height); } catch (e) { /* по умолчанию */ }
  let t = WIDGET_SIZES[`${Math.round(w)}x${Math.round(h)}`];
  if (!t) { const k = Math.min(1.1, w / 390); t = [158 * k, 338 * k, 158 * k, 354 * k].map(Math.round); }
  if (family === 'small') return [t[0], t[0]];
  if (family === 'large') return [t[1], t[3]];
  if (family === 'extraLarge') return [Math.round(t[1] * 2.1), t[3]];
  return [t[1], t[2]];
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

function sceneState(family, W, H, cfg, data, targets, ov) {
  ov = ov || {};
  const model = buildModel(cfg, data, targets);
  const now = sceneNow();
  const season = ov.season || seasonOf(now);
  const tod = ov.tod || timeOfDay(now, season);
  // seed меняется раз в 15 минут: дата + час + четверть часа.
  const seedTime = KIT.hashStr(`${ymdLocal(now)}|${now.getHours()}|${Math.floor(now.getMinutes() / 15)}|${ov.salt || ''}`);
  const r = KIT.rng(seedTime);
  let dark = false;
  try { dark = Device.isUsingDarkAppearance(); } catch (e) { dark = false; }
  if (ov.dark !== undefined) dark = ov.dark;
  return {
    family, W, H, scene: cfg.scene, season, tod,
    trend: ov.trend !== undefined ? ov.trend : model.trend,
    wind: { power: [0, 1, 1, 2, 2, 2, 3, 3][r.int(0, 7)], dir: r.chance(0.75) ? 1 : -1 },
    dark,
    seedStable: KIT.hashStr(`tree|${cfg.base}|${targets[0]}`),
    seedDay: KIT.hashStr(ymdLocal(now)),
    seedTime,
    // «время сцены» в секундах: облака, светлячки и ЭКГ считаются от него,
    // поэтому каждое обновление виджета — следующий кадр того же мира.
    epoch: ov.epoch !== undefined ? ov.epoch : (now.getTime() / 1000) % 100000,
    clock: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    model: Object.assign({}, model, { chartLabel: `${cfg.base}→${targets[0]}`, rateDate: ddmmyyyy(data.rateDate), rateDDMM: ddmm(data.rateDate) }),
    series: buildSeries(cfg, targets[0], data),
  };
}

function targetsFor(family, cfg) {
  if (family === 'small') return cfg.targets.slice(0, 1);
  if (family === 'medium') return cfg.targets.slice(0, 2);
  return threeTargets(cfg);
}

function renderImageWidget(family, cfg, data, overrides) {
  const [W, H] = widgetSize(family);
  const S = sceneState(family, W, H, cfg, data, targetsFor(family, cfg), overrides);
  const P = dcPainter(W, H);
  for (const layer of KIT.layers(S)) layer.draw(P, 0);
  const w = new ListWidget();
  w.backgroundImage = P.image();
  w.backgroundColor = new Color('#03060c');
  w.setPadding(0, 0, 0, 0);
  return w;
}

// Полноэкранная анимация: тот же SceneKit, но в WebView на canvas, 60 кадров/с.
function buildLiveHTML(S) {
  const json = JSON.stringify(S).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;-webkit-user-select:none}canvas{display:block;width:100vw;height:100vh}</style>
</head><body><canvas id="c"></canvas><script>
${SceneKit.toString()}
SceneKit().runLive(document.getElementById('c'), ${json});
</script></body></html>`;
}

async function presentLive(cfg, overrides) {
  let data;
  try { data = await loadData(); } catch (e) { await info('Нет курсов', e.message || String(e)); return; }
  const S = sceneState('live', 390, 844, cfg, data, threeTargets(cfg), overrides);
  const wv = new WebView();
  await wv.loadHTML(buildLiveHTML(S));
  await wv.present(true);
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
  g.colors = [new Color('#04070f'), new Color('#122a3a')];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(12, 12, 12, 12);
  const title = w.addText('Курсы НБРБ');
  title.font = Font.boldRoundedSystemFont(13); title.textColor = new Color('#f2d58a');
  w.addSpacer(6);
  const body = w.addText(text);
  body.font = Font.systemFont(12); body.textColor = new Color('#f4f1e8'); body.minimumScaleFactor = 0.6;
  w.addSpacer();
  const hint = w.addText('Нажмите, чтобы открыть');
  hint.font = Font.systemFont(9); hint.textColor = new Color('#9fb0c0');
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
  const si = await choose('Шаг 4 из 4', 'Какой виджет нарисовать?', sceneKeys.map((k) => SCENES[k]));
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
      res.addAction('✨ Живая сцена');
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
      if (i === 3) { await presentLive(Object.assign({}, cfg, { base, targets })); continue; }
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
  const ri = await choose('Курс', null, ['▲ вырос — ясно', '▼ упал — дождь / тревога', '= не изменился — облачно']);
  if (ri < 0) return;
  const sceneKeys = Object.keys(SCENES);
  const ci = await choose('Сцена', null, sceneKeys.map((k) => SCENES[k]));
  if (ci < 0) return;
  const di = await choose('Тема', null, ['Как в системе', 'Светлая', 'Тёмная']);
  if (di < 0) return;
  const overrides = { season: seasons[si], tod: tods[ti], trend: trends[ri], salt: String(Date.now()) };
  if (di > 0) overrides.dark = di === 2;
  const c2 = Object.assign({}, cfg, { scene: sceneKeys[ci] });
  const how = await choose('Как показать?', null, ['Виджет', '✨ Живая анимация']);
  if (how === 0) await previewWidget(c2, overrides);
  if (how === 1) await presentLive(c2, overrides);
}

async function menu(settings) {
  for (;;) {
    const cfg = resolveConfig('', settings);
    const i = await choose(`Курсы НБРБ · v${VERSION}`, `${fmtAmount(cfg.amountMinor)} ${cfg.base} → ${cfg.targets.join(', ')}`,
      ['Конвертер', '✨ Живая сцена', 'Настройки', 'Посмотреть виджет', 'Тест сцен (сезон, время)', 'Обновить курсы'], 'Закрыть');
    if (i < 0) return;
    if (i === 0) await converter(cfg);
    if (i === 1) await presentLive(cfg);
    if (i === 2) { const s = await wizard(settings); if (s) { settings = s; await previewWidget(resolveConfig('', s)); } }
    if (i === 3) await previewWidget(cfg);
    if (i === 4) await sceneTest(cfg);
    if (i === 5) {
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
    convertMinor, rate4, trendOf, fmtMoney, fmtRate, parseRates, errorWidget, sceneState, buildLiveHTML, KIT, threeTargets, targetsFor,
  };
} else {
  await main();
}
