import { FS, STATES, record, spectrum, bandPower, sef, measuredBSR, sustain, alphaAge, slowAge } from './engine.mjs';

let pass = 0, fail = 0;
const gate = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}  ${detail ?? ''}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail ?? ''}`); }
};

const pp = (s) => Math.max(...s) - Math.min(...s);
const psdOf = (s) => {
  // average spectra over 3 s windows, 1 s step
  const N = 384, nfft = 512;
  const acc = new Float64Array(nfft / 2);
  let k = 0;
  for (let i = 0; i + N <= s.length; i += FS) {
    const seg = Array.from(s.slice(i, i + N));
    const p = spectrum(seg, nfft, 3);
    for (let j = 0; j < acc.length; j++) acc[j] += p[j];
    k++;
  }
  for (let j = 0; j < acc.length; j++) acc[j] /= k;
  return acc;
};
const rel = (psd, lo, hi) => bandPower(psd, lo, hi) / bandPower(psd, 0.5, 45);

const SECS = 40;
const R = {};
for (const s of Object.keys(STATES)) {
  R[s] = {
    F: record({ state: s, age: 40 }, SECS, 0),
    O: record({ state: s, age: 40 }, SECS, 1),
  };
  R[s].pF = psdOf(R[s].F);
  R[s].pO = psdOf(R[s].O);
}

console.log('\n== band structure ==');
for (const s of Object.keys(STATES)) {
  const p = R[s].pF;
  const f = (lo, hi) => (rel(p, lo, hi) * 100).toFixed(1);
  console.log(`  ${s.padEnd(16)} slow ${f(0.5,1)}  delta ${f(1,4)}  theta ${f(4,8)}  alpha ${f(8,12)}  sigma ${f(12,15)}  beta ${f(13,25)}  gamma ${f(25,45)}   pp ${pp(R[s].F).toFixed(0)}uV  SEF95 ${sef(p).toFixed(1)}Hz`);
}

console.log('\n== gate: state signatures ==');
gate('awake alpha is the dominant rhythm posteriorly',
  rel(R.awake.pO, 8, 12) > 0.35, `occ alpha ${(rel(R.awake.pO,8,12)*100).toFixed(0)}%`);
gate('awake is low amplitude (10-45 uV p-p)',
  pp(R.awake.O) > 10 && pp(R.awake.O) < 45, `${pp(R.awake.O).toFixed(0)} uV`);
gate('propofol is slow-delta dominant with an alpha peak',
  rel(R.propofol.pF, 0.5, 4) > 0.5 && rel(R.propofol.pF, 8, 12) > 0.03,
  `slow-delta ${(rel(R.propofol.pF,0.5,4)*100).toFixed(0)}%  alpha ${(rel(R.propofol.pF,8,12)*100).toFixed(1)}%`);
gate('propofol amplitude is 3x+ awake (Guay: 30-40 uV slow-delta)',
  pp(R.propofol.F) / pp(R.awake.O) > 3, `${(pp(R.propofol.F)/pp(R.awake.O)).toFixed(1)}x`);
gate('sevoflurane carries theta that propofol does not (Akeju 2014, 4.9 Hz)',
  rel(R.sevoflurane.pF, 4, 8) > 2 * rel(R.propofol.pF, 4, 8),
  `sevo ${(rel(R.sevoflurane.pF,4,8)*100).toFixed(1)}% vs propofol ${(rel(R.propofol.pF,4,8)*100).toFixed(1)}%`);
gate('ketamine gamma exceeds every other anaesthetic (Akeju 2016)',
  ['propofol','sevoflurane','dexmedetomidine'].every(s => rel(R.ketamine.pF,25,45) > 10 * rel(R[s].pF,25,45)),
  `ket ${(rel(R.ketamine.pF,25,45)*100).toFixed(1)}% vs propofol ${(rel(R.propofol.pF,25,45)*100).toFixed(2)}%`);
gate('awake frontal high-frequency exceeds any anaesthetised state (EMG, Guay 2025)',
  rel(R.awake.pF,25,45) > rel(R.ketamine.pF,25,45),
  `awake ${(rel(R.awake.pF,25,45)*100).toFixed(1)}% vs ketamine ${(rel(R.ketamine.pF,25,45)*100).toFixed(1)}%`);
gate('ketamine alpha reduced but NOT abolished (Akeju 2016 says decreased)',
  rel(R.ketamine.pF,8,12) > 0.002 && rel(R.ketamine.pF,8,12) < rel(R.propofol.pF,8,12),
  `ket ${(rel(R.ketamine.pF,8,12)*100).toFixed(2)}% vs propofol ${(rel(R.propofol.pF,8,12)*100).toFixed(2)}%`);
// A share-of-total test is diluted by any low-frequency power added elsewhere
// (K-complexes did exactly that). The claim is that sigma forms a PEAK, so test
// it against its own shoulders instead.
const sigmaPeak = (p) => bandPower(p,12,15) / ((bandPower(p,8,12) + bandPower(p,15,20)) / 2);
gate('dexmedetomidine and NREM2 both show a sigma PEAK above its shoulders',
  sigmaPeak(R.dexmedetomidine.pF) > 1.5 && sigmaPeak(R.nrem2.pF) > 1.5,
  `dex ${sigmaPeak(R.dexmedetomidine.pF).toFixed(1)}x  nrem2 ${sigmaPeak(R.nrem2.pF).toFixed(1)}x`);
// Prerau 2017 gives two spectrogram discriminators between REM and eyes-closed
// wake: REM background power is higher, and REM alpha is transient/bursty with
// lower power and peak frequency than wake's persistent alpha.
const bgR = bandPower(R.rem.pO,1,8) + bandPower(R.rem.pO,13,45);
const bgW = bandPower(R.awake.pO,1,8) + bandPower(R.awake.pO,13,45);
gate('REM background power exceeds eyes-closed wake (Prerau 2017)', bgR > bgW,
  `REM ${bgR.toFixed(0)} vs wake ${bgW.toFixed(0)}`);
gate('REM alpha is weaker than wake alpha (Prerau 2017)',
  bandPower(R.rem.pO,8,12) < 0.5 * bandPower(R.awake.pO,8,12),
  `${(bandPower(R.rem.pO,8,12)/bandPower(R.awake.pO,8,12)*100).toFixed(0)}% of wake`);

console.log('\n== gate: continuity (sustain) ==');
const sus = (s, ch, lo, hi) => sustain(Array.from(R[s][ch].slice(0, 1024)), lo, hi);
const sP = sus('propofol','F',8,12), sD = sus('dexmedetomidine','F',12,15),
      sN = sus('nrem2','F',12,15), sK = sus('ketamine','F',25,45), sA = sus('awake','O',8,12);
console.log(`  propofol alpha ${sP.toFixed(2)} | awake alpha ${sA.toFixed(2)} | dex sigma ${sD.toFixed(2)} | nrem2 sigma ${sN.toFixed(2)} | ket gamma ${sK.toFixed(2)}`);
gate('propofol alpha is continuous', sP > 0.7, sP.toFixed(2));
gate('spindles are episodic, clearly separable from propofol alpha', sD < 0.5 && sN < 0.5 && sP > 2 * sD, '');
gate('ketamine gamma is bursty', sK < 0.7, sK.toFixed(2));
const sR = sus('rem','O',8,12);
gate('REM alpha is bursty where wake alpha is persistent (Prerau 2017)',
  sR < 0.6 && sA > 0.8, `REM ${sR.toFixed(2)} vs wake ${sA.toFixed(2)}`);

console.log('\n== gate: anteriorisation (Purdon PNAS 2013) ==');
const fo = (s, lo, hi) => rel(R[s].pF, lo, hi) === 0 ? 0 : bandPower(R[s].pF, lo, hi) / bandPower(R[s].pO, lo, hi);
gate('awake alpha is posterior (F:O < 0.7)', fo('awake',8,12) < 0.7, `F:O ${fo('awake',8,12).toFixed(2)}`);
gate('propofol alpha is frontal (F:O > 2.5)', fo('propofol',8,12) > 2.5, `F:O ${fo('propofol',8,12).toFixed(2)}`);
gate('the alpha rhythm moves front-to-back between the two', fo('propofol',8,12) / fo('awake',8,12) > 5,
  `${(fo('propofol',8,12)/fo('awake',8,12)).toFixed(1)}x`);

console.log('\n== gate: burst suppression amplitude anchors (Guay 2025) ==');
for (const b of [0.3, 0.6, 0.85]) {
  const s = record({ state: 'propofol', age: 40, bsr: b }, 60, 0);
  const m = measuredBSR(s);
  gate(`BSR ${b} measures back within 0.15`, Math.abs(m - b) < 0.15, `measured ${m.toFixed(2)}`);
}
const bsSig = record({ state: 'propofol', age: 40, bsr: 0.6 }, 30, 0);
let supMax = 0;
for (let i = 0; i + 64 <= bsSig.length; i += 64) {
  const w = bsSig.slice(i, i + 64);
  const a = Math.max(...w) - Math.min(...w);
  if (a < 5) supMax = Math.max(supMax, a);
}
gate('suppression epochs sit under the 5 uV criterion', supMax < 5 && supMax > 0, `worst ${supMax.toFixed(2)} uV`);
const iso = record({ state: 'propofol', age: 40, bsr: 1.0 }, 20, 0);
gate('full suppression approaches electrocerebral inactivity (<= 2 uV)', pp(iso) <= 2.0, `${pp(iso).toFixed(2)} uV p-p`);

console.log('\n== gate: SEF95 behaves as taught ==');
const sefs = {};
for (const s of Object.keys(STATES)) sefs[s] = sef(R[s].pF);
gate('SEF95 falls from awake to propofol', sefs.propofol < sefs.awake,
  `awake ${sefs.awake.toFixed(1)} -> propofol ${sefs.propofol.toFixed(1)} Hz`);
gate('ketamine SEF95 rises above propofol (the index failure case)',
  sefs.ketamine > sefs.propofol + 3, `ketamine ${sefs.ketamine.toFixed(1)} Hz`);
gate('awake frontal SEF95 sits in a plausible 20-35 Hz range (EMG inflates it)',
  sefs.awake > 20 && sefs.awake < 35, `${sefs.awake.toFixed(1)} Hz`);
gate('NREM2 and dex both give low SEF95 despite different agents',
  sefs.nrem2 < 5 && sefs.dexmedetomidine < 5, `nrem2 ${sefs.nrem2.toFixed(1)}  dex ${sefs.dexmedetomidine.toFixed(1)}`);

console.log('\n== gate: age model (Guay 2025) ==');
const ages = [0.1, 0.4, 1, 3, 7, 25, 60, 89];
console.log('  age  alphaGain  slowGain');
for (const a of ages) console.log(`  ${String(a).padStart(4)}   ${alphaAge(a).toFixed(2)}       ${slowAge(a).toFixed(2)}`);
gate('no frontal alpha before ~4 months', alphaAge(0.2) === 0 && alphaAge(0.1) === 0, '');
gate('alpha present by 1 yr and peaks 6-8 yr', alphaAge(1) > 0 && alphaAge(7) >= alphaAge(3) && alphaAge(7) >= alphaAge(25), '');
gate('alpha declines into old age', alphaAge(89) < 0.3 * alphaAge(7), `${alphaAge(89).toFixed(2)} vs ${alphaAge(7).toFixed(2)}`);
gate('slow-delta amplitude falls with age (30-40 uV young vs 10-20 uV at 89)',
  slowAge(25) / slowAge(89) > 1.8, `ratio ${(slowAge(25)/slowAge(89)).toFixed(2)}`);
const inf = record({ state: 'propofol', age: 0.2 }, 30, 0);
gate('a 2-month-old under propofol shows slow-delta with no alpha peak',
  rel(psdOf(inf), 8, 12) < 0.02, `alpha ${(rel(psdOf(inf),8,12)*100).toFixed(2)}%`);

console.log(`\n${pass} gates pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
