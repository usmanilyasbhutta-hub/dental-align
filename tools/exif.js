const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-video-capture=/home/claude/test/fake.y4m'] });
  const c = await b.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, permissions:['camera'] });
  const p = await c.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto('http://localhost:4173/');
  const run = async (pid, file, shot) => {
    await p.fill('.searchfield input', pid); await p.click(`text=Add patient ${pid}`);
    await p.click('.tile-add'); await p.click('.sheet >> text=Upper Occlusal');
    await p.waitForSelector('.cam-import'); await p.waitForTimeout(1200);
    await p.setInputFiles('.capture input[type=file]', file);
    await p.waitForSelector('.cam-toast'); const toast = await p.locator('.cam-toast').innerText();
    await p.waitForTimeout(1500);
    console.log(pid, '| toast:', toast, '| zoom button:', await p.locator('.cam-zoom').innerText(), '| panel open:', await p.locator('.zoom-panel').count());
    if (!(await p.locator('.zoom-panel').count())) await p.click('.cam-zoom');
    await p.waitForTimeout(2200); await p.screenshot({ path: shot });
    const meta = await p.evaluate(async (pid) => { const db = await new Promise(r => { const q = indexedDB.open('dental-align'); q.onsuccess = () => r(q.result); }); return await new Promise(r => { const t = db.transaction('captures').objectStore('captures').getAll(); t.onsuccess = () => r(t.result.filter(c => c.patientId===pid).map(c => ({ zoom:c.meta.zoom, src:c.meta.zoomSource, exif:c.meta.exif, created:new Date(c.createdAt).toISOString() }))); }); }, pid);
    console.log(JSON.stringify(meta));
    await p.click('[aria-label="Close camera"]'); await p.click('.nav-left button'); await p.waitForTimeout(300);
  };
  await run('EXIF-1', '/home/claude/test/import_exif.jpg', 'x1.png');
  await run('PLAIN-1', '/home/claude/test/import_3x4.jpg', 'x2.png');
  console.log('errors', errs); await b.close();
})();
