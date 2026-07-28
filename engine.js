// EEG synthesis engine. Parameters derived from:
//   Purdon 2015 Anesthesiology 123:937-960 (Part I)
//   Guay 2025 Anesthesiology 143:1595-1618 (Part 2) - bands, amplitude anchors, age
//   Prerau 2017 Physiology 32:60-92 - sleep spectral dynamics
//   Akeju 2014 Anesthesiology 121:990-8 (sevo), 121:978-89 (dex), 2016 Clin Neurophysiol 127:2414-22 (ket)
//   Purdon PNAS 2013 - anterior alpha shift
// Synthesised, idealised signal. Not patient data.

export const FS = 128;

export const BANDS = {
  slow:  [0.1, 1],
  delta: [1, 4],
  theta: [4, 8],
  alpha: [8, 12],
  beta:  [13, 25],
  gamma: [25, 45],
};

// ---- deterministic smooth noise -------------------------------------------
function hash(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function vnoise(seed, x) {
  const i = Math.floor(x), f = x - i;
  const a = hash(i + seed * 1000), b = hash(i + 1 + seed * 1000);
  const u = f * f * (3 - 2 * f);
  return a * (1 - u) + b * u;
}
// pulse train with jittered period; returns 0..1 envelope with soft edges
function pulses(seed, t, period, dur, edge = 0.12) {
  const idx = Math.floor(t / period);
  const jit = (hash(idx + seed * 7717) - 0.5) * period * 0.5;
  const start = idx * period + jit;
  const dj = dur * (0.75 + 0.5 * hash(idx + seed * 331));
  const u = t - start;
  if (u < 0 || u > dj) return 0;
  const r = Math.min(u, dj - u) / edge;
  return Math.max(0, Math.min(1, r));
}

// ---- channel weighting ----------------------------------------------------
// frontal vs occipital gain per band, per condition.
// Awake alpha is the posterior dominant rhythm; propofol/sevo alpha is frontal
// (anteriorisation, Purdon PNAS 2013). ch: 0 = frontal, 1 = occipital.
function chGain(topo, ch) {
  // topo: 'front' | 'back' | 'flat'
  if (topo === 'front') return ch === 0 ? 1.0 : 0.26;
  if (topo === 'back') return ch === 0 ? 0.38 : 1.0;
  return ch === 0 ? 1.0 : 0.9;
}

// ---- age model ------------------------------------------------------------
// Guay 2025: frontal alpha emerges in sedated infants around 4-5 months,
// power peaks about 6-8 yr, then declines with age, indiscernible in some elderly.
export function alphaAge(age) {
  if (age < 0.35) return 0.0;
  if (age < 1) return 0.35 * (age - 0.35) / 0.65;
  if (age < 7) return 0.35 + 0.65 * (age - 1) / 6;
  return Math.max(0.12, 1.0 - 0.88 * Math.min(1, (age - 7) / 83));
}
// Markus 2026: delta predominates in every age group in the awake state before
// induction, with the difference from adults greatest in infants. Modelled as a
// factor that falls away through childhood.
export function awakeDeltaAge(age) {
  if (age < 0.5) return 1.0;
  if (age < 8) return 1.0 - 0.85 * (age - 0.5) / 7.5;
  return Math.max(0.06, 0.15 - 0.09 * Math.min(1, (age - 8) / 20));
}

// Guay 2025: slow-delta about 30-40 uV in a younger adult vs 10-20 uV at 89 yr.
export function slowAge(age) {
  if (age < 2) return 1.15;
  if (age < 25) return 1.15 - 0.15 * (age - 2) / 23;
  return Math.max(0.4, 1.0 - 0.6 * (age - 25) / 65);
}

// ---- state definitions ----------------------------------------------------
// amp values are uV (peak amplitude of that component before channel gain)
export const STATES = {
  quiet: {
    label: 'Isolated element',
    comps: [],
    noise: 0.35,
  },
  awake: {
    label: 'Awake, eyes closed',
    // ageDelta: paediatric awake baseline is delta-dominant (Markus 2026).
    // Their own limitation applies: Narcotrend output without raw traces, so
    // elevated preoperative delta may partly reflect eye-movement artefact.
    ageAwakeDelta: true,
    comps: [
      { f: 1.6, amp: 30, topo: 'flat', mode: 'sustained', band: 'awakeDelta', shape: 'slow' },
      { f: 10.0, amp: 10, topo: 'back', mode: 'sustained', band: 'alpha' },
      { f: 18.2, amp: 2.6, topo: 'back', mode: 'sustained', band: 'beta' },
      { f: 22.0, amp: 1.6, topo: 'front', mode: 'sustained', band: 'beta' },
      { f: 31.0, amp: 1.4, topo: 'front', mode: 'sustained', band: 'gamma' },
      // frontal awake high-frequency activity includes muscle artifact (Guay 2025)
      { f: 41.0, amp: 0.9, topo: 'front', mode: 'sustained', band: 'gamma', emg: true },
    ],
    noise: 1.9, ageAlpha: false, ageSlow: false,
  },
  nrem2: {
    label: 'NREM stage 2 sleep',
    comps: [
      { f: 1.0, amp: 26, topo: 'flat', mode: 'sustained', band: 'slow', shape: 'slow' },
      { f: 2.4, amp: 9, topo: 'flat', mode: 'sustained', band: 'delta' },
      { f: 13.2, amp: 20, topo: 'front', mode: 'spindle', band: 'sigma' },
    ],
    noise: 2.2, kcomplex: true,
  },
  rem: {
    label: 'REM sleep',
    comps: [
      { f: 8.6, amp: 8, topo: 'back', mode: 'burst', band: 'alpha', period: 2.6, dur: 0.7 },
      { f: 5.6, amp: 4.0, topo: 'flat', mode: 'sustained', band: 'theta' },
      { f: 17.0, amp: 3.8, topo: 'flat', mode: 'sustained', band: 'beta' },
      { f: 29.0, amp: 3.4, topo: 'front', mode: 'sustained', band: 'gamma' },
    ],
    noise: 5.2,
  },
  propofol: {
    label: 'Propofol, surgical depth',
    comps: [
      { f: 0.8, amp: 32, topo: 'flat', mode: 'sustained', band: 'slow', shape: 'slow' },
      { f: 2.2, amp: 14, topo: 'flat', mode: 'sustained', band: 'delta' },
      { f: 10.2, amp: 17, topo: 'front', mode: 'sustained', band: 'alpha' },
    ],
    noise: 2.0, ageAlpha: true, ageSlow: true,
  },
  sevoflurane: {
    label: 'Sevoflurane, surgical depth',
    comps: [
      { f: 0.8, amp: 30, topo: 'flat', mode: 'sustained', band: 'slow', shape: 'slow' },
      { f: 2.2, amp: 13, topo: 'flat', mode: 'sustained', band: 'delta' },
      { f: 4.9, amp: 13, topo: 'front', mode: 'sustained', band: 'theta' },
      { f: 9.8, amp: 15, topo: 'front', mode: 'sustained', band: 'alpha' },
    ],
    noise: 2.0, ageAlpha: true, ageSlow: true,
  },
  ketamine: {
    label: 'Ketamine',
    comps: [
      { f: 0.75, amp: 26, topo: 'flat', mode: 'antiphase', band: 'slow', shape: 'slow' },
      { f: 2.0, amp: 9, topo: 'flat', mode: 'antiphase', band: 'delta' },
      { f: 5.4, amp: 10, topo: 'front', mode: 'sustained', band: 'theta' },
      { f: 9.6, amp: 3.0, topo: 'front', mode: 'sustained', band: 'alpha' },
      { f: 28.0, amp: 11, topo: 'front', mode: 'burst', band: 'gamma', period: 1.35, dur: 0.6 },
      { f: 34.0, amp: 6, topo: 'front', mode: 'burst', band: 'gamma', period: 1.35, dur: 0.6 },
    ],
    noise: 2.4, ageAlpha: true, ageSlow: true,
  },
  dexmedetomidine: {
    label: 'Dexmedetomidine',
    comps: [
      { f: 0.9, amp: 24, topo: 'flat', mode: 'sustained', band: 'slow', shape: 'slow' },
      { f: 2.4, amp: 10, topo: 'flat', mode: 'sustained', band: 'delta' },
      { f: 13.0, amp: 14, topo: 'front', mode: 'spindle', band: 'sigma' },
    ],
    noise: 2.0, ageAlpha: true, ageSlow: true,
  },
};

// ---- engine ---------------------------------------------------------------
export function makeEngine(seed = 3) {
  let n1 = 0, n2 = 0, n3 = 0; // pink-ish filter state
  return {
    // returns uV sample at time t (s) for channel ch (0 frontal, 1 occipital)
    sample(t, cfg, ch) {
      // cfg.custom carries a directly supplied state (case timeline, combination)
      const st = cfg.custom || STATES[cfg.state] || STATES.awake;
      const age = cfg.age ?? 40;
      const aA = st.ageAlpha ? alphaAge(age) : 1;
      const aS = st.ageSlow ? slowAge(age) : 1;
      let v = 0;
      for (const c of st.comps) {
        let env = 1;
        if (c.mode === 'sustained') env = 0.86 + 0.14 * vnoise(c.f * 13, t * 0.7);
        else if (c.mode === 'waxing') env = 0.30 + 0.70 * vnoise(c.f * 29, t * Math.max(0.14, c.f / 10));
        else if (c.mode === 'spindle') env = pulses(c.f * 3, t, 3.4, 0.68, 0.16);
        else if (c.mode === 'burst') env = pulses(c.f * 5, t, c.period, c.dur, 0.1);
        else if (c.mode === 'antiphase') env = 1 - 0.85 * pulses(165, t, 1.35, 0.6, 0.1);
        let a = c.amp * env * chGain(c.topo, ch);
        if (c.band === 'alpha') a *= aA;
        if (c.band === 'slow' || c.band === 'delta') a *= aS;
        // awake delta: dominant in infants, receding through childhood, near
        // absent in the adult awake record (Markus 2026)
        if (c.band === 'awakeDelta') a *= st.ageAwakeDelta ? awakeDeltaAge(age) : 0;
        const th = 2 * Math.PI * c.f * t;
        // slow waves are not sinusoidal: second harmonic sharpens the down state
        v += c.shape === 'slow' ? a * (Math.sin(th) + 0.3 * Math.sin(2 * th + 1.2)) : a * Math.sin(th + c.f);
      }
      // pink-ish background
      const w = (hash(Math.round(t * FS) * 1.7 + seed) - 0.5) * 2;
      n1 = 0.997 * n1 + w * 0.016;
      n2 = 0.985 * n2 + w * 0.040;
      n3 = 0.90 * n3 + w * 0.18;
      v += (n1 + n2 + n3) * st.noise * 2.3;

      // burst suppression gate (Guay 2025: suppression < 5 uV, threshold 10 uV,
      // electrocerebral inactivity <= 2 uV)
      const bsr = cfg.bsr ?? 0;
      if (bsr > 0) {
        const g = bsGate(t, bsr);
        v = v * g + v * 0.016 * (1 - g);
      }
      // state-intrinsic EMG (awake and emerging patients have muscle; anaesthetised
      // ones largely do not), then any artefact the user has dialled in
      const art = { ...(cfg.art || {}) };
      if (st.emg) art.emg = Math.max(art.emg || 0, st.emg);
      v += artefact(t, art, ch, st);
      // named waveform elements
      v += transient(t, cfg, ch) + stateTransient(t, st, ch);
      return v * (cfg.gain ?? 1);
    },
  };
}

// burst-suppression gate: 1 during a burst, 0 during suppression, soft edges.
export function bsGate(t, bsr) {
  if (bsr <= 0) return 1;
  if (bsr >= 0.99) return 0;
  const period = 4.0;
  const burst = period * (1 - bsr);
  const idx = Math.floor(t / period);
  const jit = (hash(idx * 3.3 + 91) - 0.5) * period * 0.3;
  const u = t - (idx * period + jit);
  if (u < 0 || u > burst) return 0;
  const e = Math.min(u, burst - u) / 0.09;
  return Math.max(0, Math.min(1, e));
}

// ---- FFT (radix-2) --------------------------------------------------------
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Sine (Riedel-Sidorenko) multitaper spectrum. K tapers, N-point window.
// Browser-tractable stand-in for the Chronux DPSS multitaper used in the papers.
// Tapers and FFT scratch are memoised: this runs 4x/s inside an animation loop,
// and rebuilding them every call was measured at 189 us per call.
const _taperCache = new Map();
const _scratch = new Map();
function sineTapers(N, K) {
  const key = N + ':' + K;
  let t = _taperCache.get(key);
  if (t) return t;
  t = [];
  for (let k = 1; k <= K; k++) {
    const a = new Float64Array(N);
    for (let i = 0; i < N; i++) a[i] = Math.sin(Math.PI * k * (i + 1) / (N + 1));
    t.push(a);
  }
  _taperCache.set(key, t);
  return t;
}
export function spectrum(seg, nfft = 512, K = 3) {
  const N = seg.length;
  const tp = sineTapers(N, K);
  let sc = _scratch.get(nfft);
  if (!sc) { sc = { re: new Float64Array(nfft), im: new Float64Array(nfft) }; _scratch.set(nfft, sc); }
  const out = new Float64Array(nfft / 2);
  for (let k = 0; k < K; k++) {
    const re = sc.re, im = sc.im;
    re.fill(0); im.fill(0);
    const t = tp[k];
    const c = Math.sqrt(2 / (N + 1));
    for (let i = 0; i < N; i++) re[i] = seg[i] * c * t[i];
    fft(re, im);
    for (let i = 0; i < nfft / 2; i++) out[i] += (re[i] * re[i] + im[i] * im[i]) / K;
  }
  return out;
}

export function bandPower(psd, lo, hi, nfft = 512, fs = FS) {
  const df = fs / nfft;
  let s = 0;
  for (let i = Math.max(1, Math.round(lo / df)); i <= Math.round(hi / df) && i < psd.length; i++) s += psd[i];
  return s;
}

// Spectral edge frequency: f below which `frac` of total power (0.1-30 Hz) lies.
export function sef(psd, frac = 0.95, nfft = 512, fs = FS, top = 45) {
  const df = fs / nfft;
  const i0 = Math.max(1, Math.round(0.5 / df)), i1 = Math.round(top / df);
  let tot = 0;
  for (let i = i0; i <= i1; i++) tot += psd[i];
  let acc = 0;
  for (let i = i0; i <= i1; i++) { acc += psd[i]; if (acc >= frac * tot) return i * df; }
  return top;
}

// Measured burst-suppression ratio: fraction of a window under the 5 uV
// suppression criterion, evaluated over 0.5 s sub-epochs (Guay 2025 anchors).
export function measuredBSR(sig, fs = FS) {
  const w = Math.round(0.5 * fs);
  let sup = 0, n = 0;
  for (let i = 0; i + w <= sig.length; i += w) {
    let mx = 0, mn = 0;
    for (let j = i; j < i + w; j++) { if (sig[j] > mx) mx = sig[j]; if (sig[j] < mn) mn = sig[j]; }
    if (mx - mn < 5) sup++;
    n++;
  }
  return n ? sup / n : 0;
}

// Fraction of a window during which a band's envelope exceeds half its own peak.
// Separates a continuous rhythm (propofol alpha) from an episodic one (spindles).
export function sustain(sig, lo, hi, fs = FS) {
  const n = sig.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = sig[i];
  fft(re, im);
  const df = fs / n;
  for (let i = 0; i < n; i++) {
    const f = i <= n / 2 ? i * df : (i - n) * df;
    const keep = Math.abs(f) >= lo && Math.abs(f) <= hi;
    if (!keep) { re[i] = 0; im[i] = 0; }
    else if (f > 0) { re[i] *= 2; im[i] *= 2; }
    else if (f < 0) { re[i] = 0; im[i] = 0; }
  }
  // inverse FFT -> analytic signal
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const env = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) { env[i] = Math.hypot(re[i], im[i]) / n; if (env[i] > peak) peak = env[i]; }
  let c = 0;
  for (let i = 0; i < n; i++) if (env[i] > 0.5 * peak) c++;
  return c / n;
}

