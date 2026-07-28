import { FS, STATES, TRANSIENTS, makeEngine, measureTransient, envelope, spectrum, bandPower } from './engine.mjs';

let pass=0, fail=0;
const g=(n,c,d)=>{ c?(pass++,console.log(`  ok   ${n}  ${d??''}`)):(fail++,console.log(`  FAIL ${n}  ${d??''}`)); };
const rec=(cfg,secs,ch=0)=>{const e=makeEngine(3);const n=Math.round(secs*FS);const o=new Float64Array(n);
  for(let i=0;i<n;i++)o[i]=e.sample(i/FS,cfg,ch);return o;};
const one=(kind,ch=0)=>rec({state:'quiet',age:40,transient:{kind,period:4.0}},8,ch).subarray(0,Math.round(3.5*FS));

console.log('\n== gate: named waveform elements ==');
const base = rec({state:'quiet',age:40},20,0);
g('the isolated background is quiet enough to examine an element on',
  Math.max(...base)-Math.min(...base) < 7, `${(Math.max(...base)-Math.min(...base)).toFixed(1)} uV p-p`);

let worst=0;
for (const k of Object.keys(TRANSIENTS)) {
  const spec=TRANSIENTS[k], m=measureTransient(one(k));
  const err=Math.abs(m.dur-spec.dur)/spec.dur;
  worst=Math.max(worst,err);
  g(`${spec.label}: declared ${(spec.dur*1000).toFixed(0)} ms measures back`,
    err<0.08, `${(m.dur*1000).toFixed(0)} ms (${(err*100).toFixed(1)}%), ${m.amp.toFixed(0)} uV`);
}
g('every element measures back within 8% of what it declares', worst<0.08, `worst ${(worst*100).toFixed(1)}%`);

const dK=TRANSIENTS.kcomplex.dur, dV=TRANSIENTS.vertex.dur;
g('a K-complex is at least 5x longer than a vertex sharp wave — the discrimination is DURATION',
  dK/dV>=5, `${(dK/dV).toFixed(1)}x`);
g('both are frontally maximal',
  measureTransient(one('kcomplex',0)).amp > 2.5*measureTransient(one('kcomplex',1)).amp &&
  measureTransient(one('vertex',0)).amp > 2.5*measureTransient(one('vertex',1)).amp,
  `K-complex F:O ${(measureTransient(one('kcomplex',0)).amp/measureTransient(one('kcomplex',1)).amp).toFixed(1)}`);

// a spindle is a RUN, not a deflection: it must carry a sigma peak
const sp=one('spindleRun');
const psd=spectrum(Array.from(sp.subarray(Math.round(1.0*FS), Math.round(1.0*FS)+384)));
g('a sleep spindle is a run of oscillation, not a single deflection',
  bandPower(psd,11,16) > 3*bandPower(psd,4,8), `sigma:theta ${(bandPower(psd,11,16)/bandPower(psd,4,8)).toFixed(1)}`);

// the slow wave's down-state is sharper than its up-state
const sw=one('slowWave');
let mi=0; for(let i=0;i<sw.length;i++) if(sw[i]<sw[mi]) mi=i;
let ma=0; for(let i=mi;i<sw.length;i++) if(sw[i]>sw[ma]) ma=i;
const width=(idx,sign)=>{const pk=Math.abs(sw[idx]);let a=idx,b=idx;
  while(a>0&&Math.abs(sw[a])>0.5*pk&&Math.sign(sw[a])===sign)a--;
  while(b<sw.length-1&&Math.abs(sw[b])>0.5*pk&&Math.sign(sw[b])===sign)b++;return (b-a)/FS;};
const down=width(mi,-1), up=width(ma,1);
g('the slow wave down-state is sharper (shorter) than the up-state',
  down < up, `down ${(down*1000).toFixed(0)} ms vs up ${(up*1000).toFixed(0)} ms`);

console.log('\n== gate: elements in context ==');
const n2f=rec({state:'nrem2',age:40},40,0), n2o=rec({state:'nrem2',age:40},40,1);
const pk=(x)=>Math.max(...x.map(Math.abs));
g('K-complexes now appear inside NREM stage 2 (the flag was dead until now)',
  pk(Array.from(n2f)) > 90, `${pk(Array.from(n2f)).toFixed(0)} uV peak`);
g('and they are frontally maximal in context',
  pk(Array.from(n2f)) > 1.8*pk(Array.from(n2o)), `F ${pk(Array.from(n2f)).toFixed(0)} vs O ${pk(Array.from(n2o)).toFixed(0)} uV`);
g('no element leaks into a state that should not carry it',
  pk(Array.from(rec({state:'propofol',age:40},30,0))) < 90, '');

console.log('\n== gate: honesty ==');
g('every element declares whether its defining criterion is sourced',
  Object.values(TRANSIENTS).every(t => typeof t.sourced === 'boolean' && t.note.length > 60),
  `${Object.values(TRANSIENTS).filter(t=>t.sourced).length} sourced, ${Object.values(TRANSIENTS).filter(t=>!t.sourced).length} flagged`);
g('the unsourced ones say WHERE the criterion comes from',
  Object.values(TRANSIENTS).filter(t=>!t.sourced).every(t=>/AASM|convention|not in any source|not a transient/i.test(t.note)), '');

console.log(`\n${pass} element gates pass, ${fail} fail\n`);
process.exit(fail?1:0);
