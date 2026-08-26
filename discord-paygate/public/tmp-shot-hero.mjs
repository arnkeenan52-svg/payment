import { chromium } from 'playwright';
import fs from 'node:fs';
const root='/opt/pw-browsers';
const d=fs.readdirSync(root).filter(x=>x.startsWith('chromium-')).sort().reverse()[0];
const b = await chromium.launch({ executablePath:`${root}/${d}/chrome-linux/chrome`, args:['--hide-scrollbars'] });
const p = await (await b.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2 })).newPage();
await p.goto('http://127.0.0.1:4399/index.html');
await p.waitForTimeout(1500);
await p.evaluate(() => { document.getElementById('hero-sound').hidden = false; });
const cs = await p.evaluate(() => {
  const s = getComputedStyle(document.getElementById('hero-sound'));
  const f = getComputedStyle(document.querySelector('.hero-shot.browser-frame'));
  const bb = document.getElementById('hero-sound').getBoundingClientRect();
  const fb = document.querySelector('.hero-shot.browser-frame').getBoundingClientRect();
  return { pos:s.position, w:s.width, h:s.height, disp:s.display, bg:s.backgroundColor,
           framePos:f.position, btn:[Math.round(bb.x),Math.round(bb.y),Math.round(bb.width),Math.round(bb.height)],
           frame:[Math.round(fb.x),Math.round(fb.y),Math.round(fb.width),Math.round(fb.height)] };
});
console.log(JSON.stringify(cs));
const el = await p.$('.hero-shot.browser-frame');
await el.screenshot({ path: '/tmp/hero-frame.png' });
await p.evaluate(() => document.getElementById('hero-sound').setAttribute('aria-pressed','true'));
await el.screenshot({ path: '/tmp/hero-frame-on.png' });
await b.close();
