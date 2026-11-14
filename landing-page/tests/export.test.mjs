import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
test('portable preview embeds every render dependency and the font license', async () => {
  execFileSync(process.execPath, [new URL('scripts/export-preview.mjs', root).pathname]);
  const html = await readFile(new URL('dist/growth-factory-landing.html', root), 'utf8');
  for (const [, source] of html.matchAll(/<(?:img|script)\b[^>]*src="([^"]*)"/g)) assert.ok(source.startsWith('data:'), source);
  assert.doesNotMatch(html, /(?:src|href)="\/(?:assets|styles|app)|url\("\/(?:assets)/);
  assert.doesNotMatch(html, /<link[^>]*rel="(?:stylesheet|preload)"/);
  assert.match(html, /SIL OPEN FONT LICENSE/);
  assert.match(html, /<script>document.documentElement/);
});
