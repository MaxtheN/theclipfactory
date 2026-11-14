import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const css = await readFile(new URL("styles.css", root), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const DEMO = "https://theclipfactory-frontend-two.vercel.app";

test("all referenced local assets exist", async () => {
  const paths = new Set([
    ...[...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]),
    ...[...css.matchAll(/url\("(\/[^"#]+)"\)/g)].map((m) => m[1]),
  ]);
  assert.ok(paths.size > 5);
  for (const path of paths) await access(new URL(path.slice(1), root));
});

test("in-page links and SVG references resolve to unique IDs", () => {
  assert.equal(ids.length, new Set(ids).size, "Duplicate HTML IDs");
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(ids.includes(id), `Missing anchor or symbol: ${id}`);
  }
});

function tabsIn(listLabel) {
  const list = html.split(`aria-label="${listLabel}"`)[1].split("</div>")[0];
  return [...list.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
}

for (const [label, count] of [
  ["Agents", 6],
  ["App screens", 3],
]) {
  test(`${label} tabs each control a labelled panel with one keyboard entry point`, () => {
    const tabs = tabsIn(label);
    assert.equal(tabs.length, count);
    assert.equal(tabs.filter((tab) => tab.includes('aria-selected="true"')).length, 1);
    assert.equal(tabs.filter((tab) => tab.includes('tabindex="0"')).length, 1);
    for (const tab of tabs) {
      const id = tab.match(/id="([^"]+)"/)[1];
      const panel = tab.match(/aria-controls="([^"]+)"/)[1];
      assert.match(html, new RegExp(`role="tabpanel" id="${panel}" aria-labelledby="${id}"`));
    }
  });
}

test("download CTAs lead to honest Mac availability instead of an invented release", () => {
  const buttons = [...html.matchAll(/<a\b[^>]*href="\/download.html"[^>]*>\s*Download for Mac/g)];
  assert.equal(buttons.length, 4);
  assert.doesNotMatch(html, /data-download|download-dialog/);
  assert.doesNotMatch(html, new RegExp(DEMO.replace(/[.]/g, "\\.")));
});

test("the rotating clip ring behind the closing section is decorative", () => {
  const cta = html.split('id="get"')[1].split("</section>")[0];
  assert.match(cta, /class="cta-orbit" aria-hidden="true"/);
  assert.equal((cta.match(/class="ring-card/g) || []).length, 12);
});

test("the mobile menu keeps its accessible associations", () => {
  assert.match(html, /aria-controls="mobile-nav" aria-expanded="false"/);
  assert.match(html, /id="mobile-nav"[^>]*hidden/s);
});

test("motion respects reduced-motion preferences", () => {
  assert.match(css, /prefers-reduced-motion: reduce/);
});

const productPages = ["index.html", "product.html", "learning.html", "download.html"];
const pageSources = new Map(await Promise.all(productPages.map(async name => [name, await readFile(new URL(name, root), "utf8")])));

test("all product pages have a unique title, one H1 and accessible navigation", () => {
  const titles = new Set();
  for (const [name, source] of pageSources) {
    const title = source.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.ok(title, `${name}: missing title`);
    assert.ok(!titles.has(title), `${name}: duplicate title`);
    titles.add(title);
    assert.equal((source.match(/<h1\b/g) || []).length, 1, `${name}: one main heading`);
    assert.match(source, /aria-controls="mobile-nav"/);
    assert.match(source, /aria-expanded="false"/);
    assert.match(source, /id="mobile-nav"[^>]*hidden/s);
    assert.match(source, /href="\/product.html"/);
    assert.match(source, /href="\/learning.html"/);
    assert.match(source, /href="\/download.html"/);
  }
});

test("all page routes, local assets and cross-page anchors resolve", async () => {
  for (const [name, source] of pageSources) {
    const pageIds = [...source.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(pageIds.length, new Set(pageIds).size, `${name}: duplicate ID`);
    for (const [, href] of source.matchAll(/(?:src|href)="([^"\s]+)"/g)) {
      if (/^(?:https?:|data:|mailto:)/.test(href)) continue;
      const [path, hash] = href.split("#");
      const target = path ? (path === "/" ? "index.html" : path.replace(/^\//, "")) : name;
      if (target) await access(new URL(target, root));
      if (hash) {
        const targetSource = pageSources.get(target);
        assert.ok(targetSource?.includes(`id="${hash}"`), `${name}: unresolved ${href}`);
      }
    }
  }
});

test("Mac availability is honest and no standalone web rehearsal or invented installer is promoted", () => {
  const download = pageSources.get("download.html");
  assert.match(download, /Apple Silicon/);
  assert.match(download, /notariz/i);
  assert.match(download, /github.com\/MaxtheN\/theclipfactory/);
  // The only installer link allowed is the published GitHub release asset of this repository.
  const RELEASE = "https://github.com/MaxtheN/theclipfactory/releases/latest/download/growth-factory-mac-arm64.zip";
  assert.ok(download.includes(`href="${RELEASE}"`), "download.html links the published Mac release");
  for (const [name, source] of pageSources) {
    const cleaned = source.split(`href="${RELEASE}"`).join("");
    assert.doesNotMatch(cleaned, /href="[^"]*(?:releases\/download|\.dmg|\.zip|demo-loop|rehearsal)[^"]*"/, `${name}: unverified artifact/demo link`);
  }
});
