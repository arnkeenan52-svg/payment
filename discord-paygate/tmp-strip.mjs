// Render a handful of exact times to /tmp/strip and report any page error.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const times = process.argv.slice(2).map(Number);
const OUT = process.env.STRIP_OUT || '/tmp/strip';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const root='/opt/pw-browsers';
const d=fs.readdirSync(root).filter(x=>x.startsWith('chromium-')).sort().reverse()[0];
const b = await chromium.launch({ executablePath:`${root}/${d}/chrome-linux/chrome`,
  args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text'] });
const p = await (await b.newContext({ viewport:{width:1920,height:1080}, deviceScaleFactor:1 })).newPage();
let failed=null; p.on('pageerror', e=>{ failed=e.message; });
await p.goto(`file://${process.cwd()}/hero/scenes.html?scene=film`);
await p.waitForFunction(()=>window.__ready===true,{timeout:30000});
if (failed) { console.log('PAGEERROR(load):', failed); process.exit(1); }
for (const t of times) {
  await p.evaluate((x)=>window.__seek(x), t);
  await p.screenshot({ path: path.join(OUT, `t${t.toFixed(2)}.png`) });
  if (failed) { console.log('PAGEERROR at', t, ':', failed); break; }
}
await b.close();
console.log(failed ? 'FAILED' : `ok — ${times.length} frames in ${OUT}`);
