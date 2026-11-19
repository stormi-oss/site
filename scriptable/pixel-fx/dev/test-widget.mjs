// Прогон main() в режиме виджета для всех размеров — так, как его запускает загрузчик.
import { readFileSync } from 'node:fs';
const here = new URL('.', import.meta.url);
globalThis.__MOCK_LOG__ = [];
new Function(readFileSync(new URL('scriptable-mock.js', here), 'utf8'))();
const code = readFileSync(new URL('../pixel-fx.js', here), 'utf8');
const AF = Object.getPrototypeOf(async function () {}).constructor;
for (const [fam, param] of [['small', ''], ['medium', 'BYN:RUB,USD:100'], ['large', 'RUB:BYN::med'], ['extraLarge', 'USD:EUR:1:field'], ['small', 'BYN:USD:1:med'], ['medium', 'BYN:RUB,USD:100:med'],
  ['accessoryRectangular', ''], ['accessoryInline', 'KZT:BYN:1000'], ['accessoryCircular', ''], ['medium', 'ABC:XYZ']]) {
  globalThis.__WIDGET__ = null;
  const config = { runsInWidget: true, widgetFamily: fam };
  const args = { widgetParameter: param, queryParameters: {} };
  await new AF('args', 'config', code)(args, config);
  const w = globalThis.__WIDGET__;
  const texts = (w.items || []).map((i) => i.text).join(' | ');
  console.log(fam.padEnd(21), (param || '-').padEnd(16), w.backgroundImage ? `image ops=${w.backgroundImage.ops}` : texts, '| url:', w.url ? decodeURIComponent(w.url) : '—');
}