export function record(cfg, secs, ch = 0, seed = 3) {
  const e = makeEngine(seed);
  const n = Math.round(secs * FS);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = e.sample(i / FS, cfg, ch);
  return out;
}

/* ==========================================================================
   v2 additions: artefacts, the anaesthetic case timeline, and combinations.
   ========================================================================== */

// ---- artefacts ------------------------------------------------------------
// AR1/AR2/AR5 (Berger-Estilita 2026): EMG, electrode movement, electrical
// noise, eye movements; technical vs physiological.
// Levels are 0..1. Frontal channels see EMG and eye movement far more.
export function artefact(t, art, ch, st) {
  if (!art) return 0;
  let v = 0;
  const front = ch === 0 ? 1 : 0.3;

  // Frontalis EMG: broadband high frequency, tonic with phasic bursts.
  // PHYSIOLOGICAL. Suppressed by neuromuscular blockade, which is why it
  // moves a processed index without the brain changing.
  if (art.emg) {
    const burst = 0.45 + 0.55 * vnoise(41, t * 1.3);
    let e = 0;
    for (let k = 0; k < 9; k++) {
      const f = 21 + k * 4.3;
      e += Math.sin(2 * Math.PI * f * t + hash(k * 17) * 6.283) / Math.sqrt(9);
    }
    v += e * 46 * art.emg * burst * front;
  }

  // Mains interference: a single narrow line. TECHNICAL.
  if (art.mains) v += Math.sin(2 * Math.PI * (art.mainsHz || 50) * t) * 34 * art.mains;

  // Blinks and eye movement: large, slow, frontal. PHYSIOLOGICAL.
  if (art.eye) {
    const period = 3.6, dur = 0.34;
    const idx = Math.floor(t / period);
    const start = idx * period + (hash(idx + 83 * 7717) - 0.5) * period * 0.5;
    const u = (t - start) / dur;           // position WITHIN the blink, 0..1
    const shape = u >= 0 && u <= 1 ? Math.sin(Math.PI * u) : 0;
    v += shape * 105 * art.eye * front * (0.6 + 0.8 * hash(idx + 5));
  }

  // Electrode pop / movement: abrupt step with exponential decay plus drift.
  // TECHNICAL.
  if (art.pop) {
    const period = 6.5;
    const idx = Math.floor(t / period);
    const t0 = idx * period + hash(idx * 5.1) * period * 0.7;
    const u = t - t0;
    const sign = hash(idx * 9.7) > 0.5 ? 1 : -1;
    if (u >= 0 && u < 1.6) v += sign * 150 * art.pop * Math.exp(-u / 0.28);
    v += Math.sin(2 * Math.PI * 0.13 * t + 1.1) * 18 * art.pop;
  }
  return v;
}

