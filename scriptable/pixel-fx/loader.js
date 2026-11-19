// Курсы НБРБ — загрузчик. Скачивает свежую версию виджета и запускает её; без сети — сохранённую.
const SRC = 'https://gist.githubusercontent.com/USER/GIST_ID/raw/pixel-fx.js'; // ← ссылка на raw-файл Gist
const fm = FileManager.local();
const file = fm.joinPath(fm.documentsDirectory(), 'pixel-fx-main.js');
const age = fm.fileExists(file) ? Date.now() - fm.modificationDate(file).getTime() : Infinity;
let code = null;
if (!config.runsInWidget || age > 6 * 3600e3) { // виджет качает код не чаще раза в 6 часов
  try {
    const req = new Request(SRC); req.timeoutInterval = 10;
    const txt = await req.loadString();
    if (req.response.statusCode === 200 && txt.includes('PIXEL_FX_MAIN')) { fm.writeString(file, txt); code = txt; }
  } catch (e) { log(`Загрузчик: нет сети (${e})`); }
}
if (!code && fm.fileExists(file)) code = fm.readString(file);
if (!code) throw new Error('Нет интернета, а виджет ещё ни разу не скачан. Подключитесь к сети и запустите снова.');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await new AsyncFunction('args', 'config', code)(args, config);
