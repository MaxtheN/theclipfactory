import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';

const root = new URL('../', import.meta.url);
const types = { '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const cache = new Map();
async function dataURI(path) {
  if (!cache.has(path)) {
    const mime = types[extname(path)];
    if (!mime || !path.startsWith('/assets/') || path.includes('..')) throw new Error(`Unsupported asset: ${path}`);
    cache.set(path, `data:${mime};base64,${(await readFile(new URL(path.slice(1), root))).toString('base64')}`);
  }
  return cache.get(path);
}
async function inlineAssets(source, regex) {
  for (const match of [...source.matchAll(regex)]) source = source.replaceAll(match[1], await dataURI(match[1]));
  return source;
}

let html = await readFile(new URL('index.html', root), 'utf8');
let css = await readFile(new URL('styles.css', root), 'utf8');
const js = await readFile(new URL('app.js', root), 'utf8');
css = await inlineAssets(css, /url\("(\/assets\/[^"#]+)"\)/g);
html = html.replace(/\s*<link rel="preload"[^>]+>/g, '')
  .replace('<link rel="stylesheet" href="/styles.css" />', () => `<style>${css}</style>`)
  .replace('    <script src="/app.js" defer></script>\n', '')
  .replace('</body>', () => `<script>${js.replaceAll('</script', '<\\/script')}</script>\n  </body>`);
html = await inlineAssets(html, /(?:src|href)="(\/assets\/[^"#]+)"/g);
if (/<(?:script|img)\b[^>]*src="(?!data:)|<link\b[^>]*rel="stylesheet"/.test(html)) throw new Error('External render dependency in export');
// Preserve the font's redistribution notice in the portable artifact as well.
const license = await readFile(new URL('assets/BricolageGrotesque-OFL.txt', root), 'utf8');
html = html.replace('</html>', `<!-- Bricolage Grotesque font license:\n${license.replaceAll('--', '—')}\n-->\n</html>`);
await mkdir(new URL('dist/', root), { recursive: true });
const output = new URL('dist/growth-factory-landing.html', root);
await writeFile(output, html);
console.log(`Exported ${output.pathname} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB). No external render dependencies.`);