// Illustrative signal quality. Real SQI algorithms are proprietary; this is a
// transparent stand-in so residents can watch quality fall as artefact rises.
export function signalQuality(buf, psd) {
  let mx = 0;
  for (let i = 0; i < buf.length; i++) mx = Math.max(mx, Math.abs(buf[i]));
  const tot = bandPower(psd, 0.5, 60);
  const hf = bandPower(psd, 30, 60) / Math.max(1e-9, tot);
  // narrow line anywhere 45-62 Hz relative to its neighbourhood
  let line = 0;
  for (const f of [50, 60]) {
    const i = Math.round(f / (FS / 512));
    const p = psd[i] || 0;
    const nb = ((psd[i - 6] || 0) + (psd[i + 6] || 0)) / 2 + 1e-9;
    line = Math.max(line, Math.min(1, Math.log10(p / nb) / 2));
  }
  const sat = Math.min(1, Math.max(0, (mx - 160) / 180));
  const q = 100 * (1 - Math.min(0.85, hf * 1.5)) * (1 - 0.8 * Math.max(0, line)) * (1 - 0.9 * sat);
  return Math.max(0, Math.min(100, q));
}

// ---- the case: baseline through emergence --------------------------------
// RW7/RW5 (Berger-Estilita 2026). Keyframes are component amplitudes in uV.
// Induction beta activation ("paradoxical excitation") and the alpha dropout
// at inadequate antinociception are both described in Purdon 2015 / Guay 2025.
const KEY = [
  { p: 0.00, n: "Baseline",        d: "Awake before induction. Record this — it is the comparison for everything after.", a: { occAlpha: 10, front18: 2.6, emg: 0.09, slow: 0, delta: 0, theta: 0, froAlpha: 0, beta: 0 } },
  { p: 0.11, n: "Induction",       d: "Beta activation as the drug arrives. Paradoxical excitation, not lightening.",     a: { occAlpha: 4, front18: 3, emg: 0.10, slow: 5, delta: 3, theta: 2, froAlpha: 0, beta: 15 } },
  { p: 0.21, n: "Loss of consciousness", d: "Beta collapses into slow-delta. Frontal alpha begins to build.",             a: { occAlpha: 1, front18: 1, emg: 0.03, slow: 22, delta: 10, theta: 3, froAlpha: 8, beta: 3 } },
  { p: 0.34, n: "Maintenance",     d: "Surgical depth. Slow-delta with a continuous frontal alpha.",                      a: { occAlpha: 0, front18: 0.5, emg: 0.01, slow: 32, delta: 14, theta: 1, froAlpha: 17, beta: 1 } },
  { p: 0.52, n: "Incision",        d: "Alpha drops out. Read it as nociception before you read it as lightening.",        a: { occAlpha: 0, front18: 1, emg: 0.03, slow: 26, delta: 12, theta: 3, froAlpha: 3, beta: 4 } },
  { p: 0.64, n: "Analgesia given", d: "Alpha returns without changing the hypnotic. That is the diagnostic test.",        a: { occAlpha: 0, front18: 0.5, emg: 0.01, slow: 32, delta: 14, theta: 1, froAlpha: 17, beta: 1 } },
  { p: 0.80, n: "Emergence",       d: "Slow-delta recedes, theta appears, the alpha weakens.",                            a: { occAlpha: 1, front18: 1.5, emg: 0.04, slow: 15, delta: 8, theta: 7, froAlpha: 9, beta: 3 } },
  { p: 0.91, n: "Light",           d: "Faster activity returns and EMG comes back with the muscles.",                     a: { occAlpha: 4, front18: 2.5, emg: 0.07, slow: 5, delta: 4, theta: 4, froAlpha: 3, beta: 7 } },
  { p: 1.00, n: "Awake",           d: "Back to the baseline you recorded. Compare them.",                                 a: { occAlpha: 10, front18: 2.6, emg: 0.09, slow: 0, delta: 0, theta: 0, froAlpha: 0, beta: 0 } },
];
export const CASE_KEYS = KEY;

