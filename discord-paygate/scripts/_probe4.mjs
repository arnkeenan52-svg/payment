import fs from 'node:fs';
import { chromium } from 'playwright';
const root='/opt/pw-browsers';
const dirs=fs.readdirSync(root).filter(d=>d.startsWith('chromium-')).sort().reverse();
let exe=null;
for(const d of dirs){ for(const s of ['chrome-linux/chrome','chrome-linux64/chrome']){ const p=`${root}/${d}/${s}`; if(fs.existsSync(p)){exe=p;break;} } if(exe)break; }
const browser=await chromium.launch({executablePath:exe,args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text']});
for(const cut of ['light','dark']){
  const page=await (await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1})).newPage();
  await page.goto(`file:///home/user/payment/discord-paygate/hero/film.html?scene=film${cut==='dark'?'&cut=dark':''}`);
  await page.waitForFunction(()=>window.__ready===true,{timeout:30000});
  for(const t of [9.72,9.80,9.88,10.00,10.46,10.54,10.62]){
    const r=await page.evaluate((t)=>{
      window.__seek(t);
      const ink=(el)=>{const rg=document.createRange();rg.selectNodeContents(el);const b=rg.getBoundingClientRect();return [+b.left.toFixed(1),+b.top.toFixed(1),+b.right.toFixed(1),+b.bottom.toFixed(1)];};
      const c=document.getElementById('cursor').getBoundingClientRect();
      const o={cursor:[+c.left.toFixed(1),+c.top.toFixed(1),+c.right.toFixed(1),+c.bottom.toFixed(1)], op:getComputedStyle(document.getElementById('cursor')).opacity};
      document.querySelectorAll('#b-theme .th em').forEach(e=>{ o[e.textContent]=ink(e); });
      return o;
    },t);
    console.log(cut,'t='+t,JSON.stringify(r));
  }
  await page.close();
}
await browser.close();
