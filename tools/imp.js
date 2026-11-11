const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-video-capture=/home/claude/test/fake.y4m','--autoplay-policy=no-user-gesture-required'] });
  const c = await b.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true, permissions:['camera'] });
  const p = await c.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); });
  await p.goto('http://localhost:4173/');
  await p.fill('.searchfield input','IMP-1'); await p.click('text=Add patient IMP-1');
  await p.click('.tile-add'); await p.click('.sheet >> text=Upper Occlusal');
  await p.waitForSelector('.cam-import'); await p.waitForTimeout(1500);
  const z0 = await p.locator('.cam-zoom').innerText();
  await p.screenshot({ path:'i1_baseline_mode.png' });
  await p.click('.cam-zoom'); await p.waitForTimeout(400); await p.click('.cam-zoom'); await p.waitForTimeout(800);
  console.log('zoom', z0, '->', await p.locator('.cam-zoom').innerText());
  await p.setInputFiles('.capture input[type=file]', '/home/claude/test/import_3x4.jpg');
  await p.waitForSelector('text=Baseline set'); 
  // long-press for diagnostics
  const box = await p.locator('.cam-title').boundingBox(); await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down(); await p.waitForTimeout(1100); await p.mouse.up();
  await p.waitForTimeout(2500);
  console.log('coach:', await p.locator('.coach').innerText().catch(()=>'(none)'));
  console.log((await p.locator('.devhud').innerText()).split('\n').slice(2,6).join(' | '));
  await p.screenshot({ path:'i2_imported.png' });
  await p.click('[aria-label="Ghost style"]'); await p.waitForTimeout(1600); await p.screenshot({ path:'i3_outline.png' });
  await p.click('.shutter'); await p.waitForSelector('text=Follow-up saved');
  const meta = await p.evaluate(async () => { const db = await new Promise(r => { const q = indexedDB.open('dental-align'); q.onsuccess = () => r(q.result); }); return await new Promise(r => { const t = db.transaction('captures').objectStore('captures').getAll(); t.onsuccess = () => r(t.result.map(c => ({ role:c.role, w:c.width, h:c.height, imported:!!c.meta.imported, zoom:c.meta.zoom, size:c.master.size }))); }); });
  console.log(JSON.stringify(meta));
  console.log('errors', errs); await b.close();
})();