export function casePhase(p) {
  let k = 0;
  for (let i = 0; i < KEY.length; i++) if (p >= KEY[i].p) k = i;
  return KEY[k];
}
export function caseState(p) {
  p = Math.max(0, Math.min(1, p));
  let i = 0;
  while (i < KEY.length - 2 && p > KEY[i + 1].p) i++;
  const A = KEY[i], B = KEY[i + 1];
  const u = B.p === A.p ? 0 : (p - A.p) / (B.p - A.p);
  const s = u * u * (3 - 2 * u);
  const m = (x) => A.a[x] + (B.a[x] - A.a[x]) * s;
  return {
    label: casePhase(p).n,
    comps: [
      { f: 0.8, amp: m("slow"), topo: "flat", mode: "sustained", band: "slow", shape: "slow" },
      { f: 2.2, amp: m("delta"), topo: "flat", mode: "sustained", band: "delta" },
      { f: 5.2, amp: m("theta"), topo: "front", mode: "sustained", band: "theta" },
      { f: 10.2, amp: m("froAlpha"), topo: "front", mode: "sustained", band: "alpha" },
      { f: 10.0, amp: m("occAlpha"), topo: "back", mode: "sustained", band: "alpha" },
      { f: 18.2, amp: m("front18"), topo: "flat", mode: "sustained", band: "beta" },
      { f: 21.5, amp: m("beta"), topo: "front", mode: "sustained", band: "beta" },
    ],
    noise: 2.0,
    emg: m("emg"),
  };
}

