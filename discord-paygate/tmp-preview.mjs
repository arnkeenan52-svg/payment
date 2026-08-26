// Fast 960x540 30fps proof render — for junction measurement and eyeballing motion,
// never for shipping. FILM_DPR 0.5 on a 1920 layout is a real half-res raster.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
const F='/tmp/pv'; fs.rmSync(F,{recursive:true,force:true}); fs.mkdirSync(F,{recursive:true});
const root='/opt/pw-browsers'; const d=fs.readdirSync(root).filter(x=>x.startsWith('chromium-')).sort().reverse()[0];
const b = await chromium.launch({ executablePath:`${root}/${d}/chrome-linux/chrome`,
  args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text'] });
const p = await (await b.newContext({ viewport:{width:1920,height:1080}, deviceScaleFactor:0.5 })).newPage();
let failed=null; p.on('pageerror', e=>{failed=e.message;});
await p.goto(`file://${process.cwd()}/hero/scenes.html?scene=film`);
await p.waitForFunction(()=>window.__ready===true,{timeout:30000});
const dur = await p.evaluate(()=>window.__duration); const total=Math.round(dur*30);
for (let i=0;i<total;i++){ await p.evaluate((x)=>window.__seek(x), i/30);
  await p.screenshot({ path: path.join(F,`f${String(i).padStart(4,'0')}.png`) }); }
await b.close();
if (failed) { console.log('PAGEERROR', failed); process.exit(1); }
execFileSync('ffmpeg',['-v','error','-framerate','30','-i',path.join(F,'f%04d.png'),
  '-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-an','-y','/tmp/preview.mp4'],
  {stdio:['ignore','inherit','inherit']});
console.log(`ok ${total} frames -> /tmp/preview.mp4`);
