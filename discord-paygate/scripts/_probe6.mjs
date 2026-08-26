import fs from 'node:fs';
import { chromium } from 'playwright';
const root='/opt/pw-browsers';
const dirs=fs.readdirSync(root).filter(d=>d.startsWith('chromium-')).sort().reverse();
let exe=null;
for(const d of dirs){ for(const s of ['chrome-linux/chrome','chrome-linux64/chrome']){ const p=`${root}/${d}/${s}`; if(fs.existsSync(p)){exe=p;break;} } if(exe)break; }
const OUT='/tmp/claude-0/-home-user-payment/206a3f5f-7d28-5188-b783-aee6b1771346/scratchpad/crops';
const browser=await chromium.launch({executablePath:exe,args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text']});
const page=await (await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1})).newPage();
await page.goto('file:///home/user/payment/discord-paygate/hero/film.html?scene=film');
await page.waitForFunction(()=>window.__ready===true,{timeout:30000});
await page.evaluate(()=>{
  const s=document.createElement('style');
  s.textContent='#b-end .endfloat{left:1160px !important}#b-alert .float{left:1130px !important}';
  document.head.appendChild(s);
});
for(const [t,name,clip] of [[19.5,'endfix',{x:780,y:840,width:600,height:70}],[17.6,'alertfix',{x:690,y:720,width:600,height:70}],[18.30,'endfix2',{x:760,y:860,width:640,height:90}]]){
  await page.evaluate((t)=>window.__seek(t),t);
  await page.screenshot({path:`${OUT}/fix_${name}.png`, clip});
}
await browser.close();
