// ── The Dues sky ────────────────────────────────────────────────────────────
// A procedural WebGL cloudscape for the landing hero: billowed value-noise
// clouds with a soft hand-painted (cel-banded) light, drifting as a slow
// horizontal scroll; a twinkling star field behind the clouds at night.
// Built on the classic public-domain 2D cloud recipe (value-noise fbm with a
// ridged accumulation and the billow×ridge contrast product), tuned to the
// painterly day/night palettes of this site.
//
// Mounting: any <canvas data-dues-sky> is driven. Theme comes from
// html[data-theme] ('light' = day, absent = night) and transitions through a
// dusk waypoint when it flips. If WebGL is unavailable, or the visitor
// prefers reduced motion, the canvas is left untouched — the CSS fallback
// behind it (static sky image / gradient) simply shows.
(() => {
  'use strict';
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const VERT = 'attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}';

  const FRAG = `
precision highp float;
varying vec2 uv;
uniform float T;         // seconds
uniform vec2  R;         // internal resolution
uniform float COV;       // coverage: lower = more open sky
uniform float SOFT;      // mask feather
uniform float DRIFT;     // scroll speed
uniform vec3  TOP;       // sky top colour
uniform vec3  HOR;       // sky horizon colour
uniform vec3  CLD;       // cloud body colour
uniform vec3  SHD;       // cloud shadow colour
uniform float STARS;     // 1 at night

float hash(vec2 v){
  v = fract(v * vec2(233.34, 851.73));
  v += dot(v, v + 23.45);
  return fract(v.x * v.y);
}
// Dave Hoskins' hash12 (public domain) — artifact-free star scatter
float hashS(vec2 v){
  vec3 p3 = fract(vec3(v.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 v){
  vec2 i = floor(v), f = fract(v);
  vec2 u = f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float snoise(vec2 v){ return noise(v)*2.-1.; }
float fbm(vec2 v){
  float s=0., a=.5, n=0.;
  mat2 rot = mat2(.766,-.643,.643,.766);
  for(int i=0;i<6;i++){ s+=a*noise(v); n+=a; v=rot*v*2.02+11.5; a*=.55; }
  return s/n;
}
float twinkle(vec2 v){
  vec2 g = v*120., id = floor(g), f = fract(g)-.5;
  float h = hashS(id+5.2);
  float on = step(.9, h);
  // jitter each star inside its cell so no lattice shows through
  f -= (vec2(hashS(id+17.3), hashS(id+29.8))-.5)*.62;
  float pt = smoothstep(.16, 0., length(f))*on;
  return pt*(.55+.45*sin(T*1.8+h*47.));
}
void main(){
  float aspect = R.x/R.y;
  vec2 p = vec2(uv.x*aspect, uv.y);
  vec2 cs = vec2(p.x*.85, p.y*1.12);
  cs.x -= DRIFT*.04*T;

  mat2 M = mat2(1.6,.8,-.8,1.6);
  float warp = fbm(cs*.6)-.5;
  vec2 o = cs*2.05 - warp;

  float r=0.; vec2 q=o; float w=.7;
  for(int i=0;i<8;i++){ r+=abs(w*snoise(q)); q=M*q; w*=.72; }
  float f=0.; q=o; w=.65;
  for(int i=0;i<8;i++){ f+=w*snoise(q); q=M*q; w*=.66; }
  f = abs(f);
  f *= r + f;

  float c=0.; q=cs*2.-warp; w=.5;
  for(int i=0;i<6;i++){ c+=w*noise(q); q=M*q; w*=.6; }

  float amt = smoothstep(COV, COV+max(.05,SOFT), f*r);

  vec3 sky = mix(HOR, TOP, pow(clamp(uv.y,0.,1.),.9));

  // painted form shadow: probe the field a step toward the light
  vec2 L = normalize(vec2(.3,1.));
  float sp=0.; q=o+L*.2; w=.6;
  for(int i=0;i<5;i++){ sp+=w*snoise(q); q=M*q; w*=.6; }
  float occ = smoothstep(.14,.92,abs(sp));

  // soft cel bands — quantized light, feathered band edges
  float lit0 = clamp(.48+.62*c+.13*(uv.y-.45)-.22*occ, 0., 1.);
  float b = lit0*5.;
  float lit = (floor(b)+smoothstep(.32,.68,fract(b)))/5.;
  lit = .46+.48*lit;

  vec3 cloud = mix(SHD, CLD, lit);
  cloud += vec3(.045,.026,0.)*smoothstep(.82,1.,lit);
  cloud = mix(cloud, cloud*.62+sky*.38, (1.-lit)*.2);
  float rim = smoothstep(.04,.45,amt)*smoothstep(.95,.45,amt);
  cloud += vec3(.07,.05,.02)*rim*(1.-occ)*.4;

  vec3 col = mix(sky, clamp(cloud,0.,1.), amt);

  if(STARS>.5){
    float s = twinkle(vec2(uv.x*aspect, uv.y));
    col += vec3(.86,.9,1.)*s*(1.-amt)*smoothstep(.12,.55,uv.y);
  }
  gl_FragColor = vec4(col, 1.);
}`;

  const PAL = {
    day:   { top:[.44,.64,.90], hor:[.80,.89,.97], cld:[1,.99,.95],  shd:[.74,.80,.91], stars:0 },
    dusk:  { top:[.42,.40,.60], hor:[.99,.63,.42], cld:[1,.85,.72],  shd:[.58,.42,.52], stars:0 },
    night: { top:[.075,.105,.175], hor:[.16,.225,.35], cld:[.40,.46,.60], shd:[.16,.21,.34], stars:1 },
  };
  const COVERAGE = 0.40, SOFTNESS = 1.12, DRIFT = 0.2;
  const MAXPX = 1.15e6;          // internal pixel budget — clouds upscale invisibly
  const FPS = 30;

  const themeName = () => document.documentElement.dataset.theme === 'light' ? 'day' : 'night';
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpV = (a, b, t) => [lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t)];
  // day <-> night walks through dusk so the flip shows a real sunset, not mud
  const path = (t, from, to) => {
    const stops = [PAL[from], PAL.dusk, PAL[to]];
    const x = Math.min(.99999, Math.max(0, t)) * 2, k = x < 1 ? 0 : 1, f = x - k;
    const a = stops[k], b = stops[k+1];
    return { top:lerpV(a.top,b.top,f), hor:lerpV(a.hor,b.hor,f),
             cld:lerpV(a.cld,b.cld,f), shd:lerpV(a.shd,b.shd,f),
             stars:lerp(a.stars,b.stars,f) };
  };

  document.querySelectorAll('canvas[data-dues-sky]').forEach((cv) => {
    const gl = cv.getContext('webgl', { antialias:false, alpha:false, depth:false, stencil:false })
             || cv.getContext('experimental-webgl');
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = {}; ['T','R','COV','SOFT','DRIFT','TOP','HOR','CLD','SHD','STARS']
      .forEach(n => U[n] = gl.getUniformLocation(prog, n));
    gl.uniform1f(U.COV, COVERAGE); gl.uniform1f(U.SOFT, SOFTNESS); gl.uniform1f(U.DRIFT, DRIFT);

    let cur = themeName(), from = cur, tw = 1, twAt = 0;  // palette tween (1 = settled)
    let visible = true, last = 0;
    const size = () => {
      const w = cv.clientWidth || innerWidth, h = cv.clientHeight || innerHeight;
      let s = Math.min(devicePixelRatio || 1, 1.5);
      if (w*s * h*s > MAXPX) s = Math.sqrt(MAXPX / (w*h));
      const W = Math.max(2, Math.round(w*s)), H = Math.max(2, Math.round(h*s));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; gl.viewport(0,0,W,H); }
      gl.uniform2f(U.R, cv.width, cv.height);
    };
    size();
    addEventListener('resize', size);
    new MutationObserver(() => {
      const next = themeName();
      if (next !== cur) { from = cur; cur = next; tw = 0; twAt = performance.now(); }
    }).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
    if ('IntersectionObserver' in window)
      new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(cv);

    const t0 = performance.now();
    const frame = (now) => {
      requestAnimationFrame(frame);
      if (!visible || document.hidden) return;
      if (now - last < 1000/FPS) return;
      last = now;
      if (tw < 1) tw = Math.min(1, (now - twAt) / 1600);   // 1.6s day/night walk, wall-clock
      const pal = tw < 1 ? path(tw, from, cur) : path(1, from, cur);
      gl.uniform3fv(U.TOP, pal.top); gl.uniform3fv(U.HOR, pal.hor);
      gl.uniform3fv(U.CLD, pal.cld); gl.uniform3fv(U.SHD, pal.shd);
      gl.uniform1f(U.STARS, pal.stars);
      gl.uniform1f(U.T, (now - t0) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      cv.dataset.skyLive = '1';
    };
    requestAnimationFrame(frame);
  });
})();
