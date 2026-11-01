const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-video-capture=/home/claude/test/fake.y4m' ] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto('http://localhost:4173/');
  await page.fill('input', 'dh-0147');
  await page.click('button[type=submit]');
  await page.click('.tile.add');
  await page.click('text=Anterior');
  const t0 = Date.now();
  await page.waitForSelector('text=Loading vision engine…', { state: 'detached', timeout: 60000 });
  console.log('engine ready after', Date.now() - t0, 'ms');
  await page.screenshot({ path: 'shot_baseline_mode.png' });
  // stream started roughly at capture-screen entry; capture baseline during the aligned phase
  await page.waitForTimeout(Math.max(0, 1500 - (Date.now() - t0)));
  await page.click('.shutter');
  await page.waitForSelector('text=Baseline set', { timeout: 10000 });
  console.log('baseline captured at', Date.now() - t0, 'ms');
  const shots = [[4200,'shot_drift.png'],[6500,'shot_hold.png'],[9200,'shot_return.png'],[11500,'shot_aligned.png']];
  for (const [ms, name] of shots) {
    const wait = ms - (Date.now() - t0); if (wait > 0) await page.waitForTimeout(wait);
    await page.screenshot({ path: name });
  }
  // toggle diagnostics and capture a follow-up at aligned phase of the next loop (~13.5s)
  await page.waitForTimeout(Math.max(0, 13800 - (Date.now() - t0)));
  await page.click('.shutter');
  await page.waitForSelector('text=Saved', { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.click('.icon[aria-label=Close]');
  await page.waitForTimeout(1500);
  const data = await page.evaluate(async () => {
    const db = await new Promise((r, j) => { const q = indexedDB.open('dental-align'); q.onsuccess = () => r(q.result); q.onerror = j; });
    const get = (s) => new Promise((r) => { const t = db.transaction(s).objectStore(s).getAll(); t.onsuccess = () => r(t.result); });
    const logs = await get('logs'); const caps = await get('captures'); const views = await get('views');
    return { logs: logs.map(l => ({ rows: l.rows, events: l.events, info: l.info })), caps: caps.map(c => ({ role: c.role, w: c.width, h: c.height, size: c.master.size, meta: c.meta })), views };
  });
  require('fs').writeFileSync('data.json', JSON.stringify(data));
  console.log('captures', data.caps.map(c => [c.role, c.w, c.h, c.size]));
  console.log('errors', errs.slice(0, 10));
  await browser.close();
})();
