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

    var PHONE_RE = /^(\+7|8)\d{10}$/;
    var TG_RE = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/;

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
    function normalizeContact(v) {
      v = v.trim();
      if (v.charAt(0) === "@") return v;
      return v.replace(/[\s\-()]/g, "");
    }
    function validateContact() {
      var el = form.elements.contact, raw = el.value.trim();
      var v = normalizeContact(raw), msg = "";
      if (!raw) msg = "Оставьте телефон или ник в Telegram — иначе мы не сможем ответить.";
      else if (v.charAt(0) === "@") { if (!TG_RE.test(v)) msg = "Ник в Telegram: от 5 символов, латиница, цифры и «_», например @ivan_petrov."; }
      else if (!PHONE_RE.test(v)) msg = "Номер в формате +7 900 000-00-00 или 8 900 000-00-00.";
      return setError(el, "f-contact-err", msg);
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
    form.elements.name.addEventListener("blur", validateName);
    form.elements.contact.addEventListener("blur", validateContact);
    form.elements.consent.addEventListener("change", validateConsent);
    ["name", "contact"].forEach(function (n) {
      form.elements[n].addEventListener("input", function () {
        if (form.elements[n].getAttribute("aria-invalid") === "true") (n === "name" ? validateName : validateContact)();
      });
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
        contact: normalizeContact(form.elements.contact.value).slice(0, 40),
        niche: form.elements.niche.value,
        services: $all('input[name="services"]:checked', form).map(function (c) { return c.value; }),
        comment: form.elements.comment.value.trim().slice(0, 1000),
        consent: true,
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
      "logo": site + "/favicon.svg",
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

  /* ---------- Cookie-баннер и Яндекс Метрика (только после согласия) ---------- */
  safe("cookie", function () {
    var KEY = "aweron_cookie_consent";
    var id = String(CFG.metrikaId || "").trim();
    var banner = $(".cookie");
    if (!/^\d+$/.test(id)) return; // Метрика не настроена — аналитических cookie нет, баннер не нужен

    function loadMetrika() {
      if (window.ym) return;
      window.ym = function () { (window.ym.a = window.ym.a || []).push(arguments); };
      window.ym.l = Date.now();
      var s = document.createElement("script");
      s.async = true;
      s.src = "https://mc.yandex.ru/metrika/tag.js";
      document.head.appendChild(s);
      window.ym(Number(id), "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
    }

    var choice = store.get("localStorage", KEY);
    if (choice === "all") { loadMetrika(); return; }
    if (choice === "necessary" || !banner) return;

    banner.hidden = false;
    $all("[data-cookie]", banner).forEach(function (b) {
      b.addEventListener("click", function () {
        var val = b.getAttribute("data-cookie");
        store.set("localStorage", KEY, val);
        banner.hidden = true;
        if (val === "all") loadMetrika();
      });
    });
  });
})();
