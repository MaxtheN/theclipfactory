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

test("primary CTAs lead to an honest, actionable source setup", () => {
  const hero = html.split('class="hero-copy"')[1].split('<figure')[0];
  assert.match(hero, /href="#get"/);
  const setup = html.split('id="get"')[1].split("</section>")[0];
  assert.match(setup, /href="https:\/\/github.com\/MaxtheN\/theclipfactory#run-on-an-apple-silicon-mac"/);
  assert.match(setup, /Public download not yet available/);
  assert.doesNotMatch(html, /data-download|fake-btn/);
  assert.doesNotMatch(html, new RegExp(DEMO.replace(/[.]/g, "\\.")));
});

test("preview and privacy disclosures do not imply measured results or local-only processing", () => {
  assert.match(html, /AI-generated sample imagery/);
  assert.match(html, /Illustrative screens, not a live editing session/);
  assert.match(html, /Synthetic example · Not measured results/);
  assert.match(html, /Optional cloud roles send their inputs/);
  assert.doesNotMatch(html, /Your footage never leaves|>Local only</);
});

test("scripts are progressive enhancement and fonts have no third-party requests", () => {
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 9);
  assert.doesNotMatch(html, /role="tabpanel"[^>]* hidden/);
  assert.match(html, /<noscript>/);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(css, /bricolage-grotesque\.woff2/);
});

test("every image has an explicit alternative text decision", () => {
  for (const [image] of html.matchAll(/<img\b[^>]*>/g)) assert.match(image, /alt="[^"]*"/);
});

test("the mobile menu keeps its accessible associations", () => {
  assert.match(html, /aria-controls="mobile-nav" aria-expanded="false"/);
  assert.match(html, /id="mobile-nav"[^>]*hidden/s);
});

test("motion respects reduced-motion preferences", () => {
  assert.match(css, /prefers-reduced-motion: reduce/);
});