// ---- combinations (EF7) ---------------------------------------------------
// sourced: whether the morphology is described in the held literature or is a
// teaching interpolation. Stated on screen either way.
export const COMBOS = {
  "propofol+remifentanil": {
    label: "Propofol + remifentanil",
    sourced: true,
    note: "The opioid has no signature of its own at clinical dose. The picture is the propofol picture — reached at a lower propofol dose. What the EEG cannot show you is often what changed.",
    comps: STATES.propofol.comps, noise: 2.0, ageAlpha: true, ageSlow: true,
  },
  "propofol+ketamine": {
    label: "Propofol + ketamine",
    sourced: false,
    note: "Interpolated from the single-agent signatures: gamma bursts arrive on a propofol background and the alpha weakens. The combination itself is not separately characterised in the held sources.",
    comps: [
      { f: 0.8, amp: 30, topo: "flat", mode: "sustained", band: "slow", shape: "slow" },
      { f: 2.2, amp: 13, topo: "flat", mode: "sustained", band: "delta" },
      { f: 5.2, amp: 6, topo: "front", mode: "sustained", band: "theta" },
      { f: 10.2, amp: 9, topo: "front", mode: "sustained", band: "alpha" },
      { f: 28.0, amp: 8, topo: "front", mode: "burst", band: "gamma", period: 1.35, dur: 0.6 },
    ],
    noise: 2.2, ageAlpha: true, ageSlow: true,
  },
  "propofol+dexmedetomidine": {
    label: "Propofol + dexmedetomidine",
    sourced: false,
    note: "Interpolated: a continuous alpha and episodic spindles on the same record. Watch which of the two stripes is solid and which is broken.",
    comps: [
      { f: 0.85, amp: 30, topo: "flat", mode: "sustained", band: "slow", shape: "slow" },
      { f: 2.3, amp: 13, topo: "flat", mode: "sustained", band: "delta" },
      { f: 10.2, amp: 13, topo: "front", mode: "sustained", band: "alpha" },
      { f: 13.0, amp: 12, topo: "front", mode: "spindle", band: "sigma" },
    ],
    noise: 2.0, ageAlpha: true, ageSlow: true,
  },
  "sevoflurane+n2o": {
    label: "Sevoflurane + nitrous oxide",
    sourced: false,
    note: "Qualitative only. Nitrous oxide is known not to suppress the EEG in the typical way — slow-delta falls and high-frequency activity rises. Magnitudes here are chosen, not measured.",
    comps: [
      { f: 0.8, amp: 17, topo: "flat", mode: "sustained", band: "slow", shape: "slow" },
      { f: 2.2, amp: 8, topo: "flat", mode: "sustained", band: "delta" },
      { f: 4.9, amp: 10, topo: "front", mode: "sustained", band: "theta" },
      { f: 9.8, amp: 10, topo: "front", mode: "sustained", band: "alpha" },
      { f: 24.0, amp: 7, topo: "front", mode: "sustained", band: "beta" },
      { f: 31.0, amp: 5, topo: "front", mode: "sustained", band: "gamma" },
    ],
    noise: 2.6, ageAlpha: true, ageSlow: true,
  },
};

