import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const css = await readFile(new URL("styles.css", root), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

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

test("preview tabs share a labeled panel and one keyboard entry point", () => {
  const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabs.length, 3);
  assert.equal(tabs.filter((tab) => tab.includes('aria-selected="true"')).length, 1);
  assert.equal(tabs.filter((tab) => tab.includes('tabindex="0"')).length, 1);
  for (const tab of tabs) assert.ok(tab.includes('aria-controls="preview-panel"'));
  const selected = tabs.find((tab) => tab.includes('aria-selected="true"'));
  const selectedId = selected.match(/id="([^"]+)"/)[1];
  assert.match(html, new RegExp(`role="tabpanel"\\s+aria-labelledby="${selectedId}"`));
  assert.match(html, /aria-orientation="horizontal"/);
});

test("every demo CTA retains the existing destination and safe new-tab behavior", () => {
  const links = [...html.matchAll(/<a\b[^>]*href="https:\/\/theclipfactory-frontend-two\.vercel\.app"[^>]*>/g)];
  assert.ok(links.length >= 5);
  for (const [tag] of links) {
    assert.ok(tag.includes('target="_blank"'));
    assert.ok(tag.includes('rel="noopener"'));
    assert.ok(!tag.includes("download"));
  }
});

test("the hero explains the product and distinguishes the demo from the native app", () => {
  const heroCopy = html.split('<div class="hero-copy">')[1].split('<div class="preview-wrap">')[0];
  assert.match(heroCopy, /Turn long-form video into short-form clips/);
  assert.match(heroCopy, /You approve the cut/);
  assert.match(heroCopy, /Interactive demo with sample data\. No video rendering\./);
  assert.match(heroCopy, /Mac app for Apple Silicon/);
  assert.match(heroCopy, /In development/);
  assert.match(html, /ILLUSTRATIVE PREVIEW/);
  assert.match(html, /CONCEPT ONLY/);
});

test("walkthrough and mobile menu controls retain accessible associations", () => {
  assert.match(html, /<dialog id="workflow-tour" aria-labelledby="tour-title">/);
  assert.match(html, /aria-label="Close walkthrough"/);
  assert.match(html, /aria-controls="mobile-nav"\s+aria-expanded="false"/);
  assert.match(html, /id="mobile-nav"[^>]*hidden/s);
});
