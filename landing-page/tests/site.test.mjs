// Home page interactions. Checks that apply to every page are in pages.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const css = await readFile(new URL("styles.css", root), "utf8");
const js = await readFile(new URL("app.js", root), "utf8");
const DEMO = "https://theclipfactory-frontend-two.vercel.app";

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

test("the main calls to action lead to the setup page, with no invented download or web rehearsal", () => {
  const ctas = [...html.matchAll(/<a\b[^>]*href="\/download.html"[^>]*>\s*Get started free/g)];
  assert.ok(ctas.length >= 3, `expected the hero, pricing and closing CTAs, found ${ctas.length}`);
  assert.doesNotMatch(html, /data-download|download-dialog|Download for Mac/);
  assert.doesNotMatch(html, new RegExp(DEMO.replace(/[.]/g, "\\.")));
});

test("the home page covers the sales sections in order", () => {
  const sections = ["how", "agents", "platforms", "privacy", "pricing", "faq", "get"];
  const order = sections.map((id) => html.indexOf(`<section id="${id}"`));
  for (const [i, at] of order.entries()) assert.ok(at > 0, `missing section #${sections[i]}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections out of order");
  const platforms = html.split('id="platforms"')[1].split("</section>")[0];
  for (const name of ["TikTok", "Instagram", "YouTube", "Facebook", "LinkedIn", "X", "Threads"]) assert.match(platforms, new RegExp(`<li>${name}</li>`));
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

test("the pricing toggle only appears once its script runs", async () => {
  const site = await readFile(new URL("site.css", root), "utf8");
  assert.match(site, /\.pricing:not\(\.is-interactive\) \.pricing-toggle \{ display: none; \}/);
  assert.match(js, /pricing\.classList\.add\("is-interactive"\)/);
  assert.match(js, /setAttribute\("aria-pressed"/);
});

test("motion respects reduced-motion preferences", () => {
  assert.match(css, /prefers-reduced-motion: reduce/);
});
