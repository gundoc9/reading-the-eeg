import { FS, STATES, COMBOS, record, spectrum, bandPower, sef, sustain,
         caseState, casePhase, CASE_KEYS, signalQuality, makeEngine, artefact } from './engine.mjs';

// isolate an artefact so topography is measured on the artefact, not on the
// record it is riding on
const artOnly=(a,ch,secs=20)=>{const n=Math.round(secs*FS);const o=new Float64Array(n);
  for(let i=0;i<n;i++)o[i]=artefact(i/FS,a,ch,{});return o;};
const amp=(s)=>Math.max(...s)-Math.min(...s);

let pass=0, fail=0;
const gate=(n,c,d)=>{ if(c){pass++;console.log(`  ok   ${n}  ${d??''}`);} else {fail++;console.log(`  FAIL ${n}  ${d??''}`);} };
const psdOf=(s)=>{const N=384,nfft=512,acc=new Float64Array(nfft/2);let k=0;
  for(let i=0;i+N<=s.length;i+=FS){const p=spectrum(Array.from(s.slice(i,i+N)),nfft,3);for(let j=0;j<acc.length;j++)acc[j]+=p[j];k++;}
  for(let j=0;j<acc.length;j++)acc[j]/=k;return acc;};
const rel=(p,lo,hi)=>bandPower(p,lo,hi)/bandPower(p,0.5,60);
const pp=(s)=>Math.max(...s)-Math.min(...s);
const rec=(cfg,secs,ch)=>{const e=makeEngine(3);const n=Math.round(secs*FS);const o=new Float64Array(n);
  for(let i=0;i<n;i++)o[i]=e.sample(i/FS,cfg,ch);return o;};

console.log('\n== gate: artefacts (AR1/AR2/AR5) ==');
const clean = rec({state:'propofol',age:40},30,0);
const cleanQ = signalQuality(clean, psdOf(clean));
gate('a clean record scores high signal quality', cleanQ>85, `SQI ${cleanQ.toFixed(0)}`);

const emgF = rec({state:'propofol',age:40,art:{emg:0.6}},30,0);
const emgO = rec({state:'propofol',age:40,art:{emg:0.6}},30,1);
gate('EMG loads the 30-60 Hz band', rel(psdOf(emgF),30,60) > 20*rel(psdOf(clean),30,60),
  `${(rel(psdOf(emgF),30,60)*100).toFixed(1)}% vs ${(rel(psdOf(clean),30,60)*100).toFixed(2)}%`);
gate('EMG is frontal-dominant',
  amp(artOnly({emg:0.6},0)) > 2.8*amp(artOnly({emg:0.6},1)),
  `isolated F ${amp(artOnly({emg:0.6},0)).toFixed(0)} vs O ${amp(artOnly({emg:0.6},1)).toFixed(0)} uV`);

for (const hz of [50,60]) {
  const m = rec({state:'propofol',age:40,art:{mains:0.7,mainsHz:hz}},30,0);
  const P = psdOf(m); const DF=FS/512; const i=Math.round(hz/DF);
  const nb=((P[i-6]||0)+(P[i+6]||0))/2;
  gate(`mains at ${hz} Hz is a narrow line`, P[i] > 100*nb, `peak/neighbour ${(P[i]/Math.max(nb,1e-9)).toExponential(1)}`);
}

const eye = rec({state:'propofol',age:40,art:{eye:0.8}},30,0);
const eyeO = rec({state:'propofol',age:40,art:{eye:0.8}},30,1);
gate('eye artefact is large, low-frequency and frontal',
  amp(artOnly({eye:0.8},0)) > 60 && amp(artOnly({eye:0.8},0)) > 2.8*amp(artOnly({eye:0.8},1)) &&
  rel(psdOf(eye),0.5,4) > rel(psdOf(clean),0.5,4),
  `isolated F ${amp(artOnly({eye:0.8},0)).toFixed(0)} vs O ${amp(artOnly({eye:0.8},1)).toFixed(0)} uV`);

const pop = rec({state:'propofol',age:40,art:{pop:0.8}},30,0);
gate('electrode pop produces transients larger than any physiological state',
  amp(artOnly({pop:0.8},0)) > 100 && pp(pop) > 2*pp(clean),
  `isolated ${amp(artOnly({pop:0.8},0)).toFixed(0)} uV; record ${pp(pop).toFixed(0)} vs ${pp(clean).toFixed(0)} uV`);

console.log('  SQI response:');
let mono = true, prev = cleanQ;
for (const lvl of [0.2,0.4,0.6,0.8,1.0]) {
  const s = rec({state:'propofol',age:40,art:{emg:lvl}},30,0);
  const q = signalQuality(s, psdOf(s));
  console.log(`    emg ${lvl.toFixed(1)} -> SQI ${q.toFixed(0)}`);
  if (q > prev + 1) mono = false;
  prev = q;
}
gate('signal quality falls monotonically as EMG rises', mono && prev < 45, `worst ${prev.toFixed(0)}`);

console.log('\n== gate: the case, baseline to emergence (RW7/RW5/NC11/NC12) ==');
const at=(p,ch=0)=>rec({custom:caseState(p),age:40},24,ch);
const P=(p,ch=0)=>psdOf(at(p,ch));
const base=P(0.00), ind=P(0.11), loc=P(0.21), main=P(0.34), inc=P(0.52), rest=P(0.64), em=P(0.80), awk=P(1.00);
gate('phase names resolve across the timeline',
  CASE_KEYS.length===9 && casePhase(0).n==='Baseline' && casePhase(0.52).n==='Incision' && casePhase(1).n==='Awake',
  CASE_KEYS.map(k=>k.n).join(' / '));
