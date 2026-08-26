import fs from 'node:fs';
import { chromium } from 'playwright';
const root='/opt/pw-browsers';
const dirs=fs.readdirSync(root).filter(d=>d.startsWith('chromium-')).sort().reverse();
let exe=null;
for(const d of dirs){ for(const s of ['chrome-linux/chrome','chrome-linux64/chrome']){ const p=`${root}/${d}/${s}`; if(fs.existsSync(p)){exe=p;break;} } if(exe)break; }
const browser=await chromium.launch({executablePath:exe,args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text']});
const jobs=JSON.parse(process.argv[2]); // [{t, sels:[]}]
for(const cut of ['light','dark']){
  const page=await (await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1})).newPage();
  await page.goto(`file:///home/user/payment/discord-paygate/hero/film.html?scene=film${cut==='dark'?'&cut=dark':''}`);
  await page.waitForFunction(()=>window.__ready===true,{timeout:30000});
  for(const j of jobs){
    const r=await page.evaluate(({t,sels})=>{
      window.__seek(t);
      const o={};
      for(const s of sels){
        const els=[...document.querySelectorAll(s)];
        o[s]=els.map(e=>{const b=e.getBoundingClientRect();return {l:+b.left.toFixed(1),t:+b.top.toFixed(1),r:+b.right.toFixed(1),b:+b.bottom.toFixed(1),txt:(e.textContent||'').trim().slice(0,44), fs:getComputedStyle(e).fontSize, col:getComputedStyle(e).color};});
      }
      return o;
    },j);
    console.log(cut, 't='+j.t, JSON.stringify(r,null,1));
  }
  await page.close();
}
await browser.close();
