import path from 'node:path'; import fs from 'node:fs'; import { chromium } from 'playwright';
function cp(){try{const p=chromium.executablePath();if(p&&fs.existsSync(p))return p}catch{};const r=process.env.PLAYWRIGHT_BROWSERS_PATH||'/opt/pw-browsers';for(const d of fs.readdirSync(r).filter(x=>x.startsWith('chromium-')).sort().reverse()){const p=path.join(r,d,'chrome-linux','chrome');if(fs.existsSync(p))return p}throw new Error('x')}
const b=await chromium.launch({executablePath:cp(),args:['--hide-scrollbars','--autoplay-policy=no-user-gesture-required']});
const page=await(await b.newContext({viewport:{width:1440,height:900}})).newPage();
await page.goto('http://localhost:4000/',{waitUntil:'load'});
await page.waitForSelector('#hero-cut:not([hidden])',{timeout:15000});
// wait for metadata, then seek to a known point
await page.evaluate(()=>new Promise(r=>{
  const v=document.getElementById('hero-media');
  if(v.readyState>=1) return r();
  v.addEventListener('loadedmetadata',r,{once:true});
}));
await page.evaluate(()=>{ document.getElementById('hero-media').currentTime = 11.4; });
await page.waitForTimeout(500);
const before = await page.evaluate(()=>{const v=document.getElementById('hero-media');return {src:(v.currentSrc||v.src).split('/').pop(), t:+v.currentTime.toFixed(2), dur:+v.duration.toFixed(2)};});
console.log('before', JSON.stringify(before));
await page.click('#hero-cut');
await page.waitForFunction(()=>{const v=document.getElementById('hero-media');return (v.currentSrc||v.src).includes('hero-tour.mp4') && v.readyState>=1;},{timeout:15000});
await page.waitForTimeout(700);
const after = await page.evaluate(()=>{const v=document.getElementById('hero-media');return {src:(v.currentSrc||v.src).split('/').pop(), t:+v.currentTime.toFixed(2), dur:+v.duration.toFixed(2)};});
console.log('after ', JSON.stringify(after));
console.log('POSITION CARRIED:', Math.abs(after.t - 11.4) < 0.6 ? 'YES' : `NO (expected ~11.4, got ${after.t})`);
console.log('durations equal:', before.dur === after.dur ? `YES (${after.dur}s)` : `NO (${before.dur} vs ${after.dur})`);
await b.close();
