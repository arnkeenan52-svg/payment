import fs from 'node:fs';
import { chromium } from 'playwright';
const root='/opt/pw-browsers';
const dirs=fs.readdirSync(root).filter(d=>d.startsWith('chromium-')).sort().reverse();
let exe=null;
for(const d of dirs){ for(const s of ['chrome-linux/chrome','chrome-linux64/chrome']){ const p=`${root}/${d}/${s}`; if(fs.existsSync(p)){exe=p;break;} } if(exe)break; }
const TIMES=JSON.parse(process.argv[2]);
const browser=await chromium.launch({executablePath:exe,args:['--force-color-profile=srgb','--hide-scrollbars','--disable-lcd-text']});
const out={};
for(const cut of ['light','dark']){
  const page=await (await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1})).newPage();
  await page.goto(`file:///home/user/payment/discord-paygate/hero/film.html?scene=film${cut==='dark'?'&cut=dark':''}`);
  await page.waitForFunction(()=>window.__ready===true,{timeout:30000});
  out[cut]={};
  for(const t of TIMES){
    out[cut][t]=await page.evaluate((t)=>{
      window.__seek(t);
      const parse=(s)=>{const m=s.match(/[\d.]+/g);if(!m)return null;return [ +m[0],+m[1],+m[2], m[3]===undefined?1:+m[3] ];};
      const lin=(c)=>{c/=255;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4);};
      const lum=(c)=>0.2126*lin(c[0])+0.7152*lin(c[1])+0.0722*lin(c[2]);
      const over=(fg,bg)=>{const a=fg[3];return [fg[0]*a+bg[0]*(1-a),fg[1]*a+bg[1]*(1-a),fg[2]*a+bg[2]*(1-a),1];};
      const res=[];
      const seen=new Set();
      const walk=(el)=>{
        for(const n of el.childNodes){
          if(n.nodeType===3 && n.textContent.trim()){
            const p=n.parentElement;
            if(seen.has(p)) continue; seen.add(p);
            const cs=getComputedStyle(p);
            const r=p.getBoundingClientRect();
            if(r.width<1||r.height<1) continue;
            // effective opacity along the chain
            let op=1, node=p, chain=[];
            let bg=[255,255,255,1];
            // walk up collecting backgrounds
            let stack=[];
            for(let a=p;a && a!==document.documentElement;a=a.parentElement){
              const acs=getComputedStyle(a);
              op*=parseFloat(acs.opacity);
              stack.push(parse(acs.backgroundColor)||[0,0,0,0]);
              chain.push(a.id||a.className||a.tagName);
            }
            // composite from bottom (document) up
            let acc=[255,255,255,1];
            for(let i=stack.length-1;i>=0;i--) acc=over(stack[i],acc);
            const col=parse(cs.color);
            res.push({sel:chain.slice(0,3).join('<'), txt:n.textContent.trim().slice(0,48),
              color:col.slice(0,3).map(Math.round), bgpaint:acc.slice(0,3).map(v=>Math.round(v)),
              fs:parseFloat(cs.fontSize), fw:cs.fontWeight, op:+op.toFixed(3),
              rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]});
          } else if(n.nodeType===1) walk(n);
        }
      };
      walk(document.body);
      return res;
    },t);
  }
  await page.close();
}
await browser.close();
fs.writeFileSync('/tmp/claude-0/-home-user-payment/206a3f5f-7d28-5188-b783-aee6b1771346/scratchpad/probe.json', JSON.stringify(out));
console.log('ok');