/* ==========================================================================
   v3 additions: named waveform elements (transients), defined by DURATION.

   Duration is what separates these from one another and from the rhythms, so
   the DECLARED duration is what the waveform actually measures on screen: each
   shape is time-scaled by its own 20%-of-peak span, and a gate measures it back
   out of the generated signal.

   Signals are in PHYSIOLOGICAL polarity (negative is negative). The display
   applies the negative-up convention, which is why an asymmetric waveform looks
   different on a system that draws positive-up.
   ========================================================================== */

const gauss = (u, c, w) => Math.exp(-(((u - c) / w) ** 2));

export const TRANSIENTS = {
  kcomplex: {
    label: "K-complex", dur: 0.90, amp: 118, topo: "front", sourced: false,
    note: "A sharp negative component followed by a slower positive one, frontally maximal, and long. The usual criterion is at least 0.5 s — an AASM scoring definition, not in any source held here.",
    f: (u) => -1.00 * gauss(u, 0.26, 0.115) + 0.58 * gauss(u, 0.60, 0.175) - 0.09 * gauss(u, 0.88, 0.12),
  },
  vertex: {
    label: "Vertex sharp wave", dur: 0.14, amp: 78, topo: "front", sourced: false,
    note: "A single sharp negative transient, six times shorter than a K-complex. Sharpness is duration, not steepness of drawing — which is why you measure it rather than eyeball it. The duration range is clinical convention and is not in any source held here.",
    f: (u) => -gauss(u, 0.5, 0.19),
  },
  spindleRun: {
    label: "Sleep spindle", dur: 0.80, amp: 34, topo: "front", osc: 13.0, sourced: false,
    note: "Not a transient but a RUN of oscillation, 11-16 Hz, conventionally at least 0.5 s. Beside a K-complex the difference between an element and a rhythm becomes obvious.",
    env: (u) => gauss(u, 0.5, 0.30),
    f: (u) => gauss(u, 0.5, 0.30),
  },
  slowWave: {
    label: "Slow wave", dur: 0.45, amp: 92, topo: "flat", sourced: true, measures: "down-state",
    note: "One cycle of the slow-delta rhythm, alone. The figure measured here is the DOWN-STATE, not the whole cycle — Guay 2025 gives down-states of 0.25 to 2 s. The down-state is sharper than the up-state, and that asymmetry is physiology rather than rendering.",
    f: (u) => -1.0 * gauss(u, 0.32, 0.135) + 0.55 * gauss(u, 0.72, 0.20),
  },
};

