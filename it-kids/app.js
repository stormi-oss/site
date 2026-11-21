/*
 * IT-Мир Бипа — движок заданий.
 * Без библиотек и сборки. Прогресс хранится только в браузере (localStorage), на сервер ничего не уходит.
 *
 * Устройство:
 *   ENGINES[тип](level, api) → { el, check?, checkLabel?, noCheck? }
 *   check() возвращает (или обещает) { ok: true } либо { ok: false, msg: 'мягкая подсказка' }.
 *   api.win() — засчитать задание, api.say(text, kind) — сообщение ребёнку, api.miss() — учесть попытку.
 */
(function () {
  'use strict';

  const WORLDS = window.IT_WORLDS || [];
  const RU = window.IT_RU_ALPHABET || 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
  const main = document.getElementById('main');
  const modalRoot = document.getElementById('modal-root');

  /* =========================================================
   * Хранилище
   * ========================================================= */
  const STORE_KEY = 'itkids.v1';
  const DEFAULTS = {
    done: {},          // 'robot:0' → дата прохождения (ms)
    stats: {},         // 'robot:0' → { tries, hints }
    plan: [],          // [{ k: 'robot:0', done: false }]
    notes: '',
    settings: { sound: false, motion: true, big: false, tutor: false }
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return structuredCloneSafe(DEFAULTS);
      const data = JSON.parse(raw);
      return {
        done: isObj(data.done) ? data.done : {},
        stats: isObj(data.stats) ? data.stats : {},
        plan: Array.isArray(data.plan) ? data.plan.filter(p => p && typeof p.k === 'string' && levelByKey(p.k)) : [],
        notes: typeof data.notes === 'string' ? data.notes : '',
        settings: Object.assign({}, DEFAULTS.settings, isObj(data.settings) ? data.settings : {})
      };
    } catch (e) {
      console.warn('[it-kids] не удалось прочитать прогресс, начинаем заново', e);
      return structuredCloneSafe(DEFAULTS);
    }
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('[it-kids] не удалось сохранить прогресс', e); }
  }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function structuredCloneSafe(v) { return JSON.parse(JSON.stringify(v)); }

  const state = loadState();

  function stat(k) {
    if (!state.stats[k]) state.stats[k] = { tries: 0, hints: 0 };
    return state.stats[k];
  }

  /* =========================================================
   * Утилиты
   * ========================================================= */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') {
          for (const [sk, sv] of Object.entries(v)) {
            if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
          }
        } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function worldById(id) { return WORLDS.find(w => w.id === id); }
  function levelByKey(k) {
    const [wid, idx] = String(k).split(':');
    const W = worldById(wid);
    return W && W.levels[+idx] ? { W, L: W.levels[+idx], idx: +idx } : null;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }
  function doneCount(W) { return W.levels.filter((_, i) => state.done[`${W.id}:${i}`]).length; }
  function reducedMotion() {
    return !state.settings.motion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Подписки, которые надо снять при уходе со страницы (таймеры, клавиатура)
  let disposers = [];
  function onLeave(fn) { disposers.push(fn); }
  function cleanup() {
    disposers.forEach(fn => { try { fn(); } catch (e) { console.warn(e); } });
    disposers = [];
    closeModal();
  }

  /* =========================================================
   * Звук (по умолчанию выключен — многие дети чувствительны к звукам)
   * ========================================================= */
  let audioCtx = null;
  function tone(freq, dur, when = 0, vol = 0.05) {
    if (!state.settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime + when;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    } catch (e) { /* звук не обязателен */ }
  }
  const SOUND = {
    tap() { tone(620, 0.07, 0, 0.03); },
    win() { tone(523, 0.2); tone(659, 0.2, 0.14); tone(784, 0.35, 0.28); },
    soft() { tone(392, 0.18, 0, 0.035); }
  };

  /* =========================================================
   * Настройки
   * ========================================================= */
  function applySettings() {
    const root = document.documentElement;
    root.classList.toggle('no-motion', !state.settings.motion);
    root.classList.toggle('big-text', !!state.settings.big);
  }

  /* =========================================================
   * Модальное окно
   * ========================================================= */
  let modalKeyHandler = null;
  function openModal(content) {
    closeModal();
    const box = h('div', { class: 'card modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' }, content);
    const back = h('div', { class: 'modal-back' }, box);
    modalRoot.append(back);
    modalKeyHandler = e => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', modalKeyHandler);
    const first = box.querySelector('button, a');
    if (first) first.focus();
  }
  function closeModal() {
    modalRoot.replaceChildren();
    if (modalKeyHandler) document.removeEventListener('keydown', modalKeyHandler);
    modalKeyHandler = null;
  }

  /* =========================================================
   * План урока
   * ========================================================= */
  function planNext() { return state.plan.find(p => !p.done) || null; }
  function inPlan(k) { return state.plan.some(p => p.k === k); }
  function togglePlan(k) {
    if (inPlan(k)) state.plan = state.plan.filter(p => p.k !== k);
    else state.plan.push({ k, done: false });
    saveState();
  }
  function autoPlan(n) {
    const plan = [];
    const pointers = WORLDS.map(() => 0);
    let guard = 0;
    while (plan.length < n && guard++ < 1000) {
      let added = false;
      for (let w = 0; w < WORLDS.length && plan.length < n; w++) {
        const W = WORLDS[w];
        while (pointers[w] < W.levels.length && state.done[`${W.id}:${pointers[w]}`]) pointers[w]++;
        if (pointers[w] < W.levels.length) {
          plan.push({ k: `${W.id}:${pointers[w]}`, done: false });
          pointers[w]++;
          added = true;
        }
      }
      if (!added) break; // всё пройдено
    }
    state.plan = plan;
    saveState();
    return plan.length;
  }

  /* =========================================================
   * Роутер
   * ========================================================= */
  let prevHash = '#/';
  let curHash = location.hash || '#/';
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  function route() {
    cleanup();
    const hash = location.hash || '#/';
    if (hash !== curHash) { prevHash = curHash; curHash = hash; }
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    window.scrollTo(0, 0);
    try {
      if (!parts.length) renderHome();
      else if (parts[0] === 'world') renderWorld(parts[1]);
      else if (parts[0] === 'play') renderPlay(parts[1], parseInt(parts[2], 10));
      else if (parts[0] === 'break') renderBreak();
      else if (parts[0] === 'tutor') renderTutor();
      else renderHome();
    } catch (e) {
      console.error('[it-kids] ошибка отрисовки', e);
      main.replaceChildren(h('div', { class: 'card' },
        h('h1', null, 'Что-то сломалось 🛠️'),
        h('p', null, 'Это не твоя ошибка. Вернись на карту и попробуй снова.'),
        h('a', { class: 'btn btn-main', href: '#/' }, 'На карту')));
    }
    main.focus({ preventScroll: true });
  }

  /* =========================================================
   * Главная
   * ========================================================= */
  function renderHome() {
    document.title = 'IT-Мир Бипа';
    const total = WORLDS.reduce((s, W) => s + W.levels.length, 0);
    const done = WORLDS.reduce((s, W) => s + doneCount(W), 0);

    const nodes = [
      h('div', { class: 'hello' },
        h('div', { class: 'hello-bot', 'aria-hidden': 'true' }, '🤖'),
        h('div', null,
          h('h1', null, 'Привет! Я робот Бип.'),
          h('p', { class: 'muted' }, `Выбери мир и выполняй задания. Пройдено: ${done} из ${total}.`)))
    ];

    if (state.plan.length) nodes.push(renderPlanCard());

    nodes.push(h('div', { class: 'worlds' }, WORLDS.map(W => {
      const d = doneCount(W);
      return h('a', { class: 'world-card', href: `#/world/${W.id}`, style: { '--wc': W.color } },
        h('div', { class: 'world-icon', 'aria-hidden': 'true' }, W.icon),
        h('div', { style: { flex: '1' } },
          h('h2', null, W.title),
          h('p', null, W.about),
          h('div', { class: 'progress', 'aria-label': `Пройдено ${d} из ${W.levels.length}` },
            h('span', { style: { width: `${Math.round(d / W.levels.length * 100)}%` } })),
          h('p', null, `${d} из ${W.levels.length}`)));
    })));

    main.replaceChildren(...nodes);
  }

  function renderPlanCard() {
    const next = planNext();
    const doneN = state.plan.filter(p => p.done).length;
    return h('section', { class: 'card plan', 'aria-label': 'План на сегодня' },
      h('h2', null, '📋 План на сегодня'),
      h('p', { class: 'muted' }, `Сделано ${doneN} из ${state.plan.length}.`),
      h('ol', null, state.plan.map((p, i) => {
        const ref = levelByKey(p.k);
        if (!ref) return null;
        const isNow = next && next.k === p.k;
        return h('li', { class: p.done ? 'done' : isNow ? 'now' : '' },
          h('span', { class: 'mark', 'aria-hidden': 'true' }, p.done ? '✓' : i + 1),
          h('span', { 'aria-hidden': 'true' }, ref.W.icon),
          h('span', null, `${ref.L.title}`, h('span', { class: 'sr' }, p.done ? ' — сделано' : isNow ? ' — сейчас' : '')));
      })),
      next
        ? h('a', { class: 'btn btn-main btn-big', href: `#/play/${next.k.replace(':', '/')}` }, doneN ? 'Продолжить →' : 'Начать →')
        : h('p', null, '🎉 Весь план выполнен! Можно выбрать любой мир или отдохнуть.'));
  }

  /* =========================================================
   * Страница мира
   * ========================================================= */
  function renderWorld(wid) {
    const W = worldById(wid);
    if (!W) return go('#/');
    document.title = `${W.title} — IT-Мир Бипа`;
    const firstUndone = W.levels.findIndex((_, i) => !state.done[`${W.id}:${i}`]);

    main.replaceChildren(
      h('div', { class: 'play-top' }, h('a', { class: 'btn', href: '#/' }, '← Карта')),
      h('div', { class: 'world-head' },
        h('div', { class: 'world-icon', 'aria-hidden': 'true' }, W.icon),
        h('div', null, h('h1', null, W.title), h('p', { class: 'muted' }, W.about))),
      h('section', { class: 'card howto', style: { '--wc': W.color } },
        h('h2', null, 'Как играть'),
        h('ol', null, W.howto.map(s => h('li', null, s)))),
      h('div', { class: 'levels' }, W.levels.map((L, i) => {
        const k = `${W.id}:${i}`;
        const done = !!state.done[k];
        const tile = h('a', {
          class: `level-tile${done ? ' done' : ''}${i === firstUndone ? ' next' : ''}`,
          href: `#/play/${W.id}/${i}`
        },
        h('span', { class: 'num' }, i + 1),
        h('span', { class: 'ttl' }, L.title),
        done ? h('span', { class: 'badge', 'aria-label': 'пройдено' }, '⭐') : null,
        i === firstUndone ? h('span', { class: 'sr' }, '(следующее)') : null);
        if (!state.settings.tutor) return tile;
        const btn = h('button', {
          type: 'button', class: `plan-toggle${inPlan(k) ? ' on' : ''}`,
          'aria-pressed': inPlan(k) ? 'true' : 'false',
          onclick: () => {
            togglePlan(k);
            btn.classList.toggle('on', inPlan(k));
            btn.setAttribute('aria-pressed', inPlan(k) ? 'true' : 'false');
            btn.textContent = inPlan(k) ? '✓ в плане' : '+ в план';
          }
        }, inPlan(k) ? '✓ в плане' : '+ в план');
        return h('div', null, tile, btn);
      }))
    );
  }

  /* =========================================================
   * Страница задания
   * ========================================================= */
  function renderPlay(wid, idx) {
    const W = worldById(wid);
    if (!W || !Number.isInteger(idx) || !W.levels[idx]) return go('#/');
    const L = W.levels[idx];
    const k = `${W.id}:${idx}`;
    document.title = `${L.title} — IT-Мир Бипа`;

    const msg = h('div', { class: 'msg', role: 'status', 'aria-live': 'polite' },
      'Прочитай задание и начинай. Если трудно — нажми «💡 Подсказка».');
    let won = false;

    const api = {
      say(text, kind) {
        msg.className = `msg${kind ? ' ' + kind : ''}`;
        msg.textContent = text;
        if (kind === 'try') SOUND.soft();
      },
      miss() { stat(k).tries++; saveState(); },
      win() {
        if (won) return;
        won = true;
        state.done[k] = state.done[k] || Date.now();
        const p = state.plan.find(x => x.k === k && !x.done);
        if (p) p.done = true;
        saveState();
        SOUND.win();
        api.say('Получилось! ⭐', 'good');
        setTimeout(() => showWin(W, idx), reducedMotion() ? 0 : 450);
      }
    };

    let eng;
    try {
      eng = ENGINES[W.type](L, api);
    } catch (e) {
      console.error('[it-kids] ошибка задания', k, e);
      throw e;
    }

    const hintBtn = h('button', {
      type: 'button', class: 'btn',
      onclick: () => { stat(k).hints++; saveState(); api.say('💡 ' + L.hint, 'info'); }
    }, '💡 Подсказка');
    const resetBtn = h('button', { type: 'button', class: 'btn', onclick: () => route() }, '↺ Сначала');

    let busy = false;
    const checkBtn = eng.noCheck ? null : h('button', {
      type: 'button', class: 'btn btn-main btn-big grow',
      onclick: async () => {
        if (busy || won) return;
        busy = true;
        checkBtn.disabled = true;
        try {
          const res = await eng.check();
          if (res && res.ok) api.win();
          else if (res) { api.miss(); api.say(res.msg, 'try'); }
        } catch (e) {
          console.error('[it-kids] ошибка проверки', e);
          api.say('Что-то пошло не так. Нажми «↺ Сначала».', 'try');
        } finally {
          busy = false;
          checkBtn.disabled = false;
        }
      }
    }, eng.checkLabel || '✓ Проверить');

    main.replaceChildren(
      h('div', { class: 'play-top' },
        h('a', { class: 'btn', href: `#/world/${W.id}` }, `← ${W.title}`),
        h('span', { class: 'pill' }, `Задание ${idx + 1} из ${W.levels.length}`)),
      h('section', { class: 'card goal', style: { '--wc': W.color } },
        h('div', { class: 'goal-icon', 'aria-hidden': 'true' }, W.icon),
        h('div', null, h('h1', null, L.title), h('p', null, L.goal))),
      h('div', { class: 'stage' }, eng.el),
      msg,
      h('div', { class: 'actions' }, hintBtn, resetBtn, checkBtn)
    );
  }

  const WIN_WORDS = ['Отлично!', 'Здорово!', 'Получилось!', 'Молодец!', 'Супер!'];
  function showWin(W, idx) {
    const next = planNext();
    const hasNextLevel = idx + 1 < W.levels.length;
    const buttons = [];
    if (next) {
      buttons.push(h('a', { class: 'btn btn-main btn-big', href: `#/play/${next.k.replace(':', '/')}` }, 'Дальше по плану →'));
    } else if (state.plan.length && state.plan.every(p => p.done)) {
      buttons.push(h('a', { class: 'btn btn-main btn-big', href: '#/' }, '🎉 План выполнен!'));
    } else if (hasNextLevel) {
      buttons.push(h('a', { class: 'btn btn-main btn-big', href: `#/play/${W.id}/${idx + 1}` }, 'Следующее →'));
    }
    buttons.push(h('button', { type: 'button', class: 'btn', onclick: () => route() }, '↺ Ещё раз'));
    buttons.push(h('a', { class: 'btn', href: `#/world/${W.id}` }, 'К миру'));
    openModal([
      h('div', { class: 'big-emoji', 'aria-hidden': 'true' }, '⭐'),
      h('h2', { id: 'modal-title' }, WIN_WORDS[idx % WIN_WORDS.length]),
      h('p', null, 'Задание выполнено.'),
      h('div', { class: 'btn-row' }, buttons)
    ]);
  }

  /* =========================================================
   * ДВИЖКИ ЗАДАНИЙ
   * ========================================================= */
  const ENGINES = {};

  /* ---------- Робот ---------- */
  const DIR = {
    U: { a: '↑', w: 'вверх', dx: 0, dy: -1 },
    D: { a: '↓', w: 'вниз', dx: 0, dy: 1 },
    L: { a: '←', w: 'влево', dx: -1, dy: 0 },
    R: { a: '→', w: 'вправо', dx: 1, dy: 0 }
  };
  const KEY_TO_DIR = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R' };

  ENGINES.robot = function (L, api) {
    const map = L.map;
    const H = map.length, Wd = map[0].length;
    let start = null, goal = null;
    const starEls = new Map();
    const limit = L.maxBlocks || 30;
    let prog = (L.preset || []).map(p => Array.isArray(p) ? { d: p[0], n: p[1] } : { d: p, n: 1 });
    let running = false;
    let sim = null;
    let blockEls = [];

    const board = h('div', { class: 'board', style: { '--cols': Wd }, role: 'img', 'aria-label': 'Поле робота' });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < Wd; x++) {
        const c = map[y][x];
        const cell = h('div', { class: `cell${c === '#' ? ' wall' : ''}` });
        if (c === 'R') start = { x, y };
        if (c === 'G') { goal = { x, y }; cell.append('🏁'); }
        if (c === '*') { const s = h('span', null, '⭐'); starEls.set(`${x},${y}`, s); cell.append(s); }
        board.append(cell);
      }
    }
    const bot = h('div', { class: 'bot', 'aria-hidden': 'true' }, '🤖');
    board.append(bot);

    function place(x, y) { bot.style.transform = `translate(${x * 100}%, ${y * 100}%)`; }
    place(start.x, start.y);

    const progEl = h('div', { class: 'program', 'aria-label': 'Программа', role: 'list' });
    const countEl = h('span', { class: 'pill' });
    const paletteBtns = {};
    const palette = h('div', { class: 'palette' }, ['L', 'U', 'D', 'R'].map(d => {
      paletteBtns[d] = h('button', {
        type: 'button', class: `dir-btn d-${d}`, 'aria-label': `Добавить шаг ${DIR[d].w}`,
        onclick: () => add(d)
      }, h('span', { class: 'arrow', 'aria-hidden': 'true' }, DIR[d].a), h('span', null, DIR[d].w));
      return paletteBtns[d];
    }));

    const stepBtn = h('button', { type: 'button', class: 'btn', onclick: stepOnce }, '👣 Шаг');
    const clearBtn = h('button', {
      type: 'button', class: 'btn', onclick: () => { if (running) return; prog = []; changed(); }
    }, '🗑 Очистить');

    function add(d) {
      if (running) return;
      // В режиме повтора та же стрелка подряд превращается в ×2, ×3…
      const last = prog[prog.length - 1];
      if (L.repeat && last && last.d === d && last.n < 9) {
        last.n++;
        SOUND.tap();
        changed();
        return;
      }
      if (prog.length >= limit) {
        api.say(L.maxBlocks
          ? `В этом задании можно не больше ${L.maxBlocks} ${plural(L.maxBlocks, 'блока', 'блоков', 'блоков')}. Используй повтор: нажимай «+» на блоке.`
          : 'Программа слишком длинная. Убери лишние блоки.', 'try');
        return;
      }
      SOUND.tap();
      prog.push({ d, n: 1 });
      changed();
    }
    function del(i) { if (running) return; prog.splice(i, 1); changed(); }
    function chg(i, delta) {
      if (running) return;
      prog[i].n = Math.min(9, Math.max(1, prog[i].n + delta));
      changed();
    }
    function changed() { resetSim(); drawProg(); }

    function drawProg() {
      blockEls = [];
      progEl.replaceChildren();
      if (!prog.length) progEl.append(h('div', { class: 'program-empty' }, 'Программа пустая. Нажми на стрелку внизу 👇'));
      prog.forEach((b, i) => {
        const el = h('div', { class: `block d-${b.d}`, role: 'listitem' },
          h('span', { class: 'idx', 'aria-hidden': 'true' }, i + 1),
          h('span', { class: 'arrow', 'aria-hidden': 'true' }, DIR[b.d].a),
          h('span', { class: 'sr' }, `Блок ${i + 1}: ${DIR[b.d].w}${b.n > 1 ? `, повторить ${b.n} раз` : ''}`),
          L.repeat ? h('div', { class: 'rep' },
            h('button', { type: 'button', 'aria-label': `Блок ${i + 1}: меньше повторов`, onclick: () => chg(i, -1) }, '−'),
            h('span', { 'aria-hidden': 'true' }, `×${b.n}`),
            h('button', { type: 'button', 'aria-label': `Блок ${i + 1}: больше повторов`, onclick: () => chg(i, 1) }, '+')) : null,
          h('button', { type: 'button', class: 'del', 'aria-label': `Убрать блок ${i + 1}`, onclick: () => del(i) }, '✕'));
        blockEls.push(el);
        progEl.append(el);
      });
      countEl.textContent = L.maxBlocks ? `Блоков: ${prog.length} из ${L.maxBlocks}` : `Блоков: ${prog.length}`;
    }
    // Пока Бип едет, программу менять нельзя
    function setRunning(v) {
      running = v;
      Object.values(paletteBtns).forEach(b => { b.disabled = v; });
      progEl.querySelectorAll('button').forEach(b => { b.disabled = v; });
      stepBtn.disabled = v;
      clearBtn.disabled = v;
    }

    function resetSim() {
      sim = null;
      place(start.x, start.y);
      starEls.forEach(s => s.classList.remove('got'));
      blockEls.forEach(b => b.classList.remove('active', 'bad'));
    }
    function newSim() { resetSim(); sim = { i: 0, k: 0, x: start.x, y: start.y, got: new Set(), over: false }; }

    // Один шаг робота: 'move' | 'wall' | 'done'
    function step() {
      if (sim.i >= prog.length) return 'done';
      const b = prog[sim.i];
      blockEls.forEach((el, j) => el.classList.toggle('active', j === sim.i));
      const nx = sim.x + DIR[b.d].dx, ny = sim.y + DIR[b.d].dy;
      if (nx < 0 || ny < 0 || nx >= Wd || ny >= H || map[ny][nx] === '#') return 'wall';
      sim.x = nx; sim.y = ny;
      place(nx, ny);
      const sk = `${nx},${ny}`;
      if (starEls.has(sk) && !sim.got.has(sk)) { sim.got.add(sk); starEls.get(sk).classList.add('got'); SOUND.tap(); }
      sim.k++;
      if (sim.k >= b.n) { sim.i++; sim.k = 0; }
      return sim.i >= prog.length ? 'done' : 'move';
    }
    function verdict() {
      sim.over = true;
      blockEls.forEach(el => el.classList.remove('active'));
      const atGoal = sim.x === goal.x && sim.y === goal.y;
      if (sim.got.size < starEls.size) {
        return { ok: false, msg: `Бип собрал звёзд: ${sim.got.size} из ${starEls.size}. Нужно собрать все ⭐ и прийти на флажок.` };
      }
      if (!atGoal) return { ok: false, msg: 'Программа закончилась, а Бип не на флажке 🏁. Добавь или поменяй стрелки.' };
      return { ok: true };
    }
    function wallResult() {
      sim.over = true;
      const i = sim.i;
      if (blockEls[i]) { blockEls[i].classList.remove('active'); blockEls[i].classList.add('bad'); }
      if (!reducedMotion()) { bot.classList.remove('bump'); void bot.offsetWidth; bot.classList.add('bump'); }
      return { ok: false, msg: `Ой! На блоке №${i + 1} Бип упёрся в стену или в край поля. Этот блок отмечен — поменяй его.` };
    }

    async function run() {
      if (!prog.length) return { ok: false, msg: 'Сначала составь программу: нажимай на стрелки внизу.' };
      setRunning(true);
      newSim();
      api.say('Бип выполняет программу… 🤖');
      await sleep(250);
      let res;
      for (;;) {
        const r = step();
        await sleep(reducedMotion() ? 380 : 420);
        if (r === 'wall') { res = wallResult(); break; }
        if (r === 'done') { res = verdict(); break; }
      }
      setRunning(false);
      return res;
    }

    function stepOnce() {
      if (running) return;
      if (!prog.length) { api.say('Сначала составь программу: нажимай на стрелки внизу.', 'try'); return; }
      if (!sim || sim.over) newSim();
      const r = step();
      if (r === 'wall') { const v = wallResult(); api.miss(); api.say(v.msg, 'try'); return; }
      if (r === 'done') {
        const v = verdict();
        if (v.ok) api.win(); else { api.miss(); api.say(v.msg, 'try'); }
        return;
      }
      api.say(`Шаг сделан. Сейчас работает блок №${sim.i + 1}. Нажми «Шаг» ещё раз.`);
    }

    // Стрелки на клавиатуре тоже добавляют блоки
    const onKey = e => {
      if (!KEY_TO_DIR[e.key] || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      e.preventDefault();
      add(KEY_TO_DIR[e.key]);
    };
    document.addEventListener('keydown', onKey);
    onLeave(() => document.removeEventListener('keydown', onKey));

    drawProg();

    const el = h('div', { class: 'robot-wrap' },
      board,
      h('section', { class: 'card program-box' },
        h('div', { class: 'program-head' }, h('strong', null, '📜 Программа Бипа'), countEl),
        progEl,
        h('div', { class: 'btn-row', style: { marginTop: '10px' } }, stepBtn, clearBtn)),
      h('section', { 'aria-label': 'Стрелки' }, palette),
      L.repeat ? h('p', { class: 'muted' }, 'Повтор: «+» на блоке — Бип сделает этот шаг больше раз. Одна и та же стрелка подряд сама превращается в повтор.') : null
    );
    return { el, check: run, checkLabel: '▶ Запустить' };
  };

  /* ---------- Пиксели ---------- */
  const PIX = {
    '.': ['Белый', '#ffffff'], k: ['Чёрный', '#2b2d42'], r: ['Красный', '#e2625f'], y: ['Жёлтый', '#f4d35e'],
    g: ['Зелёный', '#5fb86a'], b: ['Синий', '#4f86e8'], o: ['Оранжевый', '#f4a259'], p: ['Розовый', '#f29ac0'],
    n: ['Коричневый', '#9a6a48'], s: ['Голубой', '#9ad1f5']
  };
  const COL_LETTERS = 'ABCDEFGH';

  ENGINES.pixel = function (L, api) {
    const T = L.target, H = T.length, Wd = T[0].length;
    const used = [...new Set(T.join('').replace(/\./g, '').split(''))];
    const canvas = Array.from({ length: H }, () => Array(Wd).fill('.'));
    let cur = used[0];
    const codeMode = L.mode === 'binary' || L.mode === 'rle';
    const share = L.mode === 'copy' ? 0.45 : codeMode ? 0.5 : 0.9;
    const pxSize = `min(44px, calc((min(100vw, 980px) - 48px) * ${share} / ${Wd + 1}))`;

    function swatch(c) { return h('span', { class: 'sw', style: { background: PIX[c][1] }, 'aria-hidden': 'true' }); }

    function buildGrid(interactive) {
      const grid = h('div', { class: `pix-grid${interactive ? '' : ' small'}`, style: { '--px': pxSize } });
      const cols = `var(--px) repeat(${Wd}, var(--px))${interactive && codeMode ? ' auto' : ''}`;
      grid.style.gridTemplateColumns = cols;
      grid.append(h('div', { class: 'lbl' }));
      for (let x = 0; x < Wd; x++) grid.append(h('div', { class: 'lbl' }, COL_LETTERS[x]));
      if (interactive && codeMode) grid.append(h('div', { class: 'lbl', style: { justifyContent: 'start', paddingLeft: '8px' } }, L.mode === 'binary' ? 'Код' : 'Счёт'));
      const cells = [];
      for (let y = 0; y < H; y++) {
        grid.append(h('div', { class: 'lbl' }, y + 1));
        cells.push([]);
        for (let x = 0; x < Wd; x++) {
          const el = interactive
            ? h('button', { type: 'button', class: 'px', 'data-x': x, 'data-y': y, 'aria-label': `${COL_LETTERS[x]}${y + 1}` })
            : h('div', { class: 'px', style: { background: PIX[T[y][x]][1] } });
          cells[y].push(el);
          grid.append(el);
        }
        if (interactive && codeMode) grid.append(codeCell(y));
      }
      return { grid, cells };
    }

    function codeCell(y) {
      const row = T[y];
      if (L.mode === 'binary') {
        return h('div', { class: 'code', 'aria-label': `Строка ${y + 1}: ${row.split('').map(c => c === '.' ? 0 : 1).join(' ')}` },
          row.split('').map(c => c === '.' ? '0' : '1').join(' '));
      }
      const runs = [];
      for (const c of row) {
        if (runs.length && runs[runs.length - 1].c === c) runs[runs.length - 1].n++;
        else runs.push({ c, n: 1 });
      }
      return h('div', { class: 'code', 'aria-label': `Строка ${y + 1}: ` + runs.map(r => `${r.n} ${PIX[r.c][0].toLowerCase()}`).join(', ') },
        runs.map(r => h('span', { class: 'chip', 'aria-hidden': 'true' }, r.n, swatch(r.c))));
    }

    const { grid, cells } = buildGrid(true);
    function paint(x, y, val) {
      canvas[y][x] = val;
      const el = cells[y][x];
      el.style.background = PIX[val][1];
      el.classList.remove('wrong');
    }

    // Рисование: нажатие + протягивание (мышь, палец, перо)
    let drawing = false, drawVal = null;
    grid.addEventListener('pointerdown', e => {
      const el = e.target.closest('.px');
      if (!el || !el.dataset.x) return;
      e.preventDefault();
      const x = +el.dataset.x, y = +el.dataset.y;
      drawVal = (canvas[y][x] === cur && cur !== '.') ? '.' : cur;
      drawing = true;
      paint(x, y, drawVal);
      SOUND.tap();
    });
    grid.addEventListener('pointermove', e => {
      if (!drawing) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const px = el && el.closest && el.closest('.px');
      if (px && px.dataset.x && grid.contains(px)) paint(+px.dataset.x, +px.dataset.y, drawVal);
    });
    const stop = () => { drawing = false; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    onLeave(() => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); });
    // Клавиатура: Enter/пробел на клетке
    grid.addEventListener('click', e => {
      if (e.detail !== 0) return; // клик мышью уже обработан pointerdown
      const el = e.target.closest('.px');
      if (!el || !el.dataset.x) return;
      const x = +el.dataset.x, y = +el.dataset.y;
      paint(x, y, (canvas[y][x] === cur && cur !== '.') ? '.' : cur);
    });

    // Палитра
    const colorBtns = [];
    const colors = h('div', { class: 'colors', role: 'radiogroup', 'aria-label': 'Цвета' },
      [...used, '.'].map(c => {
        const b = h('button', {
          type: 'button', class: `color-btn${c === cur ? ' on' : ''}`, role: 'radio',
          'aria-checked': c === cur ? 'true' : 'false', 'aria-label': c === '.' ? 'Ластик' : PIX[c][0],
          style: { background: PIX[c][1] },
          onclick: () => {
            cur = c;
            colorBtns.forEach(x => { x.b.classList.toggle('on', x.c === c); x.b.setAttribute('aria-checked', x.c === c ? 'true' : 'false'); });
          }
        }, c === '.' ? '🧽' : '');
        colorBtns.push({ b, c });
        return b;
      }));

    const panels = [];
    if (L.mode === 'copy') {
      panels.push(h('div', { class: 'pix-panel' }, h('div', { class: 'pix-title' }, '👀 Образец'), buildGrid(false).grid));
    }
    panels.push(h('div', { class: 'pix-panel' }, h('div', { class: 'pix-title' }, '✏️ Твой рисунок'), grid));

    let extra = null;
    if (L.mode === 'coords') {
      const byColor = {};
      for (let y = 0; y < H; y++) for (let x = 0; x < Wd; x++) {
        const c = T[y][x];
        if (c !== '.') (byColor[c] = byColor[c] || []).push(`${COL_LETTERS[x]}${y + 1}`);
      }
      extra = h('section', { class: 'card coords-list' },
        h('strong', null, 'Адреса клеток. Нажми на адрес, когда закрасишь — он зачеркнётся.'),
        Object.entries(byColor).map(([c, list]) => h('div', { class: 'coord-row' },
          swatch(c), h('strong', null, PIX[c][0] + ':'),
          list.map(a => {
            const b = h('button', {
              type: 'button', class: 'coord', 'aria-pressed': 'false',
              onclick: () => { const on = b.classList.toggle('ticked'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
            }, a);
            return b;
          }))));
    } else if (L.mode === 'binary') {
      extra = h('p', { class: 'muted', style: { textAlign: 'center' } },
        '1 — закрась ', swatch(used[0]), ' , 0 — оставь белой ', swatch('.'));
    } else if (L.mode === 'rle') {
      extra = h('p', { class: 'muted', style: { textAlign: 'center' } },
        'Например, «3 ', swatch('.'), '» — три белые клетки подряд. Счёт идёт слева направо.');
    }

    function check() {
      let wrong = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < Wd; x++) {
        const bad = canvas[y][x] !== T[y][x];
        cells[y][x].classList.toggle('wrong', bad);
        if (bad) wrong++;
      }
      if (!wrong) return { ok: true };
      return { ok: false, msg: `Почти! Не совпадает ${wrong} ${plural(wrong, 'клетка', 'клетки', 'клеток')}. Я обвёл их пунктиром.` };
    }

    const el = h('div', { style: { display: 'grid', gap: '14px' } },
      extra && L.mode === 'coords' ? null : extra,
      h('div', { class: 'pixel-layout' }, panels, L.mode === 'coords' ? extra : null),
      colors);
    return { el, check };
  };

  /* ---------- Двоичные лампочки ---------- */
  ENGINES.binary = function (L, api) {
    const vals = [];
    for (let i = L.bits - 1; i >= 0; i--) vals.push(2 ** i);
    const read = L.mode === 'read';
    const on = vals.map(v => read ? (L.value & v) > 0 : false);
    const item = L.item || '🍎';
    let count = 0;

    const bulbEls = vals.map((v, i) => {
      const b = h('button', {
        type: 'button', class: 'bulb', disabled: read ? true : null,
        'aria-pressed': on[i] ? 'true' : 'false', 'aria-label': `Лампочка ${v}`,
        onclick: () => { on[i] = !on[i]; SOUND.tap(); update(); }
      },
      h('span', { class: 'glass', 'aria-hidden': 'true' }),
      h('span', { class: 'val' }, v),
      h('span', { class: 'dots', 'aria-hidden': 'true' }, Array.from({ length: v }, () => h('i'))),
      h('span', { class: 'bit', 'aria-hidden': 'true' }, '0'));
      return b;
    });
    const sumEl = h('p', { class: 'sum', 'aria-live': 'polite' });
    const codeEl = h('p', { class: 'muted', style: { textAlign: 'center', margin: 0 } });
    const basket = h('div', { class: 'items-row', 'aria-hidden': 'true' });
    const basketCount = h('p', { class: 'sum', 'aria-live': 'polite' });

    function update() {
      bulbEls.forEach((b, i) => {
        b.classList.toggle('on', on[i]);
        b.setAttribute('aria-pressed', on[i] ? 'true' : 'false');
        b.querySelector('.bit').textContent = on[i] ? '1' : '0';
      });
      codeEl.textContent = `Двоичный код: ${on.map(x => x ? 1 : 0).join('')}`;
      if (!read) {
        const parts = vals.filter((_, i) => on[i]);
        const sum = parts.reduce((a, b) => a + b, 0);
        sumEl.textContent = parts.length ? `Горят: ${parts.join(' + ')} = ${sum}` : 'Пока ни одна лампочка не горит.';
      } else {
        basket.replaceChildren(...Array.from({ length: count }, () => h('span', null, item)));
        basketCount.textContent = `В корзине: ${count}`;
      }
    }

    const children = [h('div', { class: 'bulbs' }, bulbEls), codeEl];
    if (!read) {
      children.unshift(h('section', { class: 'card target', style: { marginBottom: '14px' } },
        h('div', { class: 'muted' }, 'Нужно число'),
        h('div', { class: 'number' }, L.value),
        h('div', { class: 'items-row', 'aria-hidden': 'true' }, Array.from({ length: L.value }, () => h('span', null, item)))));
      children.push(sumEl);
    } else {
      children.push(h('section', { class: 'card', style: { marginTop: '14px', textAlign: 'center' } },
        h('strong', null, '🧺 Корзина'), basket, basketCount,
        h('div', { class: 'btn-row', style: { justifyContent: 'center' } },
          h('button', { type: 'button', class: 'btn btn-big', onclick: () => { if (count < 40) { count++; SOUND.tap(); update(); } } }, `＋ положить ${item}`),
          h('button', { type: 'button', class: 'btn btn-big', onclick: () => { if (count > 0) { count--; update(); } } }, `− убрать`))));
    }
    update();

    function check() {
      if (read) {
        if (count === L.value) return { ok: true };
        return { ok: false, msg: count < L.value
          ? `В корзине ${count}. Это меньше, чем показывают лампочки. Сложи числа под горящими лампочками.`
          : `В корзине ${count}. Это больше, чем показывают лампочки. Убери лишние.` };
      }
      const sum = vals.reduce((s, v, i) => s + (on[i] ? v : 0), 0);
      if (sum === L.value) return { ok: true };
      return { ok: false, msg: sum < L.value
        ? `Сейчас получается ${sum}. Это меньше, чем ${L.value}. Зажги ещё лампочку.`
        : `Сейчас получается ${sum}. Это больше, чем ${L.value}. Погаси какую-нибудь лампочку.` };
    }
    return { el: h('div', null, children), check };
  };

  /* ---------- Порядок ---------- */
  ENGINES.order = function (L, api) {
    const n = L.items.length;
    let order;
    do { order = shuffle([...Array(n).keys()]); } while (order.every((v, i) => v === i));
    let sel = null;
    const list = h('ol', { class: 'order-list' });
    const isNum = L.items.every(it => !it.e);

    function swap(i, j, focusDir) {
      [order[i], order[j]] = [order[j], order[i]];
      sel = null;
      SOUND.tap();
      draw();
      if (focusDir) {
        const btn = list.children[j] && list.children[j].querySelector(`[data-dir="${focusDir}"]`);
        if (btn && !btn.disabled) btn.focus();
        else if (list.children[j]) list.children[j].querySelector('.order-main').focus();
      }
    }

    function draw(marks) {
      list.replaceChildren(...order.map((itemIdx, pos) => {
        const it = L.items[itemIdx];
        return h('li', { class: `order-item${sel === pos ? ' sel' : ''}${marks && marks[pos] ? ' ok' : ''}` },
          h('span', { class: 'pos', 'aria-hidden': 'true' }, pos + 1),
          h('button', {
            type: 'button', class: `order-main${isNum ? ' num' : ''}`,
            'aria-label': `${pos + 1}. ${it.t}${sel === pos ? ' (выбрано)' : ''}`,
            onclick: () => {
              if (L.adjacentOnly) { api.say('В этом задании двигай карточки только кнопками ▲ и ▼ — меняй соседей.'); return; }
              if (sel === null) { sel = pos; draw(); list.children[pos].querySelector('.order-main').focus(); api.say('Теперь нажми на карточку, с которой поменять.'); }
              else if (sel === pos) { sel = null; draw(); }
              else swap(sel, pos);
            }
          }, it.e ? h('span', { class: 'e', 'aria-hidden': 'true' }, it.e) : null, it.t),
          h('span', { class: 'order-arrows' },
            h('button', { type: 'button', 'data-dir': 'up', 'aria-label': `Поднять «${it.t}»`, disabled: pos === 0 ? true : null, onclick: () => swap(pos, pos - 1, 'up') }, '▲'),
            h('button', { type: 'button', 'data-dir': 'down', 'aria-label': `Опустить «${it.t}»`, disabled: pos === n - 1 ? true : null, onclick: () => swap(pos, pos + 1, 'down') }, '▼')));
      }));
    }
    draw();

    function check() {
      const marks = order.map((v, i) => v === i);
      const good = marks.filter(Boolean).length;
      draw(marks);
      if (good === n) return { ok: true };
      return { ok: false, msg: `На своём месте: ${good} из ${n} (они зелёные). Подумай, куда поставить остальные.` };
    }
    return { el: list, check };
  };

  /* ---------- Разложи по коробкам ---------- */
  ENGINES.bins = function (L, api) {
    const items = shuffle(L.items);
    const place = items.map(() => null);
    const bad = new Set();
    let sel = null;
    const tray = h('div', { class: 'tray', 'aria-label': 'Предметы' });
    const binsEl = h('div', { class: 'bins' });
    const hintLine = h('p', { class: 'muted', style: { textAlign: 'center' } });

    tray.addEventListener('click', e => {
      if (e.target.closest('.thing')) return;
      if (sel !== null && place[sel] !== null) { place[sel] = null; bad.delete(sel); sel = null; SOUND.tap(); draw(); }
    });

    function thing(i, inBin) {
      const it = items[i];
      // Пока что-то выбрано, предметы в коробках «прозрачны» для нажатий: тап в любое место коробки кладёт выбранное
      const passive = inBin && sel !== null && sel !== i;
      return h('button', {
        type: 'button', class: `thing${sel === i ? ' sel' : ''}${bad.has(i) ? ' bad' : ''}`,
        'aria-pressed': sel === i ? 'true' : 'false',
        tabindex: passive ? '-1' : null,
        style: passive ? { pointerEvents: 'none' } : null,
        onclick: e => { e.stopPropagation(); sel = sel === i ? null : i; draw(); }
      }, it.e ? h('span', { class: 'e', 'aria-hidden': 'true' }, it.e) : null, it.t);
    }

    function draw() {
      const inTray = items.map((_, i) => i).filter(i => place[i] === null);
      tray.replaceChildren(...(inTray.length ? inTray.map(i => thing(i, false)) : [h('span', { class: 'tray-empty' }, 'Все предметы разложены. Нажми «✓ Проверить».')]));
      binsEl.replaceChildren(...L.bins.map(b => h('button', {
        type: 'button', class: `bin${sel !== null ? ' ready' : ''}`, 'aria-label': `Коробка «${b.name}»`,
        onclick: e => {
          if (e.target.closest('.thing')) return;
          if (sel === null) { api.say('Сначала нажми на предмет, а потом на коробку.'); return; }
          place[sel] = b.id; bad.delete(sel); sel = null; SOUND.tap(); draw();
        }
      },
      h('span', { class: 'bin-head' }, h('span', { class: 'e', 'aria-hidden': 'true' }, b.e), b.name),
      h('span', { class: 'bin-things' }, items.map((_, i) => i).filter(i => place[i] === b.id).map(i => thing(i, true))))));
      if (sel !== null) {
        const it = items[sel];
        hintLine.textContent = `Выбрано: ${it.e ? it.e + ' ' : ''}${it.t}. Теперь нажми на коробку${place[sel] ? ' (или на серую область сверху — вернуть назад)' : ''}.`;
      } else {
        hintLine.textContent = 'Нажми на предмет, потом на коробку.';
      }
    }
    draw();

    function check() {
      const left = place.filter(p => p === null).length;
      if (left) return { ok: false, msg: `Осталось разложить: ${left}. Все предметы должны лежать в коробках.` };
      bad.clear();
      items.forEach((it, i) => { if (place[i] !== it.bin) bad.add(i); });
      sel = null;
      draw();
      if (!bad.size) return { ok: true };
      return { ok: false, msg: `Почти! Не на своём месте: ${bad.size}. Они отмечены жёлтым — переложи их.` };
    }
    return { el: h('div', null, tray, hintLine, binsEl), check };
  };

  /* ---------- Логика ---------- */
  const SW = { A: ['Синий', '#4a78c9'], B: ['Красный', '#c9524f'], C: ['Зелёный', '#3f8f57'], D: ['Жёлтый', '#b58a12'] };
  function evalRule(rule, on) {
    if (typeof rule === 'string') return !!on[rule];
    const [op, ...args] = rule;
    if (op === 'and') return args.every(a => evalRule(a, on));
    if (op === 'or') return args.some(a => evalRule(a, on));
    if (op === 'not') return !evalRule(args[0], on);
    throw new Error('Неизвестная операция: ' + op);
  }
  function ruleNodes(rule, top) {
    if (typeof rule === 'string') return [h('span', { class: 'sv', style: { '--sc': SW[rule][1] } }, SW[rule][0])];
    const [op, ...args] = rule;
    if (op === 'not') return [h('span', { class: 'op' }, 'НЕ'), ...ruleNodes(args[0], false)];
    const word = op === 'and' ? 'И' : 'ИЛИ';
    const inner = [];
    args.forEach((a, i) => { if (i) inner.push(h('span', { class: 'op' }, word)); inner.push(...ruleNodes(a, false)); });
    return top ? inner : [h('span', { class: 'par' }, '('), ...inner, h('span', { class: 'par' }, ')')];
  }
  function ruleText(rule) {
    if (typeof rule === 'string') return SW[rule][0].toLowerCase();
    const [op, ...args] = rule;
    if (op === 'not') return 'не ' + ruleText(args[0]);
    return '(' + args.map(ruleText).join(op === 'and' ? ' и ' : ' или ') + ')';
  }

  ENGINES.logic = function (L, api) {
    const on = {};
    L.switches.forEach(s => { on[s] = false; });
    const swEls = {};
    const switches = h('div', { class: 'switches' }, L.switches.map(s => {
      swEls[s] = h('button', {
        type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', style: { '--sc': SW[s][1] },
        onclick: () => { on[s] = !on[s]; SOUND.tap(); update(); }
      }, h('span', null, SW[s][0]), h('span', { class: 'knob', 'aria-hidden': 'true' }), h('span', { class: 'state' }, 'ВЫКЛ'));
      return swEls[s];
    }));
    const lampEls = L.lamps.map((lamp, i) => h('div', { class: 'lamp' },
      h('span', { class: 'glass', 'aria-hidden': 'true' }),
      h('div', { class: 'lamp-body' },
        h('div', { class: 'rule' }, h('strong', null, `Лампа ${i + 1} горит, если:`), ...ruleNodes(lamp.rule, true),
          h('span', { class: 'sr' }, ruleText(lamp.rule))),
        h('div', { class: 'want' }, lamp.want ? 'Нужно: 💡 горит' : 'Нужно: 🌑 не горит'),
        h('div', { class: 'sr now', 'aria-live': 'polite' }))));

    function update() {
      L.switches.forEach(s => {
        swEls[s].classList.toggle('on', on[s]);
        swEls[s].setAttribute('aria-checked', on[s] ? 'true' : 'false');
        swEls[s].querySelector('.state').textContent = on[s] ? 'ВКЛ' : 'ВЫКЛ';
      });
      L.lamps.forEach((lamp, i) => {
        const lit = evalRule(lamp.rule, on);
        lampEls[i].classList.toggle('on', lit);
        lampEls[i].classList.remove('bad');
        lampEls[i].querySelector('.now').textContent = lit ? 'сейчас горит' : 'сейчас не горит';
      });
    }
    update();

    function check() {
      const wrong = [];
      L.lamps.forEach((lamp, i) => {
        const okLamp = evalRule(lamp.rule, on) === lamp.want;
        lampEls[i].classList.toggle('bad', !okLamp);
        if (!okLamp) wrong.push(i + 1);
      });
      if (!wrong.length) return { ok: true };
      return { ok: false, msg: wrong.length === 1
        ? `Почти! Лампа ${wrong[0]} пока не такая, как нужно. Посмотри на её правило.`
        : `Почти! Лампы ${wrong.join(' и ')} пока не такие, как нужно.` };
    }
    return { el: h('div', null, switches, h('div', { class: 'lamps' }, lampEls)), check };
  };

  /* ---------- Общая строка «клеточки + плитки» (шифры и узоры) ---------- */
  function slotBuilder({ count, onFull }) {
    const vals = Array(count).fill(null);
    const bad = new Set();
    const slots = vals.map((_, i) => h('button', {
      type: 'button', class: 'slot', 'aria-label': `Клетка ${i + 1}: пусто`,
      onclick: () => { if (vals[i] !== null) { vals[i] = null; bad.delete(i); draw(); } }
    }));
    function draw() {
      const firstEmpty = vals.indexOf(null);
      slots.forEach((s, i) => {
        s.textContent = vals[i] ?? '';
        s.className = `slot${vals[i] !== null ? ' filled' : ''}${i === firstEmpty ? ' next' : ''}${bad.has(i) ? ' bad' : ''}`;
        s.setAttribute('aria-label', `Клетка ${i + 1}: ${vals[i] ?? 'пусто'}`);
      });
    }
    function put(v) {
      const i = vals.indexOf(null);
      if (i < 0) { onFull(); return; }
      vals[i] = v; SOUND.tap(); draw();
    }
    function verify(answer) {
      bad.clear();
      if (vals.includes(null)) { draw(); return { ok: false, msg: 'Заполни все пустые клетки, а потом проверяй.' }; }
      vals.forEach((v, i) => { if (v !== answer[i]) bad.add(i); });
      draw();
      if (!bad.size) return { ok: true };
      return { ok: false, msg: `Почти! Не подходит: ${bad.size}. Эти клетки отмечены. Нажми на клетку, чтобы её очистить.` };
    }
    draw();
    return { slots, put, verify };
  }
  function tileButtons(values, put) {
    return h('div', { class: 'tiles', 'aria-label': 'Выбор' },
      values.map(v => h('button', { type: 'button', class: 'tile', onclick: () => put(v) }, v)));
  }

  /* ---------- Шифры ---------- */
  ENGINES.cipher = function (L, api) {
    const answer = [...L.answer];
    let symbols, keyEl = null, tiles;

    if (L.mode === 'table') {
      const toSym = Object.fromEntries(L.table.map(([s, l]) => [l, s]));
      symbols = answer.map(ch => toSym[ch]);
      keyEl = h('section', { class: 'card', style: { marginBottom: '14px' } },
        h('strong', null, '🗝️ Ключ'),
        h('div', { class: 'key-table', style: { marginTop: '8px', marginBottom: 0 } },
          L.table.map(([s, l]) => h('div', { class: 'key-pair' }, h('span', { class: 's' }, s), h('span', { 'aria-hidden': 'true' }, '↓'), h('span', { class: 'l' }, l)))));
      tiles = shuffle([...new Set(L.table.map(p => p[1]))]);
    } else {
      const extra = shuffle(RU.split('').filter(ch => !answer.includes(ch) && ch !== 'Ё' && ch !== 'Ъ')).slice(0, 3);
      tiles = shuffle([...new Set(answer), ...extra]);
      if (L.mode === 'caesar') {
        const N = RU.length;
        symbols = answer.map(ch => RU[(RU.indexOf(ch) + L.shift) % N]);
        keyEl = h('section', { class: 'card', style: { marginBottom: '14px' } },
          h('strong', null, `🗝️ Алфавит-подсказка (сдвиг ${L.shift}): сверху — буква из шифра, снизу — настоящая`),
          h('div', { class: 'abc', style: { marginTop: '8px', marginBottom: 0 } },
            RU.split('').map((ch, i) => h('div', null, h('span', null, ch), h('span', { class: 'lo' }, RU[(i - L.shift + N) % N])))));
      } else {
        symbols = answer.slice().reverse();
        keyEl = h('p', { class: 'muted', style: { textAlign: 'center' } }, '⬅️ Читай секретное слово справа налево.');
      }
    }

    const sb = slotBuilder({ count: answer.length, onFull: () => api.say('Все клетки заполнены. Нажми «✓ Проверить» или убери букву.') });
    const secret = h('div', { class: 'secret', 'aria-label': 'Секретное слово' },
      symbols.map((s, i) => h('div', { class: 'slot-col' }, h('span', { class: 's' }, s), sb.slots[i])));
    return {
      el: h('div', null, keyEl, secret, tileButtons(tiles, sb.put)),
      check: () => sb.verify(answer)
    };
  };

  /* ---------- Узоры ---------- */
  ENGINES.pattern = function (L, api) {
    const shown = L.full.slice(0, L.full.length - L.blanks);
    const answer = L.full.slice(L.full.length - L.blanks);
    const choices = shuffle([...new Set([...L.full, ...(L.extra || [])])]);
    const sb = slotBuilder({ count: L.blanks, onFull: () => api.say('Все клетки заполнены. Нажми «✓ Проверить».') });
    const seq = h('div', { class: 'seq', 'aria-label': 'Узор' },
      shown.map(v => h('div', { class: 'it' }, v)), sb.slots);
    return {
      el: h('div', null, seq, h('p', { class: 'muted', style: { textAlign: 'center' } }, 'Что будет дальше? Нажимай:'), tileButtons(choices, sb.put)),
      check: () => sb.verify(answer)
    };
  };

  /* ---------- Клавиатура ---------- */
  const KB_ROWS = ['1234567890', 'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'];
  const HOME_KEYS = new Set('фываолдж'.split(''));
  // Физическая клавиша → буква русской раскладки (работает даже при включённой английской раскладке)
  const CODE_MAP = {
    KeyQ: 'й', KeyW: 'ц', KeyE: 'у', KeyR: 'к', KeyT: 'е', KeyY: 'н', KeyU: 'г', KeyI: 'ш', KeyO: 'щ', KeyP: 'з',
    BracketLeft: 'х', BracketRight: 'ъ', KeyA: 'ф', KeyS: 'ы', KeyD: 'в', KeyF: 'а', KeyG: 'п', KeyH: 'р', KeyJ: 'о',
    KeyK: 'л', KeyL: 'д', Semicolon: 'ж', Quote: 'э', KeyZ: 'я', KeyX: 'ч', KeyC: 'с', KeyV: 'м', KeyB: 'и',
    KeyN: 'т', KeyM: 'ь', Comma: 'б', Period: 'ю', Space: ' ',
    Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0',
    Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4', Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9', Numpad0: '0'
  };

  ENGINES.keys = function (L, api) {
    const text = L.text;
    let pos = 0, finished = false;
    const keyEls = {};
    const typed = h('div', { class: 'typed', 'aria-hidden': 'true' },
      text.split('').map(ch => h('span', { class: ch === ' ' ? 'space' : '' }, ch === ' ' ? 'пробел' : ch)));
    const live = h('p', { class: 'sr', 'aria-live': 'polite' });
    const kb = h('div', { class: 'kb', 'aria-label': 'Клавиатура' },
      KB_ROWS.map(row => h('div', { class: 'kb-row' }, row.split('').map(ch => {
        keyEls[ch] = h('button', { type: 'button', class: `key${HOME_KEYS.has(ch) ? ' home' : ''}`, tabindex: '-1', onclick: () => press(ch) }, ch);
        return keyEls[ch];
      }))),
      h('div', { class: 'kb-row' }, (keyEls[' '] = h('button', { type: 'button', class: 'key space', tabindex: '-1', onclick: () => press(' ') }, 'пробел'))));

    function label(ch) { return ch === ' ' ? 'пробел' : ch.toUpperCase(); }
    function draw() {
      [...typed.children].forEach((s, i) => {
        s.classList.toggle('done', i < pos);
        s.classList.toggle('cur', i === pos);
      });
      Object.entries(keyEls).forEach(([ch, el]) => el.classList.toggle('hl', !finished && ch === text[pos]));
      if (!finished) live.textContent = `Нажми: ${label(text[pos])}`;
    }
    function press(ch) {
      if (finished) return;
      if (ch === text[pos]) {
        pos++;
        SOUND.tap();
        if (pos >= text.length) { finished = true; draw(); api.win(); return; }
        api.say(`Верно! Дальше — «${label(text[pos])}».`);
        draw();
      } else {
        api.say(`Нужна клавиша «${label(text[pos])}» — она подсвечена жёлтым. Ищи спокойно.`, 'try');
      }
    }
    const onKey = e => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (modalRoot.childElementCount) return;
      let ch = CODE_MAP[e.code];
      if (!ch && e.key && e.key.length === 1) ch = e.key.toLowerCase();
      if (ch === 'ё') ch = 'е';
      if (!ch) return;
      e.preventDefault();
      press(ch);
    };
    document.addEventListener('keydown', onKey);
    onLeave(() => document.removeEventListener('keydown', onKey));
    // Снимаем фокус с кнопок, чтобы пробел не нажимал их
    setTimeout(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); }, 0);
    draw();
    return {
      el: h('div', null, typed, live, kb, h('p', { class: 'muted', style: { textAlign: 'center', marginTop: '12px' } },
        'Клавиши с полоской снизу — «домашние»: на них лежат пальцы.')),
      noCheck: true
    };
  };

  /* =========================================================
   * Отдых
   * ========================================================= */
  function renderBreak() {
    document.title = 'Отдых — IT-Мир Бипа';
    const circle = h('div', { class: `breathe${reducedMotion() ? ' static' : ''}`, 'aria-live': 'polite' }, 'Вдох…');
    let inhale = true;
    const tick = () => {
      inhale = !inhale;
      circle.textContent = inhale ? 'Вдох…' : 'Выдох…';
      circle.classList.toggle('in', inhale);
    };
    setTimeout(() => circle.classList.add('in'), 50);
    const timer = setInterval(tick, 4000);
    onLeave(() => clearInterval(timer));
    const back = prevHash && !prevHash.startsWith('#/break') ? prevHash : '#/';
    main.replaceChildren(h('div', { class: 'breathe-wrap' },
      h('h1', null, '🌿 Минутка отдыха'),
      h('p', { class: 'muted' }, 'Дыши вместе с кругом. Можно попить воды, потянуться или посмотреть в окно.'),
      circle,
      h('a', { class: 'btn btn-main btn-big', href: back }, 'Я готов, вернуться')));
  }

  /* =========================================================
   * Взрослым (репетитор / родитель)
   * ========================================================= */
  function renderTutor() {
    document.title = 'Взрослым — IT-Мир Бипа';
    const S = state.settings;
    function setting(key, label, note, invert) {
      const input = h('input', { type: 'checkbox' });
      input.checked = invert ? !S[key] : !!S[key];
      input.addEventListener('change', () => {
        S[key] = invert ? !input.checked : input.checked;
        saveState();
        applySettings();
        if (key === 'sound' && S.sound) SOUND.tap();
      });
      return h('label', { class: 'setting' }, input, h('span', null, h('strong', null, label), note ? h('br') : null, note ? h('span', { class: 'muted' }, note) : null));
    }

    const planBox = h('div');
    function drawPlan() {
      planBox.replaceChildren(
        state.plan.length
          ? h('ol', null, state.plan.map(p => {
            const ref = levelByKey(p.k);
            return h('li', null, `${ref.W.icon} ${ref.W.title} → ${ref.idx + 1}. ${ref.L.title} ${p.done ? '✓' : ''} `,
              h('button', { type: 'button', class: 'btn btn-soft', style: { minHeight: '36px', padding: '2px 10px' }, 'aria-label': 'Убрать из плана', onclick: () => { togglePlan(p.k); drawPlan(); } }, '✕'));
          }))
          : h('p', { class: 'muted' }, 'План пуст.'),
        h('div', { class: 'btn-row' },
          [3, 5, 8].map(n => h('button', { type: 'button', class: 'btn', onclick: () => { autoPlan(n); drawPlan(); } }, `Авто: ${n} ${plural(n, 'задание', 'задания', 'заданий')}`)),
          h('button', { type: 'button', class: 'btn', onclick: () => { state.plan = []; saveState(); drawPlan(); } }, 'Очистить план')));
    }
    drawPlan();

    const rows = WORLDS.map(W => {
      let tries = 0, hints = 0;
      const hard = [];
      W.levels.forEach((L, i) => {
        const s = state.stats[`${W.id}:${i}`];
        if (!s) return;
        tries += s.tries; hints += s.hints;
        if (s.tries >= 3) hard.push(`${i + 1}. ${L.title} (${s.tries})`);
      });
      return { W, done: doneCount(W), tries, hints, hard };
    });

    function report() {
      const lines = ['Отчёт IT-Мир Бипа — ' + new Date().toLocaleDateString('ru-RU'), ''];
      rows.forEach(r => {
        lines.push(`${r.W.title}: пройдено ${r.done}/${r.W.levels.length}, ошибок при проверке ${r.tries}, подсказок ${r.hints}`);
        if (r.hard.length) lines.push('  Было трудно: ' + r.hard.join('; '));
      });
      if (state.notes.trim()) lines.push('', 'Заметки:', state.notes.trim());
      return lines.join('\n');
    }
    const copyStatus = h('span', { class: 'muted', 'aria-live': 'polite' });
    async function copyReport() {
      const text = report();
      try {
        await navigator.clipboard.writeText(text);
        copyStatus.textContent = 'Скопировано ✓';
      } catch (e) {
        const ta = h('textarea', { readonly: true }, text);
        copyStatus.replaceChildren(h('span', null, 'Скопируйте вручную:'), ta);
        ta.select();
      }
    }

    const notes = h('textarea', { 'aria-label': 'Заметки' });
    notes.value = state.notes;
    let notesTimer = null;
    notes.addEventListener('input', () => {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(() => { state.notes = notes.value.slice(0, 20000); saveState(); }, 400);
    });
    onLeave(() => { clearTimeout(notesTimer); state.notes = notes.value.slice(0, 20000); saveState(); });

    main.replaceChildren(
      h('div', { class: 'play-top' }, h('a', { class: 'btn', href: '#/' }, '← Карта')),
      h('h1', null, '⚙️ Для репетитора и родителей'),
      h('div', { class: 'tutor-grid' },
        h('section', { class: 'card' },
          h('h2', null, 'Настройки'),
          setting('sound', 'Тихие звуки', 'По умолчанию выключены: многим детям резкие звуки неприятны.'),
          setting('motion', 'Без анимаций', 'Робот прыгает по клеткам без плавного движения, ничего не «выскакивает».', true),
          setting('big', 'Крупный текст'),
          setting('tutor', 'Режим составления плана', 'В каждом мире под заданиями появятся кнопки «+ в план».')),
        h('section', { class: 'card' },
          h('h2', null, '📋 План урока'),
          h('p', { class: 'muted' }, 'Ребёнок увидит план на главной: что уже сделано и что дальше. Предсказуемость снижает тревогу. Авто-план берёт следующие непройденные задания из разных миров по очереди.'),
          planBox),
        h('section', { class: 'card' },
          h('h2', null, '📊 Прогресс'),
          h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Мир'), h('th', null, 'Пройдено'), h('th', null, 'Ошибок'), h('th', null, 'Подсказок'), h('th', null, 'Было трудно (≥3 ошибок)'))),
              h('tbody', null, rows.map(r => h('tr', null,
                h('td', null, `${r.W.icon} ${r.W.title}`), h('td', null, `${r.done}/${r.W.levels.length}`),
                h('td', null, r.tries), h('td', null, r.hints), h('td', null, r.hard.join('; ') || '—')))))),
          h('div', { class: 'btn-row', style: { marginTop: '12px', alignItems: 'center' } },
            h('button', { type: 'button', class: 'btn', onclick: copyReport }, '📋 Скопировать отчёт'), copyStatus)),
        h('section', { class: 'card' },
          h('h2', null, '📝 Заметки'),
          h('p', { class: 'muted' }, 'Хранятся только в этом браузере.'),
          notes),
        h('section', { class: 'card' },
          h('h2', null, 'Сброс'),
          h('p', { class: 'muted' }, 'Удалит прогресс, статистику и план на этом устройстве. Заметки и настройки останутся.'),
          h('button', {
            type: 'button', class: 'btn',
            onclick: () => {
              if (!window.confirm('Точно удалить весь прогресс на этом устройстве?')) return;
              state.done = {}; state.stats = {}; state.plan = []; saveState(); route();
            }
          }, 'Сбросить прогресс')))
    );
  }

  /* =========================================================
   * Старт
   * ========================================================= */
  if (!WORLDS.length) {
    main.replaceChildren(h('p', { class: 'card' }, 'Не загрузились задания (levels.js).'));
    return;
  }
  applySettings();
  window.addEventListener('hashchange', route);
  route();
})();
