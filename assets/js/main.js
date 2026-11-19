/* =========================================================
   Aweron — интерактив лендинга. Ванильный JS, без библиотек.
   Скрипт подключён с defer: DOM уже разобран.
   ========================================================= */
(function () {
  "use strict";

  var CFG = window.AWERON_CONFIG || {};
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(pointer: fine)").matches;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Безопасная обёртка над хранилищами (приватный режим, заблокированные cookie и т. п.)
  var store = {
    get: function (area, key) { try { return window[area].getItem(key); } catch (e) { return null; } },
    set: function (area, key, val) { try { window[area].setItem(key, val); } catch (e) { /* игнорируем */ } }
  };

  // Каждый блок изолирован: ошибка в одном не ломает остальные
  function safe(name, fn) {
    try { fn(); } catch (err) { if (window.console) console.error("[Aweron] " + name + ":", err); }
  }

  /* ---------- Флаги стран: если браузер не рисует эмодзи флагов (Chromium на Windows),
     включаем свой шрифт Twemoji Country Flags (assets/fonts). Проверка — отрисовкой на canvas. */
  safe("flags", function () {
    function isColorEmoji(text) {
      var c = document.createElement("canvas"); c.width = c.height = 1;
      var x = c.getContext("2d", { willReadFrequently: true });
      if (!x) return true;
      x.textBaseline = "top";
      x.font = '100px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      x.scale(0.01, 0.01);
      function px(color) { x.clearRect(0, 0, 100, 100); x.fillStyle = color; x.fillText(text, 0, 0); return x.getImageData(0, 0, 1, 1).data.join(","); }
      var a = px("#fff"), b = px("#000");
      return a === b && b.indexOf("0,0,0,") !== 0; // цветной глиф не зависит от цвета текста
    }
    if (!isColorEmoji("\uD83C\uDDE8\uD83C\uDDED")) document.documentElement.classList.add("flag-polyfill");
  });

  /* ---------- 0. Подстановка данных из конфига ---------- */
  function formatRub(n) { return Number(n).toLocaleString("ru-RU") + " ₽"; }
  function isFilled(v) { return typeof v === "string" && v.trim() !== "" && v.indexOf("[") === -1; }

  safe("config", function () {
    var prices = CFG.prices || {};
    $all("[data-price]").forEach(function (el) {
      var v = prices[el.getAttribute("data-price")];
      if (typeof v === "number" && isFinite(v)) el.textContent = formatRub(v);
    });
    $all("[data-price-sum]").forEach(function (el) {
      var keys = el.getAttribute("data-price-sum").split(",");
      var sum = 0, ok = true;
      keys.forEach(function (k) { var v = prices[k.trim()]; if (typeof v === "number") sum += v; else ok = false; });
      if (ok) el.textContent = formatRub(sum);
    });

    if (CFG.telegramUrl) {
      $all("[data-tg]").forEach(function (a) { a.setAttribute("href", CFG.telegramUrl); });
    }

    var c = CFG.contacts || {};
    $all("[data-contact]").forEach(function (el) {
      var type = el.getAttribute("data-contact");
      var val = c[type];
      var li = el.closest("li") || el;
      if (type === "telegram") {
        if (isFilled(val)) el.textContent = "Telegram " + val;
        return;
      }
      if (!isFilled(val)) { li.hidden = true; return; }
      if (type === "phone") { el.textContent = val; el.setAttribute("href", "tel:" + val.replace(/[^\d+]/g, "")); }
      if (type === "email") { el.textContent = val; el.setAttribute("href", "mailto:" + val); }
      if (type === "vk") { el.setAttribute("href", val); }
    });

    $all("[data-contact-text]").forEach(function (el) {
      var v = c[el.getAttribute("data-contact-text")];
      if (isFilled(v)) el.textContent = v;
    });
    if (isFilled(CFG.siteUrl)) {
      $all("[data-site]").forEach(function (el) { el.textContent = CFG.siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""); });
    }

    var legal = CFG.legal || {};
    $all("[data-legal]").forEach(function (el) {
      var v = legal[el.getAttribute("data-legal")];
      if (typeof v === "string" && v.trim()) el.textContent = v;
    });
    $all("[data-year]").forEach(function (el) { el.textContent = String(new Date().getFullYear()); });
    var cv = /^(\d{4})-(\d{2})-(\d{2})$/.exec(legal.consentVersion || "");
    if (cv) $all("[data-consent-version]").forEach(function (el) { el.textContent = cv[3] + "." + cv[2] + "." + cv[1]; });
  });

  /* ---------- 13. Шапка при прокрутке ---------- */
  safe("header", function () {
    var header = $(".site-header");
    if (!header) return;
    var ticking = false;
    function update() { header.classList.toggle("scrolled", window.scrollY > 20); ticking = false; }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  });

  /* ---------- 12. Мобильное меню ---------- */
  safe("menu", function () {
    var burger = $(".burger");
    var menu = $("#mobile-menu");
    if (!burger || !menu) return;
    var lastFocus = null;

    function focusables() {
      return [burger].concat($all("a, button", menu));
    }
    function open() {
      lastFocus = document.activeElement;
      menu.classList.add("open");
      burger.setAttribute("aria-expanded", "true");
      burger.setAttribute("aria-label", "Закрыть меню");
      document.body.classList.add("menu-open");
      var first = $("a", menu);
      if (first) setTimeout(function () { first.focus(); }, 60);
    }
    function close(restoreFocus) {
      if (!menu.classList.contains("open")) return;
      menu.classList.remove("open");
      burger.setAttribute("aria-expanded", "false");
      burger.setAttribute("aria-label", "Открыть меню");
      document.body.classList.remove("menu-open");
      if (restoreFocus) (lastFocus && lastFocus.focus ? lastFocus : burger).focus();
    }
    burger.addEventListener("click", function () {
      if (menu.classList.contains("open")) close(true); else open();
    });
    // Закрытие по клику на ссылку
    $all("a", menu).forEach(function (a) { a.addEventListener("click", function () { close(false); }); });
    // Клик вне ссылок/кнопок меню (по «пустому» фону панели)
    menu.addEventListener("click", function (e) {
      if (!e.target.closest("a, button")) close(true);
    });
    document.addEventListener("keydown", function (e) {
      if (!menu.classList.contains("open")) return;
      if (e.key === "Escape") { close(true); return; }
      if (e.key === "Tab") { // фокус-ловушка: не уходим под меню
        var list = focusables();
        var first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    // При переходе на десктопную ширину меню закрываем
    window.matchMedia("(min-width: 1024px)").addEventListener("change", function (mq) { if (mq.matches) close(false); });
  });

  /* ---------- 1. Меняющаяся фраза в H1 ---------- */
  safe("rotator", function () {
    var rot = $(".rotator");
    if (!rot) return;
    var words = $all(".rotator-word", rot);
    if (words.length < 2 || reduceMotion) return;
    var idx = 0;
    var wide = window.matchMedia("(min-width: 768px)");

    function fit() {
      if (!wide.matches) { rot.style.width = ""; return; }
      rot.style.width = words[idx].getBoundingClientRect().width + "px";
    }
    function next() {
      var cur = words[idx];
      idx = (idx + 1) % words.length;
      var nxt = words[idx];
      cur.classList.remove("active");
      cur.classList.add("leaving");
      // мгновенно переносим входящее слово вниз без анимации, затем запускаем въезд
      nxt.style.transition = "none";
      nxt.classList.remove("leaving");
      void nxt.offsetWidth;
      nxt.style.transition = "";
      nxt.classList.add("active");
      fit();
      setTimeout(function () { cur.classList.remove("leaving"); }, 460);
    }
    // Ждём шрифты, чтобы ширина была правильной
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(fit);
    wide.addEventListener("change", fit);
    window.addEventListener("resize", fit, { passive: true });
    var timer = setInterval(next, 2600);
    document.addEventListener("visibilitychange", function () {
      clearInterval(timer);
      if (!document.hidden) timer = setInterval(next, 2600);
    });
  });

  /* ---------- 2–3. Стопка карточек: появление и 3D-наклон ---------- */
  safe("stack", function () {
    var visual = $(".hero-visual");
    if (!visual) return;
    requestAnimationFrame(function () { requestAnimationFrame(function () { visual.classList.add("reveal"); }); });

    var stack = $(".stack", visual);
    if (!stack || reduceMotion || !finePointer) return;
    var raf = 0, tx = 0, ty = 0;
    function apply() {
      raf = 0;
      stack.style.transform = "rotateY(" + (tx * 6).toFixed(2) + "deg) rotateX(" + (-ty * 5).toFixed(2) + "deg)";
    }
    visual.addEventListener("pointermove", function (e) {
      var r = visual.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
      stack.classList.add("is-tilting");
      if (!raf) raf = requestAnimationFrame(apply);
    });
    visual.addEventListener("pointerleave", function () {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      stack.classList.remove("is-tilting");
      stack.style.transform = "";
    });
  });

  /* ---------- 6 и 10. Появление при прокрутке ---------- */
  safe("reveal", function () {
    var items = $all(".reveal-up, .js-observe");
    if (reduceMotion || !("IntersectionObserver" in window)) {
      items.forEach(function (el) { el.classList.add("visible"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("visible"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    items.forEach(function (el) { io.observe(el); });
  });

  /* ---------- 9. Чат в демо-блоке ---------- */
  safe("chat", function () {
    var chat = $("#demo-chat");
    if (!chat) return;
    var msgs = $all(".msg", chat);
    var replay = $(".chat-replay", chat);
    var running = false;

    if (reduceMotion) { // показываем всю переписку сразу
      if (replay) replay.hidden = true;
      return;
    }
    chat.classList.add("is-scripted");

    async function play() {
      if (running) return; // защита от параллельного запуска
      running = true;
      if (replay) replay.disabled = true;
      msgs.forEach(function (m) { m.classList.remove("shown", "is-typing"); });
      await sleep(400);
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m.classList.contains("msg--bot")) {
          m.classList.add("is-typing");
          var len = (m.querySelector(".bubble").textContent || "").length;
          await sleep(Math.min(1800, Math.max(800, len * 12)));
          m.classList.remove("is-typing");
        } else {
          await sleep(m.classList.contains("msg--system") ? 500 : 700);
        }
        m.classList.add("shown");
        await sleep(350);
      }
      running = false;
      if (replay) replay.disabled = false;
    }

    if (replay) replay.addEventListener("click", play);

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { io.disconnect(); play(); }
      }, { threshold: 0.35 });
      io.observe(chat);
    } else {
      play();
    }
  });

  /* ---------- 11. FAQ-аккордеон ---------- */
  safe("faq", function () {
    var items = $all(".faq-item");
    function setState(item, open) {
      var btn = $(".faq-q", item);
      var panel = $(".faq-a", item);
      item.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) panel.removeAttribute("inert"); else panel.setAttribute("inert", "");
    }
    items.forEach(function (item) {
      setState(item, false);
      $(".faq-q", item).addEventListener("click", function () {
        var willOpen = !item.classList.contains("open");
        items.forEach(function (other) { if (other !== item) setState(other, false); });
        setState(item, willOpen);
      });
    });
  });

  /* ---------- Кнопки «Обсудить» отмечают услугу в форме ---------- */
  safe("pick", function () {
    var map = { "bundle": ["ai-admin", "automation", "website"] };
    $all("[data-pick]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-pick");
        (map[key] || [key]).forEach(function (k) {
          var cb = $('input[data-service="' + k + '"]');
          if (cb) cb.checked = true;
        });
      });
    });
  });

  /* ---------- UTM: берём при первом заходе, храним в sessionStorage ---------- */
  var UTM_KEY = "aweron_utm";
  var UTM_FIELDS = ["source", "medium", "campaign", "content", "term"];
  safe("utm", function () {
    if (store.get("sessionStorage", UTM_KEY)) return;
    var params = new URLSearchParams(location.search);
    var utm = {}, has = false;
    UTM_FIELDS.forEach(function (f) {
      var v = (params.get("utm_" + f) || "").slice(0, 200);
      utm[f] = v; if (v) has = true;
    });
    if (has) store.set("sessionStorage", UTM_KEY, JSON.stringify(utm));
  });
  function getUtm() {
    var empty = { source: "", medium: "", campaign: "", content: "", term: "" };
    try {
      var raw = store.get("sessionStorage", UTM_KEY);
      if (!raw) return empty;
      var parsed = JSON.parse(raw);
      UTM_FIELDS.forEach(function (f) { empty[f] = typeof parsed[f] === "string" ? parsed[f] : ""; });
      return empty;
    } catch (e) { return empty; }
  }

  /* ---------- 15. Форма заявки ---------- */
  safe("form", function () {
    var form = $("#lead-form");
    if (!form) return;
    var btn = $(".btn--submit", form);
    var btnLabel = $(".btn-label", btn);
    var status = $(".form-status", form);
    var statusText = $(".form-status-text", status);
    var statusTg = $(".form-status-tg", status);
    var comment = $("#f-comment");
    var counter = $("#f-comment-count");
    var sending = false;

    var TG_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/; // ник Telegram без @: 5–32 символа

    if (comment && counter) {
      comment.addEventListener("input", function () { counter.textContent = comment.value.length + " / 1000"; });
    }

    function setError(input, errId, msg) {
      var err = document.getElementById(errId);
      if (msg) { input.setAttribute("aria-invalid", "true"); err.textContent = msg; }
      else { input.removeAttribute("aria-invalid"); err.textContent = ""; }
      return !msg;
    }

    function validateName() {
      var el = form.elements.name, v = el.value.trim();
      var msg = "";
      if (!v) msg = "Укажите, как к вам обращаться.";
      else if (v.length < 2) msg = "Имя слишком короткое — минимум 2 символа.";
      else if (v.length > 60) msg = "Имя слишком длинное — максимум 60 символов.";
      return setError(el, "f-name-err", msg);
    }
    /* ---------- Поле контакта: телефон с выбором страны или Telegram ---------- */
    // ISO|название|код|маска (# — цифра). Без маски — свободная группировка, 6–12 цифр.
    var COUNTRY_DATA = "RU|Россия|7|### ###-##-##;BY|Беларусь|375|## ###-##-##;KZ|Казахстан|7|### ###-##-##;UZ|Узбекистан|998|## ###-##-##;KG|Киргизия|996|### ###-###;TJ|Таджикистан|992|## ###-####;AM|Армения|374|## ###-###;AZ|Азербайджан|994|## ###-##-##;GE|Грузия|995|### ##-##-##;MD|Молдова|373|#### ####;TM|Туркменистан|993|## ##-##-##;UA|Украина|380|## ###-##-##;TR|Турция|90|### ### ## ##;AE|ОАЭ|971|## ### ####;AU|Австралия|61|### ### ###;AT|Австрия|43|;AL|Албания|355|;DZ|Алжир|213|;AO|Ангола|244|### ### ###;AD|Андорра|376|;AR|Аргентина|54|;AF|Афганистан|93|## ### ####;BD|Бангладеш|880|;BH|Бахрейн|973|#### ####;BE|Бельгия|32|### ## ## ##;BG|Болгария|359|;BO|Боливия|591|;BA|Босния и Герцеговина|387|;BR|Бразилия|55|(##) #####-####;GB|Великобритания|44|#### ######;HU|Венгрия|36|## ### ####;VE|Венесуэла|58|###-#######;VN|Вьетнам|84|;GH|Гана|233|;DE|Германия|49|;HK|Гонконг|852|#### ####;GR|Греция|30|### ### ####;DK|Дания|45|## ## ## ##;EG|Египет|20|### ### ####;IL|Израиль|972|## ###-####;IN|Индия|91|##### #####;ID|Индонезия|62|;JO|Иордания|962|# #### ####;IQ|Ирак|964|### ### ####;IR|Иран|98|### ### ####;IE|Ирландия|353|;IS|Исландия|354|### ####;ES|Испания|34|### ### ###;IT|Италия|39|;YE|Йемен|967|;KH|Камбоджа|855|;CM|Камерун|237|;CA|Канада|1|(###) ###-####;QA|Катар|974|#### ####;KE|Кения|254|### ######;CY|Кипр|357|## ######;CN|Китай|86|### #### ####;CO|Колумбия|57|### #######;CR|Коста-Рика|506|#### ####;CI|Кот-д’Ивуар|225|;CU|Куба|53|# ### ####;KW|Кувейт|965|#### ####;LA|Лаос|856|;LV|Латвия|371|## ### ###;LB|Ливан|961|;LY|Ливия|218|;LT|Литва|370|### #####;LI|Лихтенштейн|423|;LU|Люксембург|352|;MU|Маврикий|230|#### ####;MO|Макао|853|;MY|Малайзия|60|;MV|Мальдивы|960|###-####;MT|Мальта|356|#### ####;MA|Марокко|212|###-######;MX|Мексика|52|### ### ####;MC|Монако|377|;MN|Монголия|976|#### ####;MM|Мьянма|95|;NP|Непал|977|;NG|Нигерия|234|;NL|Нидерланды|31|# ########;NZ|Новая Зеландия|64|;NO|Норвегия|47|### ## ###;OM|Оман|968|#### ####;PK|Пакистан|92|### #######;PA|Панама|507|####-####;PY|Парагвай|595|;PE|Перу|51|### ### ###;PL|Польша|48|### ### ###;PT|Португалия|351|### ### ###;RO|Румыния|40|### ### ###;SV|Сальвадор|503|####-####;SM|Сан-Марино|378|;SA|Саудовская Аравия|966|## ### ####;MK|Северная Македония|389|;SC|Сейшелы|248|# ### ###;SN|Сенегал|221|;RS|Сербия|381|;SG|Сингапур|65|#### ####;SY|Сирия|963|### ### ###;SK|Словакия|421|### ### ###;SI|Словения|386|## ### ###;US|США|1|(###) ###-####;TW|Тайвань|886|;TH|Таиланд|66|## ### ####;TZ|Танзания|255|### ### ###;TN|Тунис|216|## ### ###;UG|Уганда|256|### ######;UY|Уругвай|598|;PH|Филиппины|63|### ### ####;FI|Финляндия|358|;FR|Франция|33|# ## ## ## ##;HR|Хорватия|385|;ME|Черногория|382|## ### ###;CZ|Чехия|420|### ### ###;CL|Чили|56|# #### ####;CH|Швейцария|41|## ### ## ##;SE|Швеция|46|## ### ## ##;LK|Шри-Ланка|94|## ### ####;EC|Эквадор|593|;EE|Эстония|372|;ET|Эфиопия|251|## ### ####;KR|Южная Корея|82|;ZA|ЮАР|27|## ### ####;JP|Япония|81|";
    var POPULAR = ["RU", "BY", "KZ", "UZ", "KG", "TJ", "AM", "AZ", "GE", "MD", "TR", "AE"];
    var countries = COUNTRY_DATA.split(";").map(function (row) {
      var p = row.split("|"); return { iso: p[0], name: p[1], dial: p[2], mask: p[3] || "" };
    });
    var OTHER = { iso: "OTHER", name: "Другая страна", dial: "", mask: "" };
    var byIso = { OTHER: OTHER };
    countries.forEach(function (c) { byIso[c.iso] = c; });
    var sorted = countries.slice().sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); });
    var byDialLength = countries.slice().sort(function (a, b) { return b.dial.length - a.dial.length; });

    var contactBox = $(".field--contact", form);
    var phonePane = $('[data-pane="phone"]', form), tgPane = $('[data-pane="telegram"]', form);
    var phoneBox = $(".phone-box", form);
    var phoneInput = $("#f-phone"), tgInput = $("#f-tg");
    var ccBtn = $("#f-cc-btn"), ccPop = $("#f-cc-pop"), ccSearch = $("#f-cc-search"), ccList = $("#f-cc-list"), ccEmpty = $(".cc-empty", form);
    var hint = $("#f-contact-hint");
    var HINT = {
      phone: "Выберите страну — код подставится сам, пробелы появятся при вводе.",
      telegram: "Ник из профиля Telegram, без @ — например ivan_petrov. Можно вставить ссылку t.me/…"
    };
    var mode = "phone";
    var country = byIso.RU;

    function flagOf(iso) {
      if (iso === "OTHER") return "\uD83C\uDF10"; // 🌐
      return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65, 0x1F1E6 + iso.charCodeAt(1) - 65);
    }
    function maskLen(mask) { return (mask.match(/#/g) || []).length; }
    function maxDigits(c) { return c.iso === "OTHER" ? 15 : (c.mask ? maskLen(c.mask) : 12); }
    function groupFree(d) {
      var sizes = [3, 3, 2, 2, 2, 2, 2], out = [], i = 0, k = 0;
      while (i < d.length) { var n = sizes[Math.min(k, sizes.length - 1)]; out.push(d.slice(i, i + n)); i += n; k++; }
      return out.join(" ");
    }
    function formatDigits(d, c) {
      d = d.slice(0, maxDigits(c));
      if (!d) return "";
      if (c.iso === "OTHER") return "+" + groupFree(d);
      if (!c.mask) return groupFree(d);
      var out = "", i = 0;
      for (var k = 0; k < c.mask.length && i < d.length; k++) out += c.mask[k] === "#" ? d[i++] : c.mask[k];
      return out;
    }
    function placeholderFor(c) {
      if (c.iso === "OTHER") return "+44 20 1234 5678";
      if (c.iso === "RU") return "900 000-00-00";
      if (c.iso === "KZ") return "700 000-00-00";
      return c.mask ? c.mask.replace(/#/g, "0") : "000 000 000";
    }
    // определение страны по международному номеру (цифры после «+»)
    function detectCountry(all) {
      if (all.charAt(0) === "7") return /^7[67]/.test(all) ? byIso.KZ : byIso.RU;
      if (all.charAt(0) === "1") return country.iso === "CA" ? byIso.CA : byIso.US;
      for (var i = 0; i < byDialLength.length; i++) if (all.indexOf(byDialLength[i].dial) === 0) return byDialLength[i];
      return null;
    }
    function caretAfterDigits(str, n) {
      if (n <= 0) return str.charAt(0) === "+" ? 1 : 0;
      for (var i = 0, c = 0; i < str.length; i++) if (/\d/.test(str[i]) && ++c === n) return i + 1;
      return str.length;
    }

    function setCountry(c, opts) {
      opts = opts || {};
      var digits = opts.digits != null ? opts.digits : phoneInput.value.replace(/\D/g, "");
      if (country.iso === "OTHER" && c.iso !== "OTHER" && opts.digits == null) digits = ""; // из «+…» в страну — номер вводится заново
      country = c;
      $(".flag", ccBtn).textContent = flagOf(c.iso);
      $(".cc-code", ccBtn).textContent = c.iso === "OTHER" ? "+" : "+" + c.dial;
      ccBtn.setAttribute("aria-label", "Код страны: " + c.name + (c.dial ? ", +" + c.dial : ""));
      phoneInput.placeholder = placeholderFor(c);
      phoneInput.setAttribute("aria-label", c.iso === "OTHER" ? "Номер телефона с кодом страны" : "Номер телефона без кода страны");
      phoneInput.value = formatDigits(digits, c);
      if (phoneInput.getAttribute("aria-invalid") === "true") validateContact();
    }

    function onPhoneInput() {
      var raw = phoneInput.value;
      var caret = phoneInput.selectionStart == null ? raw.length : phoneInput.selectionStart;
      var before = raw.slice(0, caret).replace(/\D/g, "").length;
      var digits = raw.replace(/\D/g, "");
      var intl = /^\s*(\+|00)/.test(raw);
      if (intl && country.iso !== "OTHER") {
        // ввели или вставили номер с кодом: «+44…», «0044…», автозаполнение «+7900…»
        var skip = /^\s*00/.test(raw) ? 2 : 0;
        var all = digits.slice(skip);
        var found = detectCountry(all);
        if (found) {
          var rest = all.slice(found.dial.length);
          before = Math.max(0, before - skip - found.dial.length);
          setCountry(found, { digits: rest });
          digits = rest;
        } else if (all.length > 3) {
          setCountry(OTHER, { digits: all });
          digits = all; before = Math.max(0, before - skip);
        }
      } else if ((country.iso === "RU" || country.iso === "KZ") && digits.length === 11 && /^[78]/.test(digits)) {
        digits = digits.slice(1); before = Math.max(0, before - 1); // «8 900…» / «7 900…» без плюса
      }
      var formatted = formatDigits(digits, country);
      phoneInput.value = formatted;
      if (document.activeElement === phoneInput) {
        var pos = caretAfterDigits(formatted, before);
        phoneInput.setSelectionRange(pos, pos);
      }
      if (phoneInput.getAttribute("aria-invalid") === "true") validateContact();
    }
    // Backspace/Delete «перепрыгивают» пробелы и дефисы и удаляют цифру
    phoneInput.addEventListener("keydown", function (e) {
      var s0 = phoneInput.selectionStart, s1 = phoneInput.selectionEnd, v = phoneInput.value;
      if (s0 !== s1) return;
      if (e.key === "Backspace" && s0 > 0 && /\D/.test(v[s0 - 1])) {
        var i = s0 - 1; while (i > 0 && /\D/.test(v[i - 1])) i--;
        if (i > 0) phoneInput.setSelectionRange(i, i);
      } else if (e.key === "Delete" && s0 < v.length && /\D/.test(v[s0])) {
        var j = s0; while (j < v.length && /\D/.test(v[j])) j++;
        phoneInput.setSelectionRange(j, j);
      }
    });
    phoneInput.addEventListener("input", onPhoneInput);
    phoneInput.addEventListener("blur", function () { if (phoneInput.value.trim()) validateContact(); });

    function onTgInput() {
      var v = tgInput.value.trim();
      var m = v.match(/(?:t(?:elegram)?\.me\/)([A-Za-z0-9_]+)/i); // вставили ссылку t.me/username
      if (m) v = m[1];
      v = v.replace(/^@+/, "").replace(/[^A-Za-z0-9_]/g, "");
      if (v !== tgInput.value) tgInput.value = v;
      if (tgInput.getAttribute("aria-invalid") === "true") validateContact();
    }
    tgInput.addEventListener("input", onTgInput);
    tgInput.addEventListener("blur", function () { if (tgInput.value.trim()) validateContact(); });

    function setMode(m, focus) {
      mode = m;
      phonePane.hidden = m !== "phone";
      tgPane.hidden = m !== "telegram";
      hint.textContent = HINT[m];
      setError(phoneInput, "f-contact-err", ""); setError(tgInput, "f-contact-err", "");
      phoneBox.classList.remove("is-invalid"); tgPane.classList.remove("is-invalid");
      closeList(false);
      if (focus) (m === "phone" ? phoneInput : tgInput).focus();
    }
    $all('input[name="contact_type"]', form).forEach(function (r) {
      r.addEventListener("change", function () { if (r.checked) setMode(r.value, true); });
    });

    /* список стран */
    var activeIdx = -1;
    function options() { return $all('[role="option"]', ccList); }
    function setActive(i, scroll) {
      var opts = options();
      if (!opts.length) { activeIdx = -1; ccSearch.removeAttribute("aria-activedescendant"); return; }
      activeIdx = (i + opts.length) % opts.length;
      opts.forEach(function (o, k) { o.classList.toggle("is-active", k === activeIdx); });
      ccSearch.setAttribute("aria-activedescendant", opts[activeIdx].id);
      if (scroll) opts[activeIdx].scrollIntoView({ block: "nearest" });
    }
    function makeOption(c) {
      var o = document.createElement("div");
      o.className = "cc-opt"; o.id = "cc-opt-" + c.iso; o.setAttribute("role", "option");
      o.setAttribute("aria-selected", c.iso === country.iso ? "true" : "false");
      o.dataset.iso = c.iso;
      var f = document.createElement("span"); f.className = "flag"; f.setAttribute("aria-hidden", "true"); f.textContent = flagOf(c.iso);
      var n = document.createElement("span"); n.className = "cc-name"; n.textContent = c.name;
      var d = document.createElement("span"); d.className = "cc-dial"; d.textContent = c.dial ? "+" + c.dial : "+…";
      o.appendChild(f); o.appendChild(n); o.appendChild(d);
      return o;
    }
    function makeGroup(title, list, key) {
      var g = document.createElement("div"); g.setAttribute("role", "group"); g.setAttribute("aria-labelledby", "cc-grp-" + key);
      var h = document.createElement("div"); h.className = "cc-group"; h.id = "cc-grp-" + key; h.setAttribute("role", "presentation"); h.textContent = title;
      g.appendChild(h);
      list.forEach(function (c) { g.appendChild(makeOption(c)); });
      return g;
    }
    function renderList(q) {
      ccList.textContent = "";
      q = (q || "").trim().toLowerCase();
      var qd = q.replace(/\D/g, "");
      if (!q) {
        ccList.appendChild(makeGroup("Популярные", POPULAR.map(function (iso) { return byIso[iso]; }), "pop"));
        ccList.appendChild(makeGroup("Все страны", sorted.filter(function (c) { return POPULAR.indexOf(c.iso) === -1; }).concat([OTHER]), "all"));
      } else {
        var res = sorted.filter(function (c) {
          return c.name.toLowerCase().indexOf(q) !== -1 || (qd && c.dial.indexOf(qd) === 0) || c.iso.toLowerCase() === q;
        });
        res.forEach(function (c) { ccList.appendChild(makeOption(c)); });
        ccList.appendChild(makeOption(OTHER));
        ccEmpty.hidden = res.length > 0;
      }
      if (!q) ccEmpty.hidden = true;
      var opts = options(), sel = 0;
      opts.forEach(function (o, k) { if (o.dataset.iso === country.iso && !q) sel = k; });
      setActive(sel, true);
    }
    function openList() {
      ccPop.hidden = false;
      ccBtn.setAttribute("aria-expanded", "true");
      ccSearch.value = "";
      renderList("");
      ccSearch.focus({ preventScroll: true });
      // на телефоне список может оказаться ниже края экрана — докручиваем, чтобы он был виден целиком
      var r = ccPop.getBoundingClientRect();
      if (r.bottom > window.innerHeight) window.scrollBy({ top: r.bottom - window.innerHeight + 16, behavior: reduceMotion ? "auto" : "smooth" });
    }
    function closeList(returnFocus) {
      if (ccPop.hidden) return;
      ccPop.hidden = true;
      ccBtn.setAttribute("aria-expanded", "false");
      ccSearch.removeAttribute("aria-activedescendant");
      if (returnFocus) ccBtn.focus();
    }
    function choose(iso) {
      setCountry(byIso[iso]);
      closeList(false);
      phoneInput.focus();
      var end = phoneInput.value.length; phoneInput.setSelectionRange(end, end);
    }
    ccBtn.addEventListener("click", function () { if (ccPop.hidden) openList(); else closeList(true); });
    ccBtn.addEventListener("keydown", function (e) {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ccPop.hidden) { e.preventDefault(); openList(); }
    });
    ccSearch.addEventListener("input", function () { renderList(ccSearch.value); });
    ccSearch.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1, true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1, true); }
      else if (e.key === "Home") { e.preventDefault(); setActive(0, true); }
      else if (e.key === "End") { e.preventDefault(); setActive(options().length - 1, true); }
      else if (e.key === "Enter") { e.preventDefault(); var o = options()[activeIdx]; if (o) choose(o.dataset.iso); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeList(true); }
      else if (e.key === "Tab") { closeList(false); }
    });
    ccList.addEventListener("mousedown", function (e) { e.preventDefault(); }); // фокус остаётся в поиске
    ccList.addEventListener("click", function (e) { var o = e.target.closest('[role="option"]'); if (o) choose(o.dataset.iso); });
    ccList.addEventListener("mousemove", function (e) {
      var o = e.target.closest('[role="option"]'); if (!o) return;
      var i = options().indexOf(o); if (i !== activeIdx) setActive(i, false);
    });
    document.addEventListener("pointerdown", function (e) {
      if (!ccPop.hidden && !ccPop.contains(e.target) && !ccBtn.contains(e.target)) closeList(false);
    });

    // страна по умолчанию: регион из языка браузера, если это страна СНГ; иначе Россия
    (function () {
      var langs = navigator.languages || [navigator.language || ""];
      for (var i = 0; i < langs.length; i++) {
        var r = (String(langs[i]).split("-")[1] || "").toUpperCase();
        if (["BY", "KZ", "UZ", "KG", "TJ", "AM", "AZ", "GE", "MD", "TM", "UA"].indexOf(r) !== -1) { country = byIso[r]; break; }
      }
      setCountry(country, { digits: "" });
      hint.textContent = HINT.phone;
    })();

    function validateContact() {
      var msg = "", el;
      if (mode === "telegram") {
        el = tgInput;
        var v = tgInput.value.trim();
        if (!v) msg = "Укажите ник в Telegram — иначе мы не сможем ответить.";
        else if (!TG_RE.test(v)) msg = "Ник в Telegram: 5–32 символа, латиница, цифры и «_», например ivan_petrov.";
        tgPane.classList.toggle("is-invalid", !!msg);
      } else {
        el = phoneInput;
        var d = phoneInput.value.replace(/\D/g, "");
        if (!d) msg = "Оставьте номер телефона — иначе мы не сможем ответить.";
        else if (country.iso === "OTHER") { if (d.length < 8) msg = "Введите номер полностью, вместе с кодом страны."; }
        else if (country.mask) {
          var need = maskLen(country.mask);
          if (d.length !== need) msg = "Номер неполный: для страны «" + country.name + "» после +" + country.dial + " нужно " + need + " цифр.";
        } else if (d.length < 6) msg = "Номер слишком короткий — проверьте, пожалуйста.";
        phoneBox.classList.toggle("is-invalid", !!msg);
      }
      return setError(el, "f-contact-err", msg);
    }
    function contactValue() {
      if (mode === "telegram") return "@" + tgInput.value.trim();
      return "+" + (country.iso === "OTHER" ? "" : country.dial) + phoneInput.value.replace(/\D/g, "");
    }
    function validateComment() {
      var el = form.elements.comment;
      return setError(el, "f-comment-err", el.value.length > 1000 ? "Комментарий — не больше 1000 символов." : "");
    }
    function validateConsent() {
      var el = form.elements.consent;
      return setError(el, "f-consent-err", el.checked ? "" : "Нужно согласие на обработку данных, чтобы мы могли с вами связаться.");
    }

    // Проверка «на лету» после первого ухода из поля
    // при уходе из поля показываем ошибку, только если что-то введено: пустые поля подсвечиваются при отправке
    // (иначе сообщение сдвигает форму, и следующий клик промахивается)
    form.elements.name.addEventListener("blur", function () { if (form.elements.name.value.trim()) validateName(); });
    form.elements.consent.addEventListener("change", validateConsent);
    form.elements.name.addEventListener("input", function () {
      if (form.elements.name.getAttribute("aria-invalid") === "true") validateName();
    });

    function showStatus(kind, text, withTg) {
      status.hidden = false;
      status.className = "form-status is-" + kind;
      statusText.textContent = text; // только textContent — никакого innerHTML
      statusTg.hidden = !withTg;
    }
    function setLoading(on) {
      btn.classList.toggle("is-loading", on);
      btn.disabled = on;
      btnLabel.textContent = on ? "Отправляем…" : "Отправить заявку";
    }
    function cooldown(seconds) {
      btn.disabled = true;
      var left = seconds;
      btnLabel.textContent = "Отправлено · можно снова через " + left + " с";
      var t = setInterval(function () {
        left -= 1;
        if (left <= 0) { clearInterval(t); btn.disabled = false; btnLabel.textContent = "Отправить заявку"; return; }
        btnLabel.textContent = "Отправлено · можно снова через " + left + " с";
      }, 1000);
    }
    function success() {
      showStatus("success", "Заявка отправлена! Ответим в течение рабочего дня.", false);
      form.reset();
      setMode("phone", false);
      setCountry(country, { digits: "" });
      if (counter) counter.textContent = "0 / 1000";
      cooldown(30);
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (sending || btn.disabled) return;

      var checks = [validateName(), validateContact(), validateComment(), validateConsent()];
      if (checks.indexOf(false) !== -1) {
        var firstBad = form.querySelector('[aria-invalid="true"]');
        if (firstBad) firstBad.focus();
        return;
      }

      // Honeypot: бот заполнил скрытое поле — изображаем успех и ничего не отправляем
      if (form.elements.website.value) { success(); return; }

      var endpoint = (CFG.formEndpoint || "").trim();
      if (!endpoint) {
        showStatus("info", "Форма пока не подключена. Напишите нам в Telegram — ответим там.", true);
        return;
      }

      var payload = {
        name: form.elements.name.value.trim().slice(0, 60),
        contact: contactValue().slice(0, 40),
        contact_type: mode,
        country: mode === "phone" ? country.iso : "",
        niche: form.elements.niche.value,
        services: $all('input[name="services"]:checked', form).map(function (c) { return c.value; }),
        comment: form.elements.comment.value.trim().slice(0, 1000),
        consent: true,
        consent_version: (CFG.legal && CFG.legal.consentVersion) || "",
        consent_url: (CFG.siteUrl || location.origin).replace(/\/$/, "") + "/consent.html",
        page: location.href,
        utm: getUtm(),
        ts: new Date().toISOString()
      };

      sending = true;
      setLoading(true);
      status.hidden = true;
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 10000);
      try {
        var res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        setLoading(false);
        success();
        if (typeof window.ym === "function" && CFG.metrikaId) { try { window.ym(Number(CFG.metrikaId), "reachGoal", "lead"); } catch (e2) {} }
      } catch (err) {
        setLoading(false);
        var timeout = err && err.name === "AbortError";
        showStatus("error", timeout
          ? "Сервер не ответил за 10 секунд. Попробуйте ещё раз или напишите нам в Telegram."
          : "Не получилось отправить заявку. Проверьте интернет и попробуйте снова — или напишите нам в Telegram.", true);
      } finally {
        clearTimeout(timer);
        sending = false;
      }
    });
  });

  /* ---------- JSON-LD: ProfessionalService (из конфига) и FAQPage (из DOM) ---------- */
  safe("jsonld", function () {
    if (!$("#main")) return;
    function addLd(obj) {
      var s = document.createElement("script");
      s.type = "application/ld+json";
      s.textContent = JSON.stringify(obj);
      document.head.appendChild(s);
    }
    var c = CFG.contacts || {};
    var site = (CFG.siteUrl || location.origin).replace(/\/$/, "");
    var org = {
      "@context": "https://schema.org",
      "@type": "ProfessionalService",
      "name": "Aweron",
      "description": "Внедрение ИИ-администраторов, чат-ботов, автоматизации заявок и разработка сайтов для малого и среднего бизнеса.",
      "url": site + "/",
      "image": site + "/og-image.png",
      "logo": site + "/assets/img/logo/logo-512.png",
      "areaServed": [
        { "@type": "City", "name": "Сочи" },
        { "@type": "AdministrativeArea", "name": "Краснодарский край" },
        { "@type": "Country", "name": "Россия" }
      ],
      "address": { "@type": "PostalAddress", "addressLocality": "Сочи", "addressRegion": "Краснодарский край", "addressCountry": "RU" }
    };
    if (isFilled(c.phone)) org.telephone = c.phone;
    if (isFilled(c.email)) org.email = c.email;
    var same = [];
    if (isFilled(CFG.telegramUrl)) same.push(CFG.telegramUrl);
    if (isFilled(c.vk)) same.push(c.vk);
    if (same.length) org.sameAs = same;
    addLd(org);

    var faq = $all(".faq-item").map(function (item) {
      var q = $(".faq-q", item), a = $(".faq-a p", item);
      return {
        "@type": "Question",
        "name": q.textContent.trim(),
        "acceptedAnswer": { "@type": "Answer", "text": a.textContent.trim() }
      };
    });
    if (faq.length) addLd({ "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faq });
  });

  /* ---------- Cookie-окно и Яндекс Метрика (только после согласия) ----------
     Правила: окно не блокирует страницу и не забирает фокус; «Принять» и «Только необходимые»
     равнозначны; Метрика грузится только после «Принять»; выбор и его дата сохраняются;
     изменить выбор можно ссылкой «Настройки cookie» в футере. При отзыве согласия
     cookie Метрики удаляются и страница перезагружается, чтобы аналитика остановилась сразу. */
  safe("cookie", function () {
    var KEY = "aweron_cookie_consent";
    var KEY_AT = "aweron_cookie_consent_at";
    var id = String(CFG.metrikaId || "").trim();
    var hasMetrika = /^\d+$/.test(id);
    var banner = $("#cookie-banner");
    var more = banner && $(".cookie-more", banner);
    var details = banner && $(".cookie-details", banner);
    var opener = null;
    var hideTimer = 0;

    function loadMetrika() {
      if (!hasMetrika || window.ym) return;
      window.ym = function () { (window.ym.a = window.ym.a || []).push(arguments); };
      window.ym.l = Date.now();
      var s = document.createElement("script");
      s.async = true;
      s.src = "https://mc.yandex.ru/metrika/tag.js";
      document.head.appendChild(s);
      window.ym(Number(id), "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
    }

    function clearMetrikaCookies() {
      var host = location.hostname, parts = host.split("."), domains = ["", host];
      for (var i = 1; i < parts.length - 1; i++) domains.push("." + parts.slice(i).join("."));
      document.cookie.split(";").forEach(function (c) {
        var name = c.split("=")[0].trim();
        if (name.indexOf("_ym") !== 0 && name !== "yandexuid") return;
        domains.forEach(function (d) {
          document.cookie = name + "=; Max-Age=0; path=/" + (d ? "; domain=" + d : "");
        });
      });
    }

    function setDetails(open) {
      if (!more || !details) return;
      more.setAttribute("aria-expanded", open ? "true" : "false");
      details.classList.toggle("open", open);
      if (open) details.removeAttribute("inert"); else details.setAttribute("inert", "");
    }

    function show(byUser) {
      if (!banner) return;
      clearTimeout(hideTimer);
      setDetails(false);
      banner.hidden = false;
      requestAnimationFrame(function () { requestAnimationFrame(function () { banner.classList.add("is-visible"); }); });
      if (byUser) setTimeout(function () { banner.focus(); }, 60); // открыто из футера — переводим фокус в окно
    }

    function hide() {
      if (!banner) return;
      var hadFocus = banner.contains(document.activeElement);
      banner.classList.remove("is-visible");
      hideTimer = setTimeout(function () { banner.hidden = true; }, reduceMotion ? 0 : 420);
      if (hadFocus) {
        if (opener && document.body.contains(opener)) opener.focus();
        else { var main = $("#main") || document.body; main.setAttribute("tabindex", "-1"); main.focus({ preventScroll: true }); }
      }
      opener = null;
    }

    function decide(val) {
      var prev = store.get("localStorage", KEY);
      store.set("localStorage", KEY, val);
      store.set("localStorage", KEY_AT, new Date().toISOString());
      hide();
      if (val === "all") { loadMetrika(); return; }
      // отзыв согласия после того, как Метрика уже работала: чистим cookie и перезагружаем страницу
      if (prev === "all" && hasMetrika) {
        clearMetrikaCookies();
        if (window.ym) setTimeout(function () { location.reload(); }, reduceMotion ? 0 : 450);
      }
    }

    var choice = store.get("localStorage", KEY);
    if (choice === "all") loadMetrika();

    if (!banner) return;
    $all("[data-cookie]", banner).forEach(function (b) {
      b.addEventListener("click", function () { decide(b.getAttribute("data-cookie")); });
    });
    if (more) more.addEventListener("click", function () { setDetails(more.getAttribute("aria-expanded") !== "true"); });
    // Esc только сворачивает подробности — закрытие без выбора не считается согласием
    banner.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && more && more.getAttribute("aria-expanded") === "true") { setDetails(false); more.focus(); }
    });
    $all("[data-cookie-settings]").forEach(function (btn) {
      btn.addEventListener("click", function () { opener = btn; show(true); });
    });

    if (choice !== "all" && choice !== "necessary") {
      // ненавязчиво: появляется не сразу, а когда страница уже открылась
      setTimeout(function () { show(false); }, reduceMotion ? 0 : 1200);
    }
  });
})();