// Each shape is time-scaled so that its measured 20%-of-peak span equals the
// duration it declares. Computed once at load.
function solveWindow(spec) {
  const FSX = FS * 4;                       // oversample so the solve is not quantised
  spec.window = spec.dur;
  for (let iter = 0; iter < 12; iter++) {
    const pad = spec.window;
    const n = Math.round((spec.window + 2 * pad) * FSX);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const dt = i / FSX - pad;
      const u = dt / spec.window;
      if (u < 0 || u > 1) continue;
      v[i] = (spec.osc ? Math.sin(2 * Math.PI * spec.osc * dt) * spec.env(u) : spec.f(u)) * spec.amp;
    }
    const m = measureTransient(v, FSX);
    if (!m.dur) break;
    const err = (m.dur - spec.dur) / spec.dur;
    if (Math.abs(err) < 0.005) break;
    spec.window *= spec.dur / m.dur;
  }
}
for (const k of Object.keys(TRANSIENTS)) solveWindow(TRANSIENTS[k]);

function transientAt(spec, dt, ch, scale = 1) {
  const u = dt / spec.window;
  if (u < 0 || u > 1) return 0;
  const shape = spec.osc ? Math.sin(2 * Math.PI * spec.osc * dt) * spec.env(u) : spec.f(u);
  return shape * spec.amp * scale * chGain(spec.topo, ch);
}

