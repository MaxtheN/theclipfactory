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

test("every demo CTA keeps the existing destination and safe new-tab behaviour", () => {
  const links = [...html.matchAll(new RegExp(`<a\\b[^>]*href="${DEMO}"[^>]*>`, "g"))];
  assert.ok(links.length >= 4);
  for (const [tag] of links) {
    assert.ok(tag.includes('target="_blank"'));
    assert.ok(tag.includes('rel="noopener"'));
    assert.ok(!tag.includes("download"));
  }
});

test("the page does not offer a download for the unreleased Mac app", () => {
  assert.doesNotMatch(html, /Download for Mac/i);
  const hero = html.split('class="wrap hero-copy"')[1].split('class="hero-clips"')[0];
  assert.match(hero, /In development/);
  assert.match(hero, /sample data/);
  assert.match(html, /Sample data/);
});

test("the mobile menu keeps its accessible associations", () => {
  assert.match(html, /aria-controls="mobile-nav" aria-expanded="false"/);
  assert.match(html, /id="mobile-nav"[^>]*hidden/s);
});

test("motion respects reduced-motion preferences", () => {
  assert.match(css, /prefers-reduced-motion: reduce/);
});
