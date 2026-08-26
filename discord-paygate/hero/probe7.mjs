import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text'] });
const page = await (await browser.newContext({ viewport:{width:1920,height:1080}, deviceScaleFactor:1 })).newPage();
await page.goto('file:///home/user/payment/discord-paygate/hero/film.html?scene=film&cut=dark');
await page.waitForFunction(()=>window.__ready===true,{timeout:30000});
const rows=[];
for (let f=100; f<=210; f++) { const t=(f-1)/30;
  await page.evaluate((tt)=>window.__seek(tt), t);
  const r = await page.evaluate(()=>{
    const c=document.querySelector('#b-stripe .cone'), b=document.getElementById('b-stripe');
    return {co:+getComputedStyle(c).opacity, bo:+getComputedStyle(b).opacity};
  });
  if (r.co>0.001) rows.push([f,t.toFixed(3),r.co.toFixed(3),r.bo.toFixed(3)]);
}
console.log('frames where cone opacity > 0:', rows.length);
console.log(rows.map(r=>r.join(' ')).join(' | '));
await browser.close();
