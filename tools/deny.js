const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-video-capture=/home/claude/test/fake.y4m'] });
  const c = await b.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, permissions:['camera'] });
  const p = await c.newPage();
  // first two camera requests fail the way iOS did, then it works
  await p.addInitScript(() => { const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); let n = 0;
    navigator.mediaDevices.getUserMedia = (c) => (++n <= 2 ? Promise.reject(new DOMException('The request is not allowed by the user agent', 'NotAllowedError')) : real(c)); });
  await p.goto('http://localhost:4173/');
  await p.fill('.searchfield input','DENY-1'); await p.click('text=Add patient DENY-1'); await p.click('.tile-add'); await p.click('.sheet >> text=Anterior');
  await p.waitForSelector('.cam-error'); console.log('error shown:', (await p.locator('.cam-error p').innerText()).slice(0,60));
  await p.click('.btn-retry'); await p.waitForTimeout(2500);
  console.log('after retry: error', await p.locator('.cam-error').count(), '| size label', await p.locator('.cam-res').innerText().catch(()=>'none'));
  await b.close();
})();
