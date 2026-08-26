import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
const OUT='/tmp/sheet'; fs.rmSync(OUT,{recursive:true,force:true}); fs.mkdirSync(OUT,{recursive:true});
const root='/opt/pw-browsers'; const d=fs.readdirSync(root).filter(x=>x.startsWith('chromium-')).sort().reverse()[0];
const b = await chromium.launch({ executablePath:`${root}/${d}/chrome-linux/chrome`,
  args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text'] });
const p = await (await b.newContext({ viewport:{width:1920,height:1080}, deviceScaleFactor:0.5 })).newPage();
let failed=null; p.on('pageerror', e=>{failed=e.message;});
await p.goto(`file://${process.cwd()}/hero/scenes.html?scene=film`);
await p.waitForFunction(()=>window.__ready===true,{timeout:30000});
const step = Number(process.env.STEP||0.5), dur = await p.evaluate(()=>window.__duration);
let i=0;
for (let t=0; t<dur-1e-6; t+=step) {
  await p.evaluate((x)=>window.__seek(x), t);
  await p.screenshot({ path: path.join(OUT, `s${String(i).padStart(3,'0')}_${t.toFixed(2)}.png`) });
  i+=1;
}
await b.close();
console.log(failed?('PAGEERROR '+failed):`ok ${i} tiles`);