// One named element, repeating at `period` seconds on whatever is running.
export function transient(t, cfg, ch) {
  const spec = cfg.transient && TRANSIENTS[cfg.transient.kind];
  if (!spec) return 0;
  const period = cfg.transient.period ?? 3.0;
  const idx = Math.floor(t / period);
  return transientAt(spec, t - (idx * period + period * 0.3), ch);
}

// NREM 2 carries K-complexes. The flag sat on the state object from the first
// build and nothing ever read it.
export function stateTransient(t, st, ch) {
  if (!st.kcomplex) return 0;
  const K = TRANSIENTS.kcomplex;
  const idx = Math.floor(t / 7.0);
  return transientAt(K, t - (idx * 7.0 + hash(idx * 2.9) * 4.5), ch, 0.60);
}

// Measure an element back out of a record: peak amplitude, and the duration of
// the excursion at 20% of peak, which approximates measuring at the base.
export function envelope(sig, fs = FS, win = 0.05) {
  const w = Math.max(1, Math.round(win * fs));
  const out = new Float64Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    let m = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(sig.length - 1, i + w); j++) m = Math.max(m, Math.abs(sig[j]));
    out[i] = m;
  }
  return out;
}

export function measureTransient(sig, fs = FS) {
  const env = envelope(sig, fs);
  let pk = 0, pi = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > pk) { pk = env[i]; pi = i; }
  if (pk < 8) return { amp: 0, dur: 0, peakAt: 0 };
  const thr = 0.2 * pk;
  let a = pi, b = pi;
  while (a > 0 && env[a] > thr) a--;
  while (b < env.length - 1 && env[b] > thr) b++;
  return { amp: pk, dur: (b - a) / fs, peakAt: pi / fs };
}

/* ==========================================================================
   v4: the frequency bands, one at a time.

   Every other state here is a mixture of three to six components, so no
   resident can ever have seen a single band alone. Amplitudes fall as
   frequency rises, which is the 1/f character of real EEG and the reason a
   fixed gain flattens the fast bands.
   ========================================================================== */

export const BAND_DEMO = {
  slow:  { label: "Slow · 0.6 Hz",  band: "slow",  lo: 0.1, hi: 1,  f: 0.6,  amp: 58, shape: "slow",
           note: "Below 1 Hz. The largest and slowest thing on the record, and the band that grows most as anaesthesia deepens." },
  delta: { label: "Delta · 2 Hz",   band: "delta", lo: 1,   hi: 4,  f: 2.0,  amp: 42, shape: "slow",
           note: "1 to 4 Hz. Dominant under general anaesthesia and in deep sleep. In infants it dominates the record at baseline." },
  theta: { label: "Theta · 6 Hz",   band: "theta", lo: 4,   hi: 8,  f: 6.0,  amp: 26,
           note: "4 to 8 Hz. Sevoflurane's extra stripe against propofol, and it reappears during emergence." },
  alpha: { label: "Alpha · 10 Hz",  band: "alpha", lo: 8,   hi: 12, f: 10.0, amp: 20,
           note: "8 to 12 Hz. The band that moves: occipital when awake with eyes closed, frontal under a GABA-A anaesthetic." },
  beta:  { label: "Beta · 18 Hz",   band: "beta",  lo: 13,  hi: 25, f: 18.0, amp: 11,
           note: "13 to 25 Hz. Rises at induction before consciousness is lost — paradoxical excitation — and in light anaesthesia." },
  gamma: { label: "Gamma · 32 Hz",  band: "gamma", lo: 25,  hi: 45, f: 32.0, amp: 6,
           note: "Above 25 Hz. On a forehead channel a large part of it is frontalis muscle rather than cortex. Ketamine is the anaesthetic that puts real gamma there." },
};

for (const k of Object.keys(BAND_DEMO)) {
  const b = BAND_DEMO[k];
  b.comps = [{ f: b.f, amp: b.amp * 1.25, topo: "flat", mode: "waxing", band: b.band, shape: b.shape }];
  b.noise = 0.45;
}
