import { FS, BAND_DEMO, makeEngine, spectrum, bandPower } from './engine.mjs';
let pass=0, fail=0;
const g=(n,c,d)=>{ c?(pass++,console.log(`  ok   ${n}  ${d??''}`)):(fail++,console.log(`  FAIL ${n}  ${d??''}`)); };
const rec=(cfg,secs,ch=0)=>{const e=makeEngine(3);const n=Math.round(secs*FS);const o=new Float64Array(n);
  for(let i=0;i<n;i++)o[i]=e.sample(i/FS,cfg,ch);return o;};
const psdOf=(s)=>{const N=384,acc=new Float64Array(256);let k=0;
  for(let i=0;i+N<=s.length;i+=FS){const p=spectrum(Array.from(s.slice(i,i+N)));for(let j=0;j<256;j++)acc[j]+=p[j];k++;}
  for(let j=0;j<256;j++)acc[j]/=k;return acc;};

console.log('\n== gate: one band at a time ==');
const amps={};
for (const k of Object.keys(BAND_DEMO)) {
  const b=BAND_DEMO[k];
  const sig=rec({custom:b,age:40},24,0);
  const p=psdOf(sig);
  const own=bandPower(p,b.lo,b.hi), all=bandPower(p,0.1,45);
  const pp=Math.max(...sig)-Math.min(...sig);
  amps[k]=pp;
  g(`${b.label} puts its power in its own band`, own/all > 0.85,
    `${(own/all*100).toFixed(1)}% inside ${b.lo}-${b.hi} Hz, ${pp.toFixed(0)} uV p-p`);
}
g('each demonstration is a single component, not a mixture',
  Object.values(BAND_DEMO).every(b => b.comps.length === 1), '');
const order=['slow','delta','theta','alpha','beta','gamma'];
let mono=true;
for (let i=1;i<order.length;i++) if (amps[order[i]] >= amps[order[i-1]]) mono=false;
g('amplitude falls monotonically as frequency rises (the 1/f character)', mono,
  order.map(k=>`${k} ${amps[k].toFixed(0)}`).join(' > '));
g('the fastest band is small enough that a fixed gain would hide it',
  amps.gamma < 0.25 * amps.slow, `gamma ${amps.gamma.toFixed(0)} vs slow ${amps.slow.toFixed(0)} uV`);
g('every band carries a note saying what it means clinically',
  Object.values(BAND_DEMO).every(b => b.note.length > 60), '');
g('the band edges match the set the programme declares (Guay 2025)',
  BAND_DEMO.delta.lo===1 && BAND_DEMO.delta.hi===4 && BAND_DEMO.alpha.lo===8 &&
  BAND_DEMO.alpha.hi===12 && BAND_DEMO.beta.lo===13 && BAND_DEMO.beta.hi===25, '');
// --- added after stress test 2: a rhythm that never varies is a tone ---
console.log('== gate: the demonstrations wax and wane ==');
{
  let allOk = true, rows = [];
  for (const k of Object.keys(BAND_DEMO)) {
    const b = BAND_DEMO[k];
    const sig = rec({ custom: b, age: 40 }, 30, 0);
    // envelope via moving max over ~2 cycles
    const w = Math.max(4, Math.round((1 / b.f) * FS));   // one carrier cycle
    const env = [];
    for (let i = 0; i + w <= sig.length; i += w) {
      let m = 0; for (let j = i; j < i + w; j++) m = Math.max(m, Math.abs(sig[j]));
      env.push(m);
    }
    const mean = env.reduce((a, x) => a + x, 0) / env.length;
    const sd = Math.sqrt(env.reduce((a, x) => a + (x - mean) ** 2, 0) / env.length);
    const cv = sd / mean;
    rows.push(`${k} ${(cv * 100).toFixed(0)}%`);
    if (cv < 0.15) allOk = false;
    const p = psdOf(sig);
    if (bandPower(p, b.lo, b.hi) / bandPower(p, 0.1, 45) < 0.85) allOk = false;
  }
  const g2 = (n, c, d) => { c ? (pass++, console.log(`  ok   ${n}  ${d ?? ''}`)) : (fail++, console.log(`  FAIL ${n}  ${d ?? ''}`)); };
  g2('every band demonstration waxes and wanes by at least 15%, and still stays in its band',
    allOk, rows.join('  '));
}




// --- added after the paediatric literature landed (Markus 2026) ---
console.log('\n== gate: the awake baseline is age-dependent ==');
{
  const g2 = (n, c, d) => { c ? (pass++, console.log(`  ok   ${n}  ${d ?? ''}`)) : (fail++, console.log(`  FAIL ${n}  ${d ?? ''}`)); };
  const psd2 = (s) => { const N = 384, acc = new Float64Array(256); let k = 0;
    for (let i = 0; i + N <= s.length; i += FS) { const p = spectrum(Array.from(s.slice(i, i + N))); for (let j = 0; j < 256; j++) acc[j] += p[j]; k++; }
    for (let j = 0; j < 256; j++) acc[j] /= k; return acc; };
  const rel2 = (p, lo, hi) => bandPower(p, lo, hi) / bandPower(p, 0.5, 45);
  const at = (age, ch) => psd2(rec({ state: 'awake', age }, 30, ch));
  const inf = at(0.25, 1), child = at(5, 1), adult = at(35, 1);
  g2('an awake infant is delta-dominant, not alpha-dominant (Markus 2026)',
    rel2(inf, 1, 4) > rel2(inf, 8, 12), `delta ${(rel2(inf,1,4)*100).toFixed(0)}% vs alpha ${(rel2(inf,8,12)*100).toFixed(0)}%`);
  g2('an awake adult is alpha-dominant on an occipital channel',
    rel2(adult, 8, 12) > rel2(adult, 1, 4), `alpha ${(rel2(adult,8,12)*100).toFixed(0)}% vs delta ${(rel2(adult,1,4)*100).toFixed(0)}%`);
  g2('awake delta recedes monotonically with age',
    rel2(inf, 1, 4) > rel2(child, 1, 4) && rel2(child, 1, 4) > rel2(adult, 1, 4),
    `${(rel2(inf,1,4)*100).toFixed(0)}% > ${(rel2(child,1,4)*100).toFixed(0)}% > ${(rel2(adult,1,4)*100).toFixed(0)}%`);
}

console.log(`\n${pass} band gates pass, ${fail} fail\n`);
process.exit(fail?1:0);
