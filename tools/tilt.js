const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=/home/claude/test/fake.y4m'] });
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
  const p = await c.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript(() => {
    window.__g = { x: 0, y: 0, z: -9.81 };
    setInterval(() => {
      const e = new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: window.__g, acceleration: { x: 0, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 });
      window.dispatchEvent(e);
    }, 16);
  });
  await p.goto('http://localhost:4173/');
  await p.fill('input', 'TILT-1');
  await p.click('button[type=submit]');
  await p.click('.tile.add');
  await p.click('text=Upper Occlusal');
  await p.waitForTimeout(1500);
  await p.click('.shutter');
  await p.waitForSelector('text=Baseline set');
  await p.waitForTimeout(1500);
  const coachText = async () => ((await p.locator('.coach').count()) ? await p.locator('.coach').innerText() : '(none)');
  console.log('flat, aligned        ->', await coachText());
  const tilt = async (label, gx, gy, gz) => {
    await p.evaluate(([x, y, z]) => { window.__g = { x, y, z }; }, [gx, gy, gz]);
    await p.waitForTimeout(600);
    console.log(label.padEnd(20), '->', await coachText());
    await p.screenshot({ path: 'tilt_' + label.replace(/\W+/g, '_') + '.png' });
  };
  const s6 = 9.81 * Math.sin((6 * Math.PI) / 180), c6 = 9.81 * Math.cos((6 * Math.PI) / 180);
  await tilt('top edge raised 6', 0, -s6, -c6);
  await tilt('right edge raised 6', -s6, 0, -c6);
  await tilt('level again', 0, 0, -9.81);
  const caps = await p.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('dental-align'); q.onsuccess = () => r(q.result); });
    return await new Promise((r) => { const t = db.transaction('captures').objectStore('captures').getAll(); t.onsuccess = () => r(t.result.map((c) => c.meta.attitude)); });
  });
  console.log('stored attitude', JSON.stringify(caps));
  console.log('errors', errs);
  await b.close();
})();
