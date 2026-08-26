import fs from 'node:fs';
import { chromium } from 'playwright';
const root='/opt/pw-browsers';
const dirs=fs.readdirSync(root).filter(d=>d.startsWith('chromium-')).sort().reverse();
let exe=null;
for(const d of dirs){ for(const s of ['chrome-linux/chrome','chrome-linux64/chrome']){ const p=`${root}/${d}/${s}`; if(fs.existsSync(p)){exe=p;break;} } if(exe)break; }
const browser=await chromium.launch({executablePath:exe,args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text']});
const page=await (await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1})).newPage();
await page.goto('file:///home/user/payment/discord-paygate/hero/film.html?scene=film');
await page.waitForFunction(()=>window.__ready===true,{timeout:30000});
const res=await page.evaluate(()=>{
  const out=[];
  // helper: left edge x of a rotated card at a given y, from its 4 corners via elementFromPoint scan
  const edgeAt=(el,y)=>{
    const r=el.getBoundingClientRect();
    for(let x=Math.floor(r.left);x<Math.ceil(r.right);x++){
      const e=document.elementFromPoint(x,y);
      if(e && (e===el || el.contains(e))) return x;
    }
    return null;
  };
  const inkRight=(el)=>{const rg=document.createRange();rg.selectNodeContents(el);const b=rg.getBoundingClientRect();return {r:b.right,y:(b.top+b.bottom)/2};};
  for(const [beat,floSel,prop,cands] of [
      ['#b-end','#b-end .endfloat','left',[1084,1110,1136,1160,1170,1190]],
      ['#b-alert','#b-alert .float','left',[1090,1104,1116,1130,1140]]]){
    document.getElementById('cursor').style.display='none';document.getElementById('ring').style.display='none';const flo=document.querySelector(floSel);
    const orig=flo.style[prop]||'';
    for(const c of cands){
      flo.style[prop]=c+'px';
      const times = beat==='#b-end'?[18.20,18.60,19.50,19.97]:[17.05,17.40,17.60,18.10];
      const rows=[];
      for(const t of times){
        window.__seek(t);
        const eds=[...document.querySelectorAll(beat+' .dc-embed .ed')];
        let worst=null;
        for(const ed of eds){
          const {r,y}=inkRight(ed);
          if(y<0||y>1080) continue;
          const ex=edgeAt(flo,Math.round(y));
          if(ex===null) continue;
          const ov=r-ex;
          if(worst===null||ov>worst.ov) worst={ov:+ov.toFixed(1),y:Math.round(y),txt:ed.textContent.trim().slice(-18)};
        }
        const fr=flo.getBoundingClientRect();
        rows.push({t,ov:worst?worst.ov:null,txt:worst?worst.txt:null,cardR:+fr.right.toFixed(0),cardB:+fr.bottom.toFixed(0)});
      }
      out.push({beat,prop,c,rows});
    }
    flo.style[prop]=orig;
  }
  return out;
});
for(const o of res) console.log(o.beat, o.prop+':'+o.c, JSON.stringify(o.rows));
await browser.close();