gate('induction shows beta activation above maintenance',
  rel(ind,13,25) > 4*rel(main,13,25), `${(rel(ind,13,25)*100).toFixed(1)}% vs ${(rel(main,13,25)*100).toFixed(2)}%`);
gate('slow-delta grows from baseline through loss of consciousness to maintenance',
  bandPower(loc,0.5,4) > 4*bandPower(base,0.5,4) && bandPower(main,0.5,4) > bandPower(loc,0.5,4), '');
// relative power is the wrong measure at baseline: the frontal channel carries a
// small genuine leak of the posterior rhythm against almost no slow-delta, so the
// percentage is large while the absolute alpha is tiny. Measure absolute power.
gate('frontal alpha power rises steeply from baseline to maintenance',
  bandPower(main,8,12) > 8*bandPower(base,8,12),
  `${(bandPower(main,8,12)/bandPower(base,8,12)).toFixed(1)}x`);
gate('alpha at baseline is OCCIPITAL, at maintenance FRONTAL',
  bandPower(P(0,1),8,12) > 3*bandPower(base,8,12) && bandPower(main,8,12) > 3*bandPower(P(0.34,1),8,12), '');
const aM=bandPower(main,8,12), aI=bandPower(inc,8,12), sM=bandPower(main,0.5,4), sI=bandPower(inc,0.5,4);
gate('incision is an ALPHA DROPOUT, not lightening: alpha collapses while slow-delta holds',
  aI < 0.35*aM && sI > 0.6*sM, `alpha ${(aI/aM*100).toFixed(0)}% of maintenance, slow-delta ${(sI/sM*100).toFixed(0)}%`);
gate('alpha returns after analgesia without losing slow-delta',
  bandPower(rest,8,12) > 0.85*aM && bandPower(rest,0.5,4) > 0.85*sM, '');
gate('emergence sheds slow-delta and gains theta',
  bandPower(em,0.5,4) < 0.6*sM && rel(em,4,8) > rel(main,4,8), '');
gate('the record returns to its own baseline',
  Math.abs(bandPower(awk,0.5,45)-bandPower(base,0.5,45))/bandPower(base,0.5,45) < 0.15, '');
gate('EMG is present awake and gone at surgical depth',
  rel(base,30,60) > 4*rel(main,30,60), `${(rel(base,30,60)*100).toFixed(1)}% vs ${(rel(main,30,60)*100).toFixed(2)}%`);

console.log('\n== gate: combinations (EF7) ==');
const cb=(k,ch=0)=>psdOf(rec({custom:COMBOS[k],age:40},30,ch));
const prop=psdOf(rec({state:'propofol',age:40},30,0));
const sevo=psdOf(rec({state:'sevoflurane',age:40},30,0));
const remi=cb('propofol+remifentanil');
gate('propofol + remifentanil is spectrally the propofol picture',
  Math.abs(sef(remi)-sef(prop))<0.5 && Math.abs(rel(remi,8,12)-rel(prop,8,12))<0.01,
  `SEF95 ${sef(remi).toFixed(1)} vs ${sef(prop).toFixed(1)} Hz`);
const pk=cb('propofol+ketamine');
gate('propofol + ketamine adds gamma and weakens the alpha',
  rel(pk,25,45) > 10*rel(prop,25,45) && rel(pk,8,12) < rel(prop,8,12),
  `gamma ${(rel(pk,25,45)*100).toFixed(1)}%, alpha ${(rel(pk,8,12)*100).toFixed(1)}% vs ${(rel(prop,8,12)*100).toFixed(1)}%`);
const pdSig = sustain(Array.from(rec({custom:COMBOS['propofol+dexmedetomidine'],age:40},20,0).slice(0,1024)),12,15);
const pdAlp = sustain(Array.from(rec({custom:COMBOS['propofol+dexmedetomidine'],age:40},20,0).slice(0,1024)),8,12);
gate('propofol + dex carries a solid alpha and a broken sigma on one record',
  pdAlp > 0.7 && pdSig < 0.45, `alpha sustain ${pdAlp.toFixed(2)}, sigma sustain ${pdSig.toFixed(2)}`);
const sn=cb('sevoflurane+n2o');
gate('sevoflurane + N2O sheds slow-delta and gains high frequency',
  bandPower(sn,0.5,4) < 0.6*bandPower(sevo,0.5,4) && rel(sn,20,45) > 5*rel(sevo,20,45),
  `slow-delta ${(bandPower(sn,0.5,4)/bandPower(sevo,0.5,4)*100).toFixed(0)}% of sevo`);
gate('every combination declares whether its morphology is sourced or interpolated',
  Object.values(COMBOS).every(c => typeof c.sourced === 'boolean' && c.note.length > 40),
  `${Object.values(COMBOS).filter(c=>c.sourced).length} sourced, ${Object.values(COMBOS).filter(c=>!c.sourced).length} flagged as interpolation`);

console.log(`\n${pass} v2 gates pass, ${fail} fail\n`);
process.exit(fail?1:0);
