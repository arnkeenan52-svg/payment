import fs from 'node:fs';
import { chromium } from 'playwright';
const root='/opt/pw-browsers';
const dirs=fs.readdirSync(root).filter(d=>d.startsWith('chromium-')).sort().reverse();
let exe=null;
for(const d of dirs){ for(const s of ['chrome-linux/chrome','chrome-linux64/chrome']){ const p=`${root}/${d}/${s}`; if(fs.existsSync(p)){exe=p;break;} } if(exe)break; }
const browser=await chromium.launch({executablePath:exe,args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text']});
const OUT='/tmp/claude-0/-home-user-payment/206a3f5f-7d28-5188-b783-aee6b1771346/scratchpad/crops';
for(const cut of ['light','dark']){
  const page=await (await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1})).newPage();
  await page.goto(`file:///home/user/payment/discord-paygate/hero/film.html?scene=film${cut==='dark'?'&cut=dark':''}`);
  await page.waitForFunction(()=>window.__ready===true,{timeout:30000});
  const C=cut[0].toUpperCase();
  for (const [t,name] of [[19.5,'end'],[17.6,'alert']]) {
    await page.evaluate((t)=>window.__seek(t), t);
    await page.screenshot({path:`${OUT}/nf_${C}_${name}_with.png`});
    await page.evaluate(()=>{ document.querySelectorAll('.float').forEach(e=>e.style.visibility='hidden'); });
    await page.screenshot({path:`${OUT}/nf_${C}_${name}_without.png`});
    await page.evaluate(()=>{ document.querySelectorAll('.float').forEach(e=>e.style.visibility=''); });
  }
  // measure ink extents of the .ed lines with float hidden
  const r=await page.evaluate(()=>{
    const out=[];
    for(const beat of ['#b-end','#b-alert']){
      document.querySelectorAll(beat+' .dc-embed .ed').forEach((e,i)=>{
        const rg=document.createRange(); rg.selectNodeContents(e);
        const b=rg.getBoundingClientRect();
        out.push({beat,i,txt:e.textContent.trim(),inkL:+b.left.toFixed(1),inkR:+b.right.toFixed(1),y:+((b.top+b.bottom)/2).toFixed(1)});
      });
    }
    const f=document.querySelector('#b-end .endfloat').getBoundingClientRect();
    const fa=document.querySelector('#b-alert .float').getBoundingClientRect();
    return {out,endfloat:[+f.left.toFixed(1),+f.top.toFixed(1),+f.right.toFixed(1),+f.bottom.toFixed(1)],alertfloat:[+fa.left.toFixed(1),+fa.top.toFixed(1),+fa.right.toFixed(1),+fa.bottom.toFixed(1)]};
  });
  console.log(cut, JSON.stringify(r));
  await page.close();
}
await browser.close();
