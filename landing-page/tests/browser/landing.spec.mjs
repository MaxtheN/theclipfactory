import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const repository = 'https://github.com/MaxtheN/theclipfactory';

async function settled(page) {
  const response = await page.goto('/');
  expect(response.status(), 'The local preview must be reachable before testing the page').toBe(200);
  await page.evaluate(() => document.fonts.ready);
}

async function accessible(page, selector) {
  let scan = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  if (selector) scan = scan.include(selector);
  const { violations } = await scan.analyze();
  expect(violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }))).toEqual([]);
}

for (const width of [320, 390, 480, 768, 900, 1024, 1440, 1920]) {
  test(`layout fits ${width}px without hidden text or colliding hero artwork`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await settled(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const layout = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const title = rect('.hero-copy');
      const stage = rect('.hero-stage');
      const caption = rect('.hero-caption');
      const clips = [...document.querySelectorAll('.hero-clip .clip')].map(e => e.getBoundingClientRect());
      return {
        columnsSeparate: title.right <= stage.left + 1 || title.bottom <= stage.top + 1,
        captionBelow: clips.every(r => r.bottom + 4 <= caption.top),
        clippedText: [...document.querySelectorAll('h1,h2,h3,p,button,summary')]
          .filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1)
          .map(e => e.textContent.trim()),
      };
    });
    expect(layout).toEqual({ columnsSeparate: true, captionBelow: true, clippedText: [] });
    for (const name of ['Review', 'Results']) {
      await page.getByRole('tab', { name, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

test('loads all local assets without application errors or third-party requests', async ({ page }) => {
  const errors = [], failed = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => failed.push(request.url()));
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4175') && !request.url().startsWith('data:')) external.push(request.url()); });
  await settled(page);
  const brokenImages = await page.evaluate(async () => {
    const images = [...document.images];
    await Promise.all(images.map(async image => { image.loading = 'eager'; try { await image.decode(); } catch { /* reported below */ } }));
    return images.filter(image => !image.naturalWidth).map(image => image.src);
  });
  expect({ errors, failed, external, brokenImages }).toEqual({ errors: [], failed: [], external: [], brokenImages: [] });
  expect(await page.evaluate(() => document.fonts.check('800 80px "Bricolage Grotesque"'))).toBe(true);
});

for (const group of ['Agents', 'App screens']) {
  test(`${group} tabs support keyboard selection, wrapping, and panel focus`, async ({ page }) => {
    await settled(page);
    const tabs = page.getByRole('tablist', { name: group }).getByRole('tab');
    const count = await tabs.count();
    await tabs.first().focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.last()).toBeFocused();
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(tabs.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tabs.first()).toBeFocused();
    for (let i = 0; i < count; i++) {
      await tabs.nth(i).click();
      const id = await tabs.nth(i).getAttribute('aria-controls');
      await expect(page.locator(`#${id}`)).toBeVisible();
      expect(await tabs.evaluateAll(elements => elements.filter(e => e.getAttribute('aria-selected') === 'true').length)).toBe(1);
      expect(await tabs.evaluateAll(elements => elements.filter(e => e.tabIndex === 0).length)).toBe(1);
    }
    await tabs.first().focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await expect(page.locator(`#${await tabs.first().getAttribute('aria-controls')}`)).toBeFocused();
  });
}

test('review button changes screens without a dead end or hidden focus', async ({ page }) => {
  await settled(page);
  await page.getByRole('button', { name: 'Review sample clips' }).click();
  await expect(page.getByRole('tab', { name: 'Review', exact: true })).toBeFocused();
  await expect(page.locator('#app-panel-review')).toBeVisible();
  await expect(page.locator('#app-panel-factory')).toBeHidden();
});

test('mobile menu closes accessibly on Escape, navigation, outside click, and desktop resize', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settled(page);
  const menu = page.locator('.menu-btn'), nav = page.locator('#mobile-nav');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await nav.getByRole('link', { name: 'The app' }).click();
  await expect(nav).toBeHidden();
  await expect(page.locator('#app')).toBeFocused();
  await expect(page).toHaveURL(/#app$/);
  await menu.click();
  await page.locator('#app-title').click();
  await expect(nav).toBeHidden();
  await menu.click();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav).toBeHidden();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});

test('primary CTA reaches a working setup link and all FAQs are keyboard accessible', async ({ page }) => {
  await settled(page);
  await page.locator('.hero-actions').getByRole('link', { name: 'Get started on Mac' }).click();
  await expect(page).toHaveURL(/#get$/);
  const setup = page.getByRole('link', { name: 'Set up on Mac', exact: true });
  await expect(setup).toHaveAttribute('href', `${repository}#run-on-an-apple-silicon-mac`);
  // Verify the outbound action without coupling tests to GitHub uptime.
  await page.route(`${repository}**`, route => route.fulfill({ body: '<h1>Source setup guide</h1>', contentType: 'text/html' }));
  await setup.click();
  await expect(page).toHaveURL(`${repository}#run-on-an-apple-silicon-mac`);
  await page.goBack();
  for (const detail of await page.locator('details').all()) {
    await detail.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(detail).toHaveAttribute('open', '');
    await expect(detail.locator('p')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(detail).not.toHaveAttribute('open', '');
  }
});

test('motion control persists and follows live operating-system preferences', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settled(page);
  const control = page.locator('.nav-desktop .motion-toggle');
  await control.click();
  await expect(control).toHaveText('Resume motion');
  await expect(control).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.hero-clip .float').first()).toHaveCSS('animation-name', 'none');
  await page.reload();
  await expect(control).toHaveText('Resume motion');
  await control.click();
  await expect(control).toHaveText('Pause motion');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(control).toHaveText('Motion reduced');
  await expect(control).toBeDisabled();
  expect(await page.evaluate(() => [...document.querySelectorAll('*')].every(e => getComputedStyle(e).animationName === 'none'))).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(control).toHaveText('Pause motion');
  await expect(control).toBeEnabled();
});

test('denied localStorage does not break tabs or motion controls', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied', 'SecurityError'); } }));
  await settled(page);
  await page.locator('.nav-desktop .motion-toggle').click();
  await expect(page.locator('.nav-desktop .motion-toggle')).toHaveText('Resume motion');
  await page.getByRole('tab', { name: 'Writer Hooks' }).click();
  await expect(page.locator('#agent-panel-3')).toBeVisible();
});

test('all content, FAQs, and setup remain useful without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4175');
    for (const panel of await page.locator('[role="tabpanel"]').all()) await expect(panel).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Set up on Mac', exact: true })).toHaveAttribute('href', `${repository}#run-on-an-apple-silicon-mac`);
    await page.getByText('Can I download the Mac app today?', { exact: true }).click();
    await expect(page.locator('details').first()).toHaveAttribute('open', '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test('skip link bypasses navigation and stays visible above the sticky header', async ({ page }) => {
  await settled(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
});

test('WCAG scans cover desktop, mobile, and every preview panel', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settled(page);
  await accessible(page);
  for (const group of ['Agents', 'App screens']) {
    for (const tab of await page.getByRole('tablist', { name: group }).getByRole('tab').all()) {
      await tab.click();
      await accessible(page, group === 'Agents' ? '#agents' : '#app');
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.menu-btn').click();
  await accessible(page);
});


test('increased text spacing does not clip headings or controls on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await settled(page);
  await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('h1,h2,h3,p,button,summary').evaluateAll(elements => elements
    .filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1)
    .map(e => e.textContent.trim()))).toEqual([]);
});
