// Минимальный мок API Scriptable для проверки скрипта в браузере (Chrome) и Node.
// Это НЕ Scriptable: шрифты и метрики текста немного отличаются от iOS.
(function (G) {
  const isBrowser = typeof document !== 'undefined';
  G.PREVIEW_SCALE = G.PREVIEW_SCALE || 2;

  class Size { constructor(w, h) { this.width = w; this.height = h; } }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  class Rect { constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; } }
  class Color {
    constructor(hex, a = 1) {
      const h = hex.replace('#', '');
      this.hex = h; this.alpha = a;
      const n = parseInt(h, 16);
      this.css = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    static dynamic(l) { return l; }
  }
  class Font {
    constructor(css, size) { this.css = css; this.size = size; }
    static boldMonospacedSystemFont(s) { return new Font(`bold ${s}px "DejaVu Sans Mono", Menlo, monospace`, s); }
    static mediumMonospacedSystemFont(s) { return new Font(`500 ${s}px "DejaVu Sans Mono", Menlo, monospace`, s); }
    static systemFont(s) { return new Font(`${s}px sans-serif`, s); }
    static boldSystemFont(s) { return new Font(`bold ${s}px sans-serif`, s); }
    static semiboldSystemFont(s) { return new Font(`600 ${s}px sans-serif`, s); }
  }
  class DrawContext {
    constructor() { this.opaque = true; this.respectScreenScale = false; this.align = 'left'; this.ops = 0; }
    set size(s) {
      this._size = s;
      if (isBrowser) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = Math.round(s.width * G.PREVIEW_SCALE);
        this.canvas.height = Math.round(s.height * G.PREVIEW_SCALE);
        this.g = this.canvas.getContext('2d');
        this.g.scale(G.PREVIEW_SCALE, G.PREVIEW_SCALE);
        this.g.imageSmoothingEnabled = false;
      }
    }
    get size() { return this._size; }
    setFillColor(c) { this.fill = c; if (this.g) this.g.fillStyle = c.css; }
    fillRect(r) { this.ops++; if (this.g) this.g.fillRect(r.x, r.y, r.width, r.height); }
    setFont(f) { this.font = f; if (this.g) this.g.font = f.css; }
    setTextColor(c) { this.textColor = c; }
    setTextAlignedLeft() { this.align = 'left'; }
    setTextAlignedRight() { this.align = 'right'; }
    setTextAlignedCenter() { this.align = 'center'; }
    drawTextInRect(t, r) {
      if (!this.g) return;
      this.g.save();
      this.g.fillStyle = this.textColor.css; this.g.textBaseline = 'top';
      this.g.textAlign = this.align;
      const x = this.align === 'left' ? r.x : this.align === 'right' ? r.x + r.width : r.x + r.width / 2;
      this.g.fillText(t, x, r.y + this.font.size * 0.1);
      this.g.restore();
    }
    getImage() { return { canvas: this.canvas, ops: this.ops }; }
  }
  class WidgetText { constructor(t) { this.text = t; } centerAlignText() {} }
  class ListWidget {
    constructor() { this.items = []; }
    addText(t) { const w = new WidgetText(t); this.items.push(w); return w; }
    addSpacer() {} setPadding() {}
  }
  class LinearGradient {}
  const files = G.__MOCK_FILES__ = G.__MOCK_FILES__ || {};
  const FileManager = {
    local: () => ({
      documentsDirectory: () => '/docs',
      joinPath: (a, b) => `${a}/${b}`,
      fileExists: (p) => p in files || Object.keys(files).some((k) => k.startsWith(p + '/')) || p === '/docs/pixel-fx',
      createDirectory: () => {},
      readString: (p) => files[p],
      writeString: (p, s) => { files[p] = s; },
    }),
  };
  class Request {
    constructor(url) { this.url = url; this.response = null; }
    async loadJSON() {
      if (G.__MOCK_OFFLINE__) throw new Error('The Internet connection appears to be offline.');
      const res = G.__MOCK_API__(this.url);
      this.response = { statusCode: res.status };
      return res.body;
    }
  }
  const Timer = { schedule(ms, rep, cb) { const id = setTimeout(cb, ms); return { invalidate: () => clearTimeout(id) }; } };
  Object.assign(G, {
    Size, Point, Rect, Color, Font, DrawContext, ListWidget, LinearGradient, FileManager, Request, Timer,
    Device: { isUsingDarkAppearance: () => !!G.__MOCK_DARK__ },
    URLScheme: { forRunningScript: () => 'scriptable:///run/Pixel%20FX' },
    Script: { setWidget: (w) => { G.__WIDGET__ = w; }, complete: () => {} },
    log: (...a) => (G.__MOCK_LOG__ || []).push(a.join(' ')),
    args: { queryParameters: {}, widgetParameter: null },
    config: { runsInWidget: false },
  });

  // Тестовые курсы (выдуманные, но с реальными масштабами НБРБ).
  const BASE = { USD: [431, 1, 2.9876], EUR: [451, 1, 3.4412], RUB: [456, 100, 3.7120], UAH: [449, 100, 7.1200], CNY: [462, 10, 4.1950], KZT: [459, 1000, 5.7930], PLN: [452, 10, 8.1200] };
  G.__MOCK_TODAY__ = G.__MOCK_TODAY__ || null;
  const todayStr = () => G.__MOCK_TODAY__ || new Date().toISOString().slice(0, 10);
  const wiggle = (cur, i) => Math.round(BASE[cur][2] * (1 + 0.012 * Math.sin(i * 0.9 + cur.length) + 0.004 * Math.cos(i * 2.1)) * 10000) / 10000;
  G.__MOCK_API__ = (url) => {
    if (url.includes('/rates?periodicity=0')) {
      return { status: 200, body: Object.entries(BASE).map(([cur, [id, scale]]) => ({ Cur_ID: id, Date: `${todayStr()}T00:00:00`, Cur_Abbreviation: cur, Cur_Scale: scale, Cur_Name: cur, Cur_OfficialRate: wiggle(cur, 0) })) };
    }
    const m = url.match(/dynamics\/(\d+)\?startdate=([\d-]+)&enddate=([\d-]+)/);
    if (m) {
      const cur = Object.keys(BASE).find((c) => BASE[c][0] === Number(m[1]));
      const out = [];
      for (let d = new Date(m[2] + 'T00:00:00Z'), i = 0; d.toISOString().slice(0, 10) <= m[3]; d.setUTCDate(d.getUTCDate() + 1), i++) {
        const ds = d.toISOString().slice(0, 10);
        const back = Math.round((new Date(m[3] + 'T00:00:00Z') - d) / 864e5);
        out.push({ Cur_ID: Number(m[1]), Date: `${ds}T00:00:00`, Cur_OfficialRate: wiggle(cur, back) });
      }
      return { status: 200, body: out };
    }
    return { status: 404, body: { message: 'not found' } };
  };
})(typeof window !== 'undefined' ? window : globalThis);
