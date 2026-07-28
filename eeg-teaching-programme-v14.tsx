import React, { useState, useEffect, useRef, useCallback } from "react";

/* ==========================================================================
   Reading the EEG — a teaching instrument for anaesthesia residents.

   Modules are mapped to the learning outcomes in Berger-Estilita et al.,
   Eur J Anaesthesiol 2026;43:1-12 (ESAIC Delphi consensus). Codes shown
   on each module are that paper's item codes.

   All waveforms are SYNTHESISED from published parameters, not patient data.
   ========================================================================== */

const C = {
  ground: "#14161A",
  panel: "#1C2027",
  panel2: "#22272F",
  rule: "#2C323B",
  ink: "#EFE9DC",
  dim: "#98A0AA",
  brass: "#C2913F",
  trace: "#F2ECE0",
  warn: "#D97066",
  ok: "#6FA98A",
};

const SERIF = "'Newsreader', Georgia, 'Times New Roman', serif";
const SANS = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace";

/* ===================== signal engine ======================================
   Verified byte-identical to engine.mjs, the reference that passes the
   55-gate suite (gates.mjs + gates2.mjs). Do not edit here — edit the
   reference, re-run the gates, and re-extract.
   ========================================================================= */

const FS = 128;

const BANDS = {
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
function alphaAge(age) {
  if (age < 0.35) return 0.0;
  if (age < 1) return 0.35 * (age - 0.35) / 0.65;
  if (age < 7) return 0.35 + 0.65 * (age - 1) / 6;
  return Math.max(0.12, 1.0 - 0.88 * Math.min(1, (age - 7) / 83));
}
// Markus 2026: delta predominates in every age group in the awake state before
// induction, with the difference from adults greatest in infants. Modelled as a
// factor that falls away through childhood.
function awakeDeltaAge(age) {
  if (age < 0.5) return 1.0;
  if (age < 8) return 1.0 - 0.85 * (age - 0.5) / 7.5;
  return Math.max(0.06, 0.15 - 0.09 * Math.min(1, (age - 8) / 20));
}

// Guay 2025: slow-delta about 30-40 uV in a younger adult vs 10-20 uV at 89 yr.
function slowAge(age) {
  if (age < 2) return 1.15;
  if (age < 25) return 1.15 - 0.15 * (age - 2) / 23;
  return Math.max(0.4, 1.0 - 0.6 * (age - 25) / 65);
}

// ---- state definitions ----------------------------------------------------
// amp values are uV (peak amplitude of that component before channel gain)
const STATES = {
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
function makeEngine(seed = 3) {
  let n1 = 0, n2 = 0, n3 = 0; // pink-ish filter state
  // returns uV sample at time t (s) for channel ch (0 frontal, 1 occipital)
  return function sample(t, cfg, ch) {
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
  };
}

// burst-suppression gate: 1 during a burst, 0 during suppression, soft edges.
function bsGate(t, bsr) {
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
function fft(re, im) {
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
function spectrum(seg, nfft = 512, K = 3) {
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

function bandPower(psd, lo, hi, nfft = 512, fs = FS) {
  const df = fs / nfft;
  let s = 0;
  for (let i = Math.max(1, Math.round(lo / df)); i <= Math.round(hi / df) && i < psd.length; i++) s += psd[i];
  return s;
}

// Spectral edge frequency: f below which `frac` of total power (0.1-30 Hz) lies.
function sefBand(psd, frac = 0.95, nfft = 512, fs = FS, top = 45) {
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
function measuredBSR(sig, fs = FS) {
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
function sustain(sig, lo, hi, fs = FS) {
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


/* ==========================================================================
   v2 additions: artefacts, the anaesthetic case timeline, and combinations.
   ========================================================================== */

// ---- artefacts ------------------------------------------------------------
// AR1/AR2/AR5 (Berger-Estilita 2026): EMG, electrode movement, electrical
// noise, eye movements; technical vs physiological.
// Levels are 0..1. Frontal channels see EMG and eye movement far more.
function artefact(t, art, ch, st) {
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
function signalQuality(buf, psd) {
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
const CASE_KEYS = KEY;

function casePhase(p) {
  let k = 0;
  for (let i = 0; i < KEY.length; i++) if (p >= KEY[i].p) k = i;
  return KEY[k];
}
function caseState(p) {
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
const COMBOS = {
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

const TRANSIENTS = {
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
function transient(t, cfg, ch) {
  const spec = cfg.transient && TRANSIENTS[cfg.transient.kind];
  if (!spec) return 0;
  const period = cfg.transient.period ?? 3.0;
  const idx = Math.floor(t / period);
  return transientAt(spec, t - (idx * period + period * 0.3), ch);
}

// NREM 2 carries K-complexes. The flag sat on the state object from the first
// build and nothing ever read it.
function stateTransient(t, st, ch) {
  if (!st.kcomplex) return 0;
  const K = TRANSIENTS.kcomplex;
  const idx = Math.floor(t / 7.0);
  return transientAt(K, t - (idx * 7.0 + hash(idx * 2.9) * 4.5), ch, 0.60);
}

// Measure an element back out of a record: peak amplitude, and the duration of
// the excursion at 20% of peak, which approximates measuring at the base.
function envelope(sig, fs = FS, win = 0.05) {
  const w = Math.max(1, Math.round(win * fs));
  const out = new Float64Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    let m = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(sig.length - 1, i + w); j++) m = Math.max(m, Math.abs(sig[j]));
    out[i] = m;
  }
  return out;
}

function measureTransient(sig, fs = FS) {
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

const BAND_DEMO = {
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

/* ---- analysis constants used by the display ------------------------------
   These must match the defaults inside the engine's spectrum(): nfft 512 and
   3 sine tapers over a 3 s window. Passed explicitly at the call site below so
   the display and the gate suites provably analyse the same way.            */
const NFFT = 512;
const WIN_N = 384;          // 3 s at FS = 128
const DF = FS / NFFT;       // 0.25 Hz per bin

/* ===================== colour maps ======================================== */

function jet(v) {
  const x = Math.max(0, Math.min(1, v)) * 4;
  const r = Math.max(0, Math.min(1, Math.min(x - 1.5, 4.5 - x)));
  const g = Math.max(0, Math.min(1, Math.min(x - 0.5, 3.5 - x)));
  const b = Math.max(0, Math.min(1, Math.min(x + 0.5, 2.5 - x)));
  return [r * 255, g * 255, b * 255];
}
const VIR = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
];
function viridis(v) {
  const x = Math.max(0, Math.min(0.999, v)) * (VIR.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = VIR[i], b = VIR[i + 1] || VIR[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/* ===================== references ========================================= */

const REFS = {
  esaic: {
    s: "Berger-Estilita 2026", ok: true,
    full: "Berger-Estilita, Baron Shahaf, Barreto Chang, and 30 others (Absalom, senior author). Consensus document on electroencephalography education in anaesthesiology: defining learning outcomes. A modified four-round Delphi study. Eur J Anaesthesiol 2026;43:1-12. Modified four-round eDelphi, 33 experts across 17 countries, 100% response every round, consensus set at 80% rating 9 or 10. 58 outcomes accepted from 191 candidates.",
    doi: "10.1097/EJA.0000000000002346",
    note: "Learning outcomes only. No assessment standard, no proficiency bar, no mapping to training year. The paper states it did not validate whether achieving the outcomes improves decision-making or outcomes, and did not assess implementation feasibility.",
  },
  guay: {
    s: "Guay 2025", ok: true,
    full: "Guay, Agrawal, Tseng, Gallo, Schreier, Brown. Clinical EEG for anesthesiologists and intensivists, part 2: physiologic signatures and active management. Anesthesiology 2025;143:1595-1618.",
    doi: "10.1097/ALN.0000000000005739",
  },
  purdon15: {
    s: "Purdon 2015", ok: true,
    full: "Purdon, Sampson, Pavone, Brown. Clinical electroencephalography for anesthesiologists, part I: background and basic signatures. Anesthesiology 2015;123(4):937-960.",
    doi: "10.1097/ALN.0000000000000841",
  },
  prerau: {
    s: "Prerau 2017", ok: true,
    full: "Prerau, Brown, Bianchi, Ellenbogen, Purdon. Sleep neurophysiological dynamics through the lens of multitaper spectral analysis. Physiology (Bethesda) 2017;32:60-92. Cohort of 10 healthy adults aged 19-32, so young-adult normative.",
    doi: "10.1152/physiol.00062.2015",
  },
  akeju14s: {
    s: "Akeju 2014a", ok: true,
    full: "Akeju et al. Effects of sevoflurane and propofol on frontal EEG power and coherence. Anesthesiology 2014;121(5):990-998. n=30 vs 30; sevoflurane theta coherence peak 4.9 +/- 0.6 Hz.",
    doi: "",
  },
  akeju14d: {
    s: "Akeju 2014b", ok: true,
    full: "Akeju et al. A comparison of propofol- and dexmedetomidine-induced electroencephalogram dynamics. Anesthesiology 2014;121:978-989.",
    doi: "",
  },
  akeju16: {
    s: "Akeju 2016", ok: true,
    full: "Akeju et al. Electroencephalogram signatures of ketamine anesthesia-induced unconsciousness. Clin Neurophysiol 2016;127(6):2414-2422. n=12 retrospective; gamma about 27-40 Hz alternating with slow-delta; alpha and beta decreased. Most patients also received midazolam and fentanyl.",
    doi: "",
  },
  ab17: {
    s: "Akeju & Brown 2017", ok: true,
    full: "Akeju, Brown. Neural oscillations demonstrate that general anesthesia and sedative states are neurophysiologically distinct from sleep. Curr Opin Neurobiol 2017;44:178-185.",
    doi: "",
  },
  purdon13: {
    s: "Purdon 2013", ok: false,
    full: "Purdon et al. Electroencephalogram signatures of loss and recovery of consciousness from propofol. PNAS 2013. Source of the anterior alpha shift.",
    doi: "",
    note: "Cited second-hand through Purdon 2015 and Guay 2025. Primary text not held — verify before teaching.",
  },
  markus: {
    s: "Markus 2026", ok: true,
    full: "Markus, Panagiotou, Spies, Koch. EEG dynamics in children before, during and after general anaesthesia. Pediatric Anesthesia 2026;36:641-649. Open access. 147 frontal EEGs, 1 month to 8 years, Narcotrend, Charité Berlin; age groups 0-5 mo (n=6), 6-11 (n=18), 12-23 (n=29), 24+ (n=94). Bands used differ from this programme's: delta 0.5-3.5, theta 3.5-7.5, alpha 7.5-12.5, beta 12.5-30 Hz.",
    doi: "10.1002/pan.70156",
  },
  yoon: {
    s: "Yoon 2025", ok: true,
    full: "Yoon, Park, Kang, Jang, Kim, Lee, Lee, Kim, Kim, Ji. Electroencephalography and anaesthetic depth in children under 2 years of age: a prospective observational study. Pediatric Anesthesia 2025;35:294-301. 50 children aged 4-24 months, sevoflurane, BIS and PSi recorded simultaneously with raw EEG.",
    doi: "10.1111/pan.15058",
  },
  derylo: {
    s: "Derylo 2026", ok: true,
    full: "Derylo, Sannasi, Rosamystica, Pilia. Efficacy of bispectral index-guided sevoflurane administration in paediatric patients: an up-to-date systematic review and meta-analysis. Pediatric Anesthesia 2026;36:164-172. Nine RCTs, 730 patients. CHILDREN UNDER 2 YEARS WERE EXPLICITLY EXCLUDED; 2-4 year olds included despite BIS not being formally validated below 4.",
    doi: "10.1111/pan.70080",
  },
  bong: {
    s: "Bong & Yuan 2026", ok: true,
    full: "Bong, Yuan. The utility of electroencephalography in guiding general anaesthesia in children. Anesth Analg 2026;142:1155-1168. Narrative review with an age-stratified reliability table and SEF95 targets. Yuan declares a consulting fee and research grant from Masimo.",
    doi: "10.1213/ANE.0000000000007230",
  },
  paeds: {
    s: "Paediatric set", ok: false,
    full: "Long 2022 (RCT, sevoflurane requirements under EEG guidance) and Kratzer & Davidson 2025 remain without full citation strings. Yoon, Markus, Derylo and Bong & Yuan are now held in full and cited separately.",
    doi: "",
    note: "Two of the original five still need completing before teaching.",
  },
  convention: {
    s: "Display convention", ok: false,
    full: "Clinical EEG is traditionally displayed with negative deflections upward, and channel labels name a derivation — the difference between two electrodes — rather than a location.",
    doi: "",
    note: "Not stated in any source held here. Confirm how your own monitors and EEG systems draw polarity before teaching it.",
  },
  interp: {
    s: "Teaching interpolation", ok: false,
    full: "Morphology built from the single-agent signatures rather than measured for the combination itself.",
    doi: "",
    note: "Not a literature finding. Use it to teach the principle, not the picture.",
  },
};

/* ===================== ESAIC framework coverage =========================== */
/* status: 2 = covered, 1 = partly covered, 0 = out of scope                  */

const FRAMEWORK = [
  ["Basic", "EEG Fundamentals", [
    ["FD1", "Describe the basic principles of EEG", 2, "02, 04"],
    ["FD2", "Describe the neurophysiological basis of EEG signals", 2, "02, 04"],
    ["FD3", "Explain why EEG monitoring is applied in anaesthesia", 2, "01"],
    ["FD4", "Proficiency in correct application of EEG electrodes", 0, "Needs a monitor and a head"],
    ["FD5", "Identify and troubleshoot common technical issues", 1, "05"],
    ["FD8", "Name the clinical indications for EEG monitoring", 2, "01"],
    ["FD12", "Identify and recognise basic EEG patterns", 2, "06–11"],
    ["FD13", "Relationship between EEG signatures and clinical effects", 2, "08, 10"],
    ["FD14", "EEG hardware: electrodes, impedance, filters", 1, "04 — filter conventions only; electrodes and impedance need a monitor"],
    ["FD19", "Importance of recognising basic patterns", 2, "01"],
  ]],
  ["Basic", "Raw EEG", [
    ["RW4", "Identify and explain fundamental raw EEG patterns", 2, "04, 06–08"],
    ["RW5", "Transition from wakefulness to deep anaesthesia: amplitude and peak frequency", 2, "10, 11"],
    ["RW7", "Raw EEG across induction, maintenance and emergence, including baseline", 2, "10"],
    ["RW11", "Recognise and differentiate spike and burst suppression patterns", 1, "11 — burst suppression only, not spikes"],
    ["RW12", "Identify raw EEG changes with different anaesthetic agents", 2, "08, 09"],
    ["RW13", "Feasibility of staging anaesthesia on raw EEG: awake, alpha-delta, burst suppression", 2, "06, 08, 11"],
  ]],
  ["Basic", "Anaesthetic effects on the EEG", [
    ["EF1", "How agent classes produce distinct EEG signatures", 2, "08"],
    ["EF7", "Single-agent signatures against multimodal anaesthesia and drug combinations", 2, "09"],
  ]],
  ["Basic", "(Semi-)Processed EEG", [
    ["PR2", "Interpret and use pEEG to guide anaesthesia management", 2, "12, 14"],
    ["PR3", "Principles of spectral analysis and the density spectral array", 2, "02"],
    ["PR4", "Read and interpret spectral analysis rather than index construction", 2, "02, 12"],
    ["PR5", "Strengths and limitations of pEEG against raw EEG", 2, "12"],
    ["PR6", "Relevance of SEF, EMG, BSR and Signal Quality Index", 2, "05, 11, 12"],
    ["PR14", "Critique EEG indices and their risk of misinterpretation", 2, "12"],
  ]],
  ["Basic", "Artefacts", [
    ["AR1", "Identify common artefacts: EMG, electrode movement, electrical noise, eye movement", 2, "05"],
    ["AR2", "Differentiate artefacts from genuine EEG signals", 2, "05"],
    ["AR3", "Proficiency in recognising and mitigating artefacts during monitoring", 1, "05 — recognition only; mitigation needs the machine"],
    ["AR5", "Distinguish technical from physiological artefacts", 2, "05"],
  ]],
  ["Basic", "Nociception", [
    ["NC11", "Recognise nociception-related EEG patterns and their significance", 2, "10"],
    ["NC12", "Interpret alpha drop-out alongside other clinical signs", 2, "10, 14"],
  ]],
  ["Basic", "Patient variability", [
    ["PV1", "Variations in specific populations: older adults, paediatric", 2, "13"],
    ["PV2", "How age-related and developmental differences affect monitoring", 2, "13"],
    ["PV3", "Adjust management based on patient-specific EEG variation", 1, "13, 14"],
    ["PV6", "Individual variability beyond age", 1, "13 — named, not modelled"],
    ["PV8", "Frequency-band power and frontal alpha waves", 2, "02, 07"],
    ["PV10", "Outcomes associated with burst suppression", 1, "11 — association stated, evidence not taught in depth"],
    ["PV11", "Identify high-risk patients for PND by pre- or intra-operative EEG", 1, "13"],
  ]],
  ["Basic", "Integration with anaesthetic management", [
    ["AM1", "How EEG monitoring integrates with overall management", 2, "14"],
    ["AM2", "Role of EEG in preventing over-sedation or inadequate anaesthesia", 2, "01, 14"],
    ["AM3", "Communicate EEG findings to the team to inform decisions", 2, "14"],
  ]],
  ["Basic", "Clinical immersion", [
    ["CI1", "Clinical immersion, including video-based scenarios of real EEG", 0, "Needs real recordings"],
    ["CI2", "Use video and pictures from real clinical scenarios", 0, "Needs real recordings"],
    ["CI5", "Use quizzes to reinforce learning", 2, "Drill mode"],
  ]],
  ["Basic", "Continuous professional learning", [
    ["PL1", "Commitment to continuous learning and staying updated", 1, "Sources panel"],
    ["PL3", "Foster an interest in EEG monitoring", 2, "Whole programme"],
    ["PL4", "Establish continuing update sessions", 0, "Departmental, not an app feature"],
  ]],
  ["Advanced", "Advanced EEG concepts", [
    ["AC7", "Identify epileptiform activity", 0, "Not modelled"],
  ]],
  ["Advanced", "In-depth analysis of EEG patterns", [
    ["AN1", "Define spindle characteristics: frequency, amplitude, typical locations", 2, "06, 08"],
    ["AN4", "Proficiency in visually identifying spindles", 2, "06, 08, Drill"],
    ["AN12", "Clarify the terminological difference between spindle activity and alpha power", 2, "07"],
  ]],
  ["Advanced", "Quantitative EEG analysis", [
    ["QT1", "Limitations and biases of quantitative EEG metrics", 2, "12"],
  ]],
  ["Advanced", "Research, mentorship, lifelong learning", [
    ["RI1", "Engage with current research literature", 0, "Not an EEG competency"],
    ["RI8", "Support international collaborations in EEG research", 0, "Not an EEG competency"],
    ["MT1", "Mentor colleagues in advanced EEG concepts", 0, "Not an EEG competency"],
    ["MT2", "Develop and deliver advanced EEG educational content", 0, "Not an EEG competency"],
    ["MT4", "Strive for high-quality mentorship and teaching", 0, "Not an EEG competency"],
    ["LL2", "Foster interdisciplinary collaboration", 0, "Not an EEG competency"],
    ["LL6", "Launch knowledge-spreading projects", 0, "Not an EEG competency"],
  ]],
];

/* ===================== curriculum ========================================= */

const MODULES = [
  {
    n: "01", id: "why", title: "Why look at all", mins: 5,
    codes: ["FD3", "FD8", "FD19", "AM2"],
    aim: "Know what the EEG adds that no other monitor gives you, and when to reach for it.",
    points: [
      { t: "Every other organ has a monitor that reads the organ. The brain is the target of the drug, and for most of a case we infer its state from blood pressure, heart rate and end-tidal agent. The EEG reads the target.", r: "guay", cfg: { state: "propofol" }, look: "Nothing on this display is derived from a haemodynamic variable." },
      { t: "The old case for monitoring was preventing awareness. The current case is avoiding excess: unnecessarily deep anaesthesia, particularly in older and frailer patients.", r: "esaic", cfg: { state: "propofol", bsr: 0.5 }, look: "This record is not light. It is far too deep, and the blood pressure will not tell you." },
      { t: "Two patients on the same dose of the same drug can sit in different states. Dose is an input. The EEG is an output.", r: "guay", cfg: { state: "propofol", age: 82 }, look: "Same propofol, an 82-year-old. Compare the amplitude with a 30-year-old on the same dose in Age changes the picture." },
      { t: "Reaching for it is cheap. Not reading it is the expensive part, and that is what this programme is for.", r: "esaic", cfg: { state: "propofol" }, look: "" },
    ],
    prompt: "Ask the group: in the last month, name one case where you would have changed something if you had been reading the EEG.",
  },
  {
    n: "02", id: "displays", title: "The two displays", mins: 7,
    codes: ["FD1", "FD2", "PR3", "PR4", "PV8"],
    aim: "Read a trace and a density spectral array together, and know which question each answers.",
    points: [
      { t: "The trace answers what is happening now. The spectrogram — the density spectral array on most monitors — answers what has been happening. Neither replaces the other.", r: "guay", cfg: { state: "awake" }, look: "The two lanes move at different speeds. That is the point of having both." },
      { t: "On the DSA, frequency runs up the side, time runs across, and colour is how much of each rhythm is present. Nothing else is encoded.", r: "guay", cfg: { state: "propofol" }, look: "The band near 10 Hz is frontal alpha. The heat along the bottom is slow-delta." },
      { t: "The signal is the summed post-synaptic activity of cortical neurons under the electrode, filtered by skull and scalp. It is cortex you are reading, and mostly the cortex nearest the sensor.", r: "purdon15", cfg: { state: "propofol" }, look: "Which is why where the sensor sits decides what you can see. Where the alpha is takes that further." },
      { t: "Amplitude changes five to twenty times between states. A fixed gain flattens most of them, so the µV readout matters as much as the shape.", r: "guay", cfg: { state: "awake" }, look: "Switch to propofol and watch the peak-to-peak number, not just the picture." },
      { t: "Bands used here: slow below 1 Hz, delta 1 to 4, theta 4 to 8, alpha 8 to 12, beta 13 to 25, gamma above 25.", r: "guay", cfg: { state: "propofol" }, look: "Other papers set slightly different edges. Say which you are using." },
    ],
    prompt: "Ask the group: on your own monitor, which display do you actually look at during a case, and what does that cost you?",
  },
  {
    n: "03", id: "bands", title: "The frequency bands", mins: 13,
    codes: ["FD1", "PV8", "PR3", "RW4"],
    aim: "Meet alpha, beta, theta, delta, slow and gamma one at a time, before meeting them mixed together.",
    points: [
      { t: "The vertical axis of the DSA is frequency, so the bands are how you read it. Every state in this programme is a mixture of three to six of them. Here is one at a time, which is something you will never see in a patient.", r: "guay", cfg: { band: "alpha", window: 4, scale: 200 }, ctrl: "band", look: "Tap through the six. Watch the trace change speed and the DSA stripe move up the axis. Each is one oscillator waxing and waning — real rhythms are messier than this, and no patient produces one band alone." },
      { t: "Slow, below 1 Hz. The largest and slowest thing on the record, and the band that grows most as anaesthesia deepens.", r: "guay", cfg: { band: "slow", window: 6, scale: 300 }, ctrl: "band", look: "About 120 µV peak to peak here. Nothing else on the record is this big." },
      { t: "Delta, 1 to 4 Hz. Dominant under general anaesthesia and in deep sleep. In the youngest infants it dominates the record at baseline, which is why an index built for adults misreads them.", r: "guay", cfg: { band: "delta", window: 5, scale: 260 }, ctrl: "band", look: "Two cycles a second. Count them against the one-second gridlines." },
      { t: "Theta, 4 to 8 Hz. This is sevoflurane's extra stripe against propofol, and it reappears during emergence.", r: "akeju14s", cfg: { band: "theta", window: 4, scale: 180 }, ctrl: "band", look: "Akeju 2014 puts the sevoflurane coherence peak at 4.9 Hz, near the bottom of this band." },
      { t: "Alpha, 8 to 12 Hz. The band that moves — occipital when awake with the eyes closed, frontal under a GABA-A anaesthetic. Most of this programme is about that one fact.", r: "purdon15", cfg: { band: "alpha", window: 4, scale: 160 }, ctrl: "band", look: "Ten cycles a second. This is the rhythm you will be asked to find most often." },
      { t: "Beta, 13 to 25 Hz. Rises at induction before consciousness is lost, which is paradoxical excitation rather than lightening, and again in light anaesthesia.", r: "purdon15", cfg: { band: "beta", window: 3, scale: 120 }, ctrl: "band", look: "Narrow the window to see individual cycles. It is already hard to count." },
      { t: "Gamma, above 25 Hz. On a forehead channel a large part of it is frontalis muscle rather than cortex. Ketamine is the anaesthetic that puts real cortical gamma there.", r: "guay", cfg: { band: "gamma", window: 2, scale: 90 }, ctrl: "band", look: "At this speed the trace looks like noise. That is why the DSA exists." },
      { t: "Amplitude falls as frequency rises — around 120 µV for slow against 12 µV for gamma, a factor of ten. That is the 1/f character of the EEG, and it is why one fixed gain cannot show you every band at once.", r: "guay", cfg: { band: "gamma", window: 4, scale: 300 }, ctrl: "band", look: "Leave the scale at 300 µV and step from slow to gamma. The fast bands vanish." },
      { t: "Frequency and duration are two ways of saying the same thing: 10 Hz is 100 ms a cycle, 2 Hz is 500 ms. Wave morphology and nomenclature measures in milliseconds, and this is the bridge to it.", r: "guay", cfg: { band: "alpha", window: 4, scale: 160 }, ctrl: "band", look: "One alpha cycle is 100 ms. A vertex sharp wave is 140 ms — barely longer than a single alpha cycle." },
      { t: "The edges are conventions and they disagree. Purdon's Part I table put alpha at 9 to 12; Guay's Part 2 uses 8 to 12, which is what this programme uses. Sleep work adds sigma at 12 to 15. Markus, in the paediatric data this programme now uses, sets delta 0.5 to 3.5, theta 3.5 to 7.5, alpha 7.5 to 12.5. Say which set you mean.", r: "purdon15", cfg: { band: "alpha", window: 4, scale: 160 }, ctrl: "band", look: "This matters when you compare a number from one paper with a number from another." },
      { t: "Last, a distinction that gets lost. A delta wave is any wave in the delta band. A slow wave is a specific morphology with a sharper down-state. The first is a frequency claim, the second is a shape claim, and they are not interchangeable.", r: "guay", cfg: { band: "delta", window: 6, scale: 260 }, ctrl: "band", look: "Wave morphology and nomenclature is where shape gets its own vocabulary." },
    ],
    prompt: "Ask the group: name the band you would look at first for depth, for nociception, and for artefact. Three different answers.",
  },
  {
    n: "04", id: "describe", title: "Wave morphology and nomenclature", mins: 16,
    codes: ["FD1", "FD2", "FD14", "RW4", "PV8"],
    aim: "Acquire the vocabulary for describing a record you cannot yet name — which is most records, most of the time.",
    points: [
      { t: "Four questions describe any segment of EEG: how fast, how big, how regular, and where. Answer those and you have described it without naming it. Naming comes second, and it depends on this.", r: "purdon15", cfg: { state: "propofol" }, look: "Try it on this record before reading on. Fast or slow, big or small, steady or intermittent, front or back." },
      { t: "How fast: count cycles per second. A narrow window makes counting easy; a wide one shows you rhythm and shape instead. Both are the same signal at different magnifications.", r: "guay", cfg: { state: "awake", ch: 1, window: 2 }, ctrl: "display", look: "Set the window to 2 s and count the peaks in one second. Ten of them is alpha." },
      { t: "How big: peak-to-peak amplitude in microvolts. The readout is the fact; the picture is a setting. Change the vertical scale and the same signal looks entirely different.", r: "guay", cfg: { state: "propofol", scale: 200 }, ctrl: "display", look: "Drag the scale from 500 down to 60 µV. The trace transforms. The µV number does not move." },
      { t: "How regular: continuous, intermittent, or episodic. This is the discriminator the rest of the programme leans on hardest, and it is invisible in a snapshot — it takes a few seconds of watching.", r: "akeju14d", cfg: { state: "dexmedetomidine" }, look: "The 13 Hz activity here arrives and leaves. The propofol alpha in Four agents, four signatures does not." },
      { t: "Morphology is shape, and shape is measured rather than judged. Here is a single element on a quiet background, repeating so you can look at it. The readout gives its duration in milliseconds and its peak in microvolts.", r: "guay", cfg: { state: "quiet", transient: { kind: "kcomplex", period: 3.0 }, window: 4, scale: 300 }, ctrl: "element", look: "Read the two numbers beside the trace. Everything below is a claim about one of them." },
      { t: "The K-complex: a sharp negative component followed by a slower positive one, frontally maximal, and long — around 900 ms here. The usual threshold of at least 0.5 s is an AASM scoring definition, which is licensed and not held in this programme, so treat the number as orientation rather than as a criterion you can quote. Switch to the occipital channel and most of it goes.", r: "guay", cfg: { state: "quiet", transient: { kind: "kcomplex", period: 3.0 }, window: 4, scale: 300 }, ctrl: "element", look: "Front to back it is about four to one. Topography is part of the description, not an afterthought." },
      { t: "The vertex sharp wave is the same family and six times shorter, around 140 ms here — a figure from clinical convention rather than from any source held in this programme. Sharp means SHORT. It does not mean steeply drawn — change the vertical scale and the steepness changes while the duration does not.", r: "convention", cfg: { state: "quiet", transient: { kind: "vertex", period: 3.0 }, window: 4, scale: 300 }, ctrl: "element", look: "Flip between vertex and K-complex. Only one number separates them, and it is the one on the left." },
      { t: "A sleep spindle is not an element at all but a run of oscillation, 11 to 16 Hz, lasting around 800 ms. Put it beside a K-complex and you have the difference between a deflection and a rhythm.", r: "prerau", cfg: { state: "quiet", transient: { kind: "spindleRun", period: 3.0 }, window: 4, scale: 200 }, ctrl: "element", look: "One event, many cycles. That is what makes it a run rather than a wave." },
      { t: "The slow wave, alone. Its down-state is sharper than its up-state — measured here at around 450 ms against Guay's range of 0.25 to 2 s. That asymmetry is physiology, not rendering.", r: "guay", cfg: { state: "quiet", transient: { kind: "slowWave", period: 3.0 }, window: 4, scale: 260 }, ctrl: "element", look: "Now switch polarity to positive-up and watch the asymmetry appear to reverse. Same wave, different convention." },
      { t: "Now find them in context. NREM stage 2 carries K-complexes and spindles together, on slow waves, at full amplitude — which is why sleep records are the largest normal EEG you will see.", r: "prerau", cfg: { state: "nrem2", window: 8, scale: 320 }, ctrl: "element", look: "Wait a few seconds. The K-complexes are intermittent, the spindles episodic, the slow waves continuous. Three regularities on one screen." },
      { t: "Three words everything later depends on. A burst is a segment of activity. Suppression is the near-flat segment between bursts, under 5 µV. Attenuation is a fall in amplitude that does not reach that criterion.", r: "guay", cfg: { state: "propofol", bsr: 0.5 }, look: "Both a burst and a suppression are on screen. The difference between the two words is a number, not an impression." },
      { t: "Where: a channel label names two electrodes, and what you see is the difference between them. A derivation is a subtraction, not a place. That is why one rhythm looks different on different channels.", r: "purdon15", cfg: { state: "propofol", ch: 1 }, look: "Switch between the two channels. One brain, two subtractions, two pictures." },
      { t: "Filters shape the signal before it reaches you: a high-pass removes drift, a low-pass removes high-frequency noise, a notch removes the mains line. A filtered artefact has not gone away. It has been hidden.", r: "guay", cfg: { state: "propofol" }, look: "Worth knowing which filters your monitor applies by default, because nothing on the screen announces them." },
      { t: "One convention that catches everyone once: clinical EEG is traditionally drawn with negative deflections UPWARD, the opposite of most physiological traces. This programme draws negative-up. Flip it and see what changes.", r: "convention", cfg: { state: "quiet", transient: { kind: "kcomplex", period: 3.0 }, window: 4, scale: 300 }, ctrl: "element", look: "A sinusoid looks identical either way. An asymmetric element does not — which is the only reason the convention matters. Verify which way your own equipment draws." },
      { t: "None of this names a drug or a state, and that is the point. Describe first, name second, and you will still have something useful to say about a record that matches nothing in this programme.", r: "esaic", cfg: { state: "ketamine" }, look: "" },
    ],
    prompt: "Ask the group: describe this record in four phrases — how fast, how big, how regular, where. No drug names allowed.",
  },
  {
    n: "05", id: "artefact", title: "What is not the brain", mins: 9,
    codes: ["AR1", "AR2", "AR5", "PR6", "FD5"],
    aim: "Recognise the four common artefacts before you learn to trust anything on the screen.",
    points: [
      { t: "This module comes before everything that teaches you to read the display, on purpose. Everything after it teaches you to read the display, and you cannot do that safely until you can tell which parts of it are not the patient's brain.", r: "esaic", cfg: { state: "propofol", art: {} }, ctrl: "art", look: "Turn each artefact on one at a time and watch what it does to the DSA and to the quality reading." },
      { t: "Frontalis EMG is physiological, and it is the commonest contaminant of a forehead montage. It loads the high frequencies and inflates every index built on them.", r: "guay", cfg: { state: "propofol", art: { emg: 0.55 } }, ctrl: "art", look: "The top of the DSA lights up while the slow-delta and alpha underneath have not changed at all." },
      { t: "Give a relaxant and the EMG goes. The index moves. The brain did not.", r: "guay", cfg: { state: "propofol", art: { emg: 0.55 } }, ctrl: "art", look: "Drag EMG from 55 per cent to zero and watch SEF95 fall without touching the drug." },
      { t: "Mains interference is technical: one narrow line at 50 or 60 Hz depending on where you are. It is the easiest artefact to identify and the easiest to filter.", r: "guay", cfg: { state: "propofol", art: { mains: 0.6, mainsHz: 50 } }, ctrl: "art", look: "A single horizontal line, perfectly straight, at one frequency. Nothing physiological looks like that." },
      { t: "Blinks and eye movement are physiological, large, slow and frontal. They can be mistaken for slow-wave activity by anyone reading amplitude alone.", r: "guay", cfg: { state: "propofol", art: { eye: 0.7 } }, ctrl: "art", look: "Big, brief, stereotyped, and repeating. Real slow waves are none of those things." },
      { t: "Electrode pop and movement are technical: abrupt steps with a decay, often with baseline drift. Amplitude far beyond anything cortex produces is the tell.", r: "guay", cfg: { state: "propofol", art: { pop: 0.7 } }, ctrl: "art", look: "Excursions past 150 µV. No anaesthetised cortex does that." },
      { t: "The rule for all four: technical artefacts have shapes physiology cannot make. Physiological artefacts come from muscle and eye, not cortex, and have their own topography.", r: "esaic", cfg: { state: "propofol", art: { emg: 0.3, mains: 0.3, eye: 0.4, pop: 0.3 } }, ctrl: "art", look: "All four at once. This is a record you should refuse to interpret." },
      { t: "The signal quality figure here is illustrative and transparent. Commercial SQI algorithms are proprietary, so treat the number on your own monitor as a flag, not a measurement.", r: "guay", cfg: { state: "propofol", art: { emg: 0.4 } }, ctrl: "art", look: "Quality falls as artefact rises. What it will not tell you is which artefact." },
    ],
    prompt: "Ask the group: when the index reads unexpectedly high, what are the first three things you check before you change the drug?",
  },
  {
    n: "06", id: "sleep", title: "Awake, and asleep", mins: 8,
    codes: ["RW4", "RW13", "AN1", "AN4"],
    aim: "Separate the three physiological states that all involve a 10 Hz rhythm.",
    points: [
      { t: "Awake with eyes closed: alpha is posterior and it persists. It is the posterior dominant rhythm, and it is why eye closure changes the recording.", r: "purdon15", cfg: { state: "awake", ch: 1 }, look: "Switch to frontal. Most of the alpha goes — and your monitor sits on the forehead." },
      { t: "That is an adult statement. In children delta predominates in the awake record at every age, and this module assumes an adult until Age changes the picture says otherwise.", r: "markus", cfg: { state: "awake", age: 0.25, ch: 1 }, ctrl: "age", look: "Drop the age to three months here and the awake baseline stops looking like the one this module is built on." },
      { t: "NREM stage 2: slow waves with spindles on top. Spindles are brief and repeated, not continuous, and they sit around 12 to 15 Hz.", r: "prerau", cfg: { state: "nrem2" }, look: "Time the sigma band on the DSA. Discrete blobs every few seconds, not a stripe." },
      { t: "REM on the raw trace looks close to wake. On the DSA it does not: background power is higher, and REM alpha arrives in bursts at a lower frequency.", r: "prerau", cfg: { state: "rem" }, look: "Compare with awake. The whole field is brighter and the alpha stripe is broken." },
      { t: "Same band, three meanings. An EEG pattern is not the same thing as a brain state, and this is the cleanest demonstration of it.", r: "prerau", cfg: { state: "rem" }, look: "Cycle awake, NREM, REM on one channel at one gain." },
    ],
    prompt: "Ask the group: if REM and wake are hard to separate on the trace, what does that say about a device that reduces the trace to one number?",
  },
  {
    n: "07", id: "topography", title: "Where the alpha is", mins: 7,
    codes: ["PV8", "AN12", "RW4"],
    aim: "Understand anteriorisation, and what a forehead montage can and cannot see.",
    points: [
      { t: "Awake, the alpha is at the back of the head. Move the channel and watch it appear and disappear.", r: "purdon15", cfg: { state: "awake", ch: 1 }, look: "Frontal-to-occipital alpha here is about one to seven." },
      { t: "Under propofol the occipital alpha drains and a frontal alpha appears. The band is the same. The generator is not.", r: "purdon13", cfg: { state: "propofol", ch: 0 }, look: "Switch to occipital under propofol and the stripe fades." },
      { t: "Your monitor reads from the forehead. It never shows the occipital channel, so the migration is invisible in theatre. You only ever see the arrival.", r: "guay", cfg: { state: "propofol", ch: 0 }, look: "This is the most under-taught anatomical fact in processed EEG." },
      { t: "Spindle activity and alpha power are not the same thing, and the difference is continuity rather than frequency. Propofol alpha is continuous. Spindles are episodic.", r: "akeju14d", cfg: { state: "dexmedetomidine" }, look: "Compare this sigma stripe with the propofol alpha stripe. One is broken, one is solid." },
    ],
    prompt: "Ask the group: a patient shows frontal alpha at 10 Hz. Name two entirely different situations that produce it.",
  },
  {
    n: "08", id: "agents", title: "Four agents, four signatures", mins: 10,
    codes: ["EF1", "RW12", "AN1"],
    aim: "Recognise propofol, sevoflurane, ketamine and dexmedetomidine by morphology.",
    points: [
      { t: "Propofol at surgical depth: slow-delta with a strong frontal alpha. This is the reference pattern the others are read against.", r: "purdon15", cfg: { state: "propofol" }, look: "Two features only: heat at the bottom, a solid stripe at 10 Hz." },
      { t: "Sevoflurane: the propofol pattern plus theta, with coherence peaking near 4.9 Hz. Both are GABA-A drugs and the family resemblance is real.", r: "akeju14s", cfg: { state: "sevoflurane" }, look: "A second stripe appears between the slow-delta and the alpha." },
      { t: "Ketamine: gamma alternating with slow-delta, cycling below 1 Hz. Not gamma sitting on continuous slow waves — the two take turns. Alpha and beta are reduced, not abolished.", r: "akeju16", cfg: { state: "ketamine" }, look: "The top of the DSA flickers in antiphase with the bottom." },
      { t: "Dexmedetomidine: slow-delta with spindles. The morphology resembles stage 2 NREM sleep. The state is not sleep, and the distinction matters.", r: "ab17", cfg: { state: "dexmedetomidine" }, look: "Put this beside NREM 2 from Awake, and asleep. The morphology is the similarity; the pharmacology is not." },
      { t: "Three of these are GABA-A drugs. Ketamine blocks NMDA, dexmedetomidine is an alpha-2 agonist. The mechanism predicts the picture.", r: "purdon15", cfg: { state: "ketamine" }, look: "Run all four at one gain before moving on." },
    ],
    prompt: "Ask the group: you walk into a room and see this DSA. Before you look at the vaporiser, what is running?",
  },
  {
    n: "09", id: "combos", title: "Combinations", mins: 7,
    codes: ["EF7", "RW12"],
    aim: "See what happens to the picture when more than one drug is running, and where the honest limit of that knowledge sits.",
    points: [
      { t: "Almost nobody gives one drug. The single-agent signatures are the vocabulary; real anaesthesia is sentences.", r: "esaic", cfg: { combo: "propofol+remifentanil" }, ctrl: "combo", look: "Cycle the four combinations and watch which features survive and which are swamped." },
      { t: "Propofol with remifentanil looks like propofol. The opioid has no signature of its own at clinical dose — it changes the propofol dose needed to produce this picture, not the picture.", r: "purdon15", cfg: { combo: "propofol+remifentanil" }, ctrl: "combo", look: "What the EEG cannot show you is often the thing that changed." },
      { t: "Add ketamine to propofol and gamma arrives on the propofol background while the alpha weakens. This one is interpolated from the single-agent signatures, not measured.", r: "interp", cfg: { combo: "propofol+ketamine" }, ctrl: "combo", look: "Use it to teach the principle. Do not quote the morphology as a finding." },
      { t: "Propofol with dexmedetomidine puts a continuous alpha and an episodic sigma on the same record. Also interpolated.", r: "interp", cfg: { combo: "propofol+dexmedetomidine" }, ctrl: "combo", look: "Two stripes: one solid, one broken. Naming which is which is the skill." },
      { t: "Nitrous oxide does not suppress the EEG in the way the intravenous and volatile hypnotics do. Slow-delta falls and high-frequency activity rises. Direction is sourced; magnitude here is chosen.", r: "esaic", cfg: { combo: "sevoflurane+n2o" }, ctrl: "combo", look: "A record that looks lighter than the patient is. This is how indices get misled." },
      { t: "Akeju's ketamine cohort mostly had midazolam and fentanyl as well. Even the single-agent literature is often not single-agent.", r: "akeju16", cfg: { combo: "propofol+ketamine" }, ctrl: "combo", look: "Worth saying out loud whenever you teach the four signatures." },
    ],
    prompt: "Ask the group: which drug in your usual technique is invisible on the EEG, and why does that matter?",
  },
  {
    n: "10", id: "case", title: "Through a case", mins: 11,
    codes: ["RW7", "RW5", "NC11", "NC12"],
    aim: "Follow one patient from the pre-induction baseline to emergence, and read the events along the way.",
    points: [
      { t: "Drag the timeline. This is one propofol case from baseline to awake. Everything you have learned so far appears somewhere on it.", r: "guay", cfg: { casePos: 0 }, ctrl: "case", look: "Take it slowly the first time. The phase name changes as you cross each boundary." },
      { t: "Record a baseline before induction. It is the comparison for everything afterwards, and it takes seconds.", r: "esaic", cfg: { casePos: 0.0 }, ctrl: "case", look: "Posterior alpha, low amplitude, EMG present because the patient has muscle tone." },
      { t: "At induction, beta activity rises before it falls. Paradoxical excitation is a drug effect, not the patient lightening.", r: "purdon15", cfg: { casePos: 0.11 }, ctrl: "case", look: "The DSA brightens in the beta band, then collapses downward as consciousness goes." },
      { t: "Loss of consciousness: beta collapses into slow-delta and the frontal alpha begins to build. The alpha arrives after the slow waves, not with them.", r: "purdon15", cfg: { casePos: 0.21 }, ctrl: "case", look: "Watch the order. Slow-delta first, then the stripe." },
      { t: "Maintenance at surgical depth: slow-delta with a continuous frontal alpha. This is the picture the rest of the case is judged against.", r: "guay", cfg: { casePos: 0.34 }, ctrl: "case", look: "Note the amplitude. This is a young adult." },
      { t: "At incision the alpha drops out. Consider inadequate antinociception before lightening: the slow-delta has barely moved. In children a noxious stimulus RAISES delta as well — cannulation evoked a 34 per cent rise in delta without any heart-rate change. The EEG alone does not settle which it is.", r: "guay", cfg: { casePos: 0.52 }, ctrl: "case", look: "Alpha at 3 per cent of maintenance while slow-delta holds at two thirds. Lightening does not look like that." },
      { t: "If the alpha returns after analgesia without touching the hypnotic, that supports the nociceptive reading. It is one input, weighed with the haemodynamics, the stimulus and the timing — not a test that settles the question on its own.", r: "guay", cfg: { casePos: 0.64 }, ctrl: "case", look: "Scrub back and forth across incision and analgesia a few times." },
      { t: "Emergence runs the film backwards but not symmetrically: slow-delta recedes, theta appears, the alpha weakens, and EMG returns with the muscles.", r: "purdon15", cfg: { casePos: 0.8 }, ctrl: "case", look: "The high frequencies at the end are partly muscle, not cortex waking up." },
      { t: "This emergence is idealised — a clean reversal. Real emergences are where the mess is: agitation, prolonged burst suppression in the frail, and trajectories that do not run backwards. None of that is modelled here, and you should say so when you teach from it.", r: "esaic", cfg: { casePos: 0.88 }, ctrl: "case", look: "Take the sequence as the skeleton, and bring the complications from your own cases." },
      { t: "Finish by comparing the end of the case with the baseline you recorded at the start. That comparison is free and almost nobody makes it.", r: "esaic", cfg: { casePos: 1.0 }, ctrl: "case", look: "Same patient, same electrodes, two ends of one anaesthetic." },
    ],
    prompt: "Ask the group: at incision the alpha disappears. Talk me through what you do, in order, and what you say to the surgeon.",
  },
  {
    n: "11", id: "depth", title: "Depth, and past it", mins: 8,
    codes: ["RW11", "RW13", "PV10"],
    aim: "Recognise burst suppression by amplitude criteria rather than by impression.",
    points: [
      { t: "Take the depth control up from zero. Slow-delta grows, the alpha strengthens, and the record starts to break into bursts.", r: "guay", cfg: { state: "propofol", bsr: 0 }, ctrl: "bsr", look: "Move it slowly. There is no line where suppression begins — it is a continuum." },
      { t: "The criterion is amplitude, not shape: under 5 µV. Monitors usually set detection at 10 µV.", r: "guay", cfg: { state: "propofol", bsr: 0.5 }, ctrl: "bsr", look: "Read the measured BSR and check it against what you see." },
      { t: "At or below 2 µV the record is electrocerebral inactivity. That is a different statement from burst suppression.", r: "guay", cfg: { state: "propofol", bsr: 1 }, ctrl: "bsr", look: "The trace is not flat. It is small. Gain alone can make either look like the other." },
      { t: "Burst suppression is usually a dose effect rather than a target, and it is associated with poorer postoperative neurocognitive outcomes. Association, from observational work.", r: "esaic", cfg: { state: "propofol", bsr: 0.6 }, ctrl: "bsr", look: "Note how little the DSA changes compared with how much the trace does." },
      { t: "Indices under-report suppression, particularly in older adults and low-voltage records. If you want to know about suppression, look at the trace.", r: "esaic", cfg: { state: "propofol", bsr: 0.5, age: 84 }, ctrl: "bsr", look: "An 84-year-old in burst suppression. The amplitudes were low before the suppression started." },
    ],
    prompt: "Ask the group: your patient has a BSR of 40 per cent on a standard maintenance dose. What do you change first, and what do you check first?",
  },
  {
    n: "12", id: "index", title: "One number, four brains", mins: 8,
    codes: ["PR2", "PR5", "PR6", "PR14", "QT1"],
    aim: "Know what a processed index summarises, and where the summary fails.",
    points: [
      { t: "SEF95 is the frequency below which 95 per cent of the power sits. It is defined, computable and shown live here. BIS, PSi and the Narcotrend index are proprietary and cannot be reproduced.", r: "guay", cfg: { state: "propofol" }, look: "That is not a limitation of this app. It is a limitation of the field." },
      { t: "Run the four agents and watch SEF95. Ketamine pushes it up while the patient is anaesthetised, because gamma is high-frequency power.", r: "akeju16", cfg: { state: "ketamine" }, look: "Propofol near 10 Hz, ketamine near 28. Same clinical state, opposite direction of travel." },
      { t: "Dexmedetomidine and NREM stage 2 give nearly the same SEF95 from entirely different pharmacology. The number cannot separate them.", r: "akeju14d", cfg: { state: "dexmedetomidine" }, look: "Switch between dex and NREM 2 and watch the readout barely move." },
      { t: "Indices are built largely on GABA-A anaesthesia, they lag state transitions, and they are degraded by EMG. Each of those is a specific, predictable failure, not general unreliability.", r: "esaic", cfg: { state: "propofol", art: { emg: 0.5 } }, ctrl: "art", look: "Add EMG and watch SEF95 climb on an unchanged brain." },
      { t: "Your monitor shows a number this programme deliberately does not: BIS, PSi or the Narcotrend index. The algorithms are proprietary, so any version here would be invented. What you can take across is the spectrum they were computed from — it is on the same screen.", r: "guay", cfg: { state: "propofol" }, look: "If a number here disagreed with the record beneath it, you would trust the record. Do the same in theatre." },
      { t: "An index is a summary of a spectrum. If the spectrum is on the screen, read it. The number is the abstract, not the paper.", r: "guay", cfg: { state: "propofol" }, look: "Every state in this programme can be named from the DSA. None can be named from the index." },
    ],
    prompt: "Ask the group: name a case where you would deliberately ignore the index. Then name what you would look at instead.",
  },
  {
    n: "13", id: "age", title: "Age changes the picture", mins: 14,
    codes: ["PV1", "PV2", "PV3", "PV6", "PV11"],
    aim: "Adjust expectations for infants, children and the elderly, using the paediatric numbers rather than adult ones.",
    points: [
      { t: "Start with the thing most adult teaching gets wrong. In children, delta is the predominant frequency in every age group ALREADY AWAKE, before any drug. Set the age control to three months and look at the baseline.", r: "markus", cfg: { state: "awake", age: 0.25, ch: 1 }, ctrl: "age", look: "Markus recorded 147 frontal EEGs from 1 month to 8 years. Their own caveat: Narcotrend output without raw traces, so some of that preoperative delta may be eye-movement artefact." },
      { t: "That matters because if delta is already high awake, a rise in delta is a weaker signal of anaesthetic depth in a child than in an adult.", r: "markus", cfg: { state: "awake", age: 0.5, ch: 1 }, ctrl: "age", look: "Drag from 3 months to 35 years and watch the awake baseline change character entirely." },
      { t: "Frontal alpha is absent in the youngest infants. It appears around four to five months, and alpha and beta become established from about six months — the developmental threshold both paediatric datasets converge on.", r: "bong", cfg: { state: "propofol", age: 0.17 }, ctrl: "age", look: "Markus found infants under six months stay delta-dominant intraoperatively, with alpha and beta virtually absent." },
      { t: "Alpha power peaks around six to eight years, then declines through adult life. In some elderly patients it is indiscernible.", r: "guay", cfg: { state: "propofol", age: 7 }, ctrl: "age", look: "Drag from 7 to 85 and watch the stripe fade." },
      { t: "Slow-delta amplitude also falls with age: roughly 30 to 40 µV in a younger adult against 10 to 20 µV at 89.", r: "guay", cfg: { state: "propofol", age: 85 }, ctrl: "age", look: "Read the peak-to-peak at 25 and at 85 on the same dose." },
      { t: "Now the number. In children under two on sevoflurane, the processed index read falsely high in 70 per cent of children, occupying 28 per cent of the maintenance phase — with end-tidal agent and haemodynamics held stable throughout.", r: "yoon", cfg: { state: "propofol", age: 1 }, ctrl: "age", look: "50 children aged 4 to 24 months, BIS and PSi recorded together. This is not an occasional artefact. It is most of the patients, for over a quarter of the case." },
      { t: "Those false elevations have a signature. Delta and theta power FALL while alpha and beta RISE, pushing the spectral edge up to around 19 to 22 Hz.", r: "yoon", cfg: { state: "propofol", age: 1.2 }, ctrl: "age", look: "The index is reading a redistribution of power, not a lighter brain." },
      { t: "And they are separable from real arousal. At true emergence power falls across ALL bands — delta 52 dB against 179, theta 38 against 110. A false positive keeps its total power and moves it up the spectrum.", r: "yoon", cfg: { state: "propofol", age: 1.2 }, ctrl: "age", look: "That is the discriminator to teach: total power down means emergence, total power redistributed means the index is misreading." },
      { t: "Reliability is age-banded, not all-or-nothing. Under three months the burst suppression ratio and SEF95 are both unreliable and there are no alpha oscillations to read. From three to six months alpha starts to appear. From six months the raw EEG, BSR and DSA are all usable.", r: "bong", cfg: { state: "propofol", age: 0.17 }, ctrl: "age", look: "The raw trace stays reliable at every age. It is the derived numbers that fail first." },
      { t: "Isoelectric EEG is common in this population and is not the same thing as burst suppression. It was seen in 32 per cent of 648 children under three across fifteen centres, with a range of 9 to 88 per cent between sites.", r: "bong", cfg: { state: "propofol", age: 1.5, bsr: 0.9 }, ctrl: "bsr", look: "That between-site spread is a practice difference, not a patient difference." },
      { t: "It also carries a haemodynamic association: isoelectric events were associated with moderate to severe hypotension between induction and incision, odds ratio 3.5 to 4.6. Association, from observational work.", r: "bong", cfg: { state: "propofol", age: 1.5, bsr: 0.8 }, ctrl: "bsr", look: "Which is the argument for looking at the trace in the first thirty minutes, when most of it happens." },
      { t: "One trap in the evidence itself. The meta-analysis showing index-guided sevoflurane reduces agent and shortens recovery EXCLUDED children under two, and included two-to-four-year-olds despite the index not being validated below four. It does not support what it is often cited for.", r: "derylo", cfg: { state: "propofol", age: 3 }, ctrl: "age", look: "Nine RCTs, 730 patients, end-tidal sevoflurane down 0.46 per cent and PACU discharge 11.8 minutes sooner — in children over two." },
      { t: "Age is the variability you can predict. Individual variability at the same age is real too, and this programme does not model it. Treat every trace as this patient's.", r: "esaic", cfg: { state: "propofol", age: 40 }, ctrl: "age", look: "Which is the argument for recording a baseline, as in Through a case." },
      { t: "Reading the raw EEG in children is physiologically sensible and now has age-stratified guidance behind it. It is still not outcome-proven. Both halves of that sentence are load-bearing.", r: "paeds", cfg: { state: "propofol", age: 1 }, ctrl: "age", look: "This is the honest position, and it is the one to teach." },
    ],
    prompt: "Ask the group: a six-month-old on sevoflurane has an index of 65. What do you do, and what would change your mind?",
  },
  {
    n: "14", id: "act", title: "Acting on it, and saying it", mins: 8,
    codes: ["AM1", "AM2", "AM3", "PR2", "PV3"],
    aim: "Turn a reading into a decision, and a decision into a sentence someone else can act on.",
    points: [
      { t: "A reading that changes nothing is a hobby. Before you look, decide what finding would change what you do.", r: "esaic", cfg: { state: "propofol" }, look: "Three findings change management: suppression, alpha dropout, and a picture that does not match the dose." },
      { t: "Suppression on a standard dose: reduce the hypnotic, and look for why this patient needed less — age, frailty, hypovolaemia, hypothermia, low cardiac output.", r: "esaic", cfg: { state: "propofol", bsr: 0.55 }, ctrl: "bsr", look: "The EEG tells you that it happened. It does not tell you why." },
      { t: "Alpha dropout at a surgical stimulus: consider treating the nociception and watching whether the alpha returns, rather than deepening first. Read the result with everything else in front of you.", r: "guay", cfg: { casePos: 0.52 }, ctrl: "case", look: "Scrub from incision to analgesia. That transition is the argument." },
      { t: "A picture that does not match the dose is a reason to check the sensor before you change the drug. Artefact first, pharmacology second.", r: "esaic", cfg: { state: "propofol", art: { emg: 0.5, pop: 0.4 } }, ctrl: "art", look: "What is not the brain exists so this check is quick." },
      { t: "Then say it in a form the team can use. Not \"the EEG looks deep\" but: what you see, what you think it means, what you are doing, and what you want from them.", r: "esaic", cfg: { state: "propofol", bsr: 0.55 }, look: "Try: \"I have burst suppression at 40 per cent on a normal dose. I am turning the propofol down and I would like the pressure supported rather than the depth increased.\"" },
      { t: "The surgeon does not need the spectrogram. They need to know whether you are about to change something that affects them, and when.", r: "esaic", cfg: { state: "propofol" }, look: "One sentence, no jargon, with a timeframe in it." },
    ],
    prompt: "Ask the group: take the last EEG finding any of you acted on. Say it back in four parts — see, mean, doing, need.",
  },
];

/* ===================== drill bank ========================================= */

const AGENTS = ["propofol", "sevoflurane", "ketamine", "dexmedetomidine"];

const DRILLS = [
  { mod: "08", cfg: { state: "propofol", ch: 0 }, q: "Which agent?", opts: AGENTS, a: "propofol",
    why: "Slow-delta with a single continuous frontal alpha stripe and nothing between them. No theta, no gamma, no spindles." },
  { mod: "08", cfg: { state: "sevoflurane", ch: 0 }, q: "Which agent?", opts: AGENTS, a: "sevoflurane",
    why: "The propofol pattern plus a theta stripe near 5 Hz. Both are GABA-A drugs, so the alpha and slow-delta look similar; the theta is the discriminator (Akeju 2014)." },
  { mod: "08", cfg: { state: "ketamine", ch: 0 }, q: "Which agent?", opts: AGENTS, a: "ketamine",
    why: "Gamma alternating with slow-delta rather than sitting on it, and almost no alpha (Akeju 2016)." },
  { mod: "08", cfg: { state: "dexmedetomidine", ch: 0 }, q: "Which agent?", opts: AGENTS, a: "dexmedetomidine",
    why: "Slow-delta with episodic spindles. Against propofol, the give-away is that the 13 Hz stripe is broken, not solid." },
  { mod: "06", cfg: { state: "awake", ch: 1 }, q: "Which state?", opts: ["awake", "nrem2", "rem", "propofol"], a: "awake",
    why: "Low amplitude with a persistent alpha on an occipital channel. Amplitude alone rules out the anaesthetised states." },
  { mod: "06", cfg: { state: "nrem2", ch: 0 }, q: "Which state?", opts: ["awake", "nrem2", "rem", "propofol"], a: "nrem2",
    why: "Slow waves with brief repeated spindles. Against propofol: the sigma stripe is episodic and there is no continuous alpha." },
  { mod: "06", cfg: { state: "rem", ch: 1 }, q: "Which state?", opts: ["awake", "nrem2", "rem", "propofol"], a: "rem",
    why: "Broadband background higher than eyes-closed wake, with alpha arriving in bursts at a lower frequency. On the trace alone this is close to wake (Prerau 2017)." },
  { mod: "05", cfg: { state: "propofol", ch: 0, art: { emg: 0.7 } }, q: "Artefact or brain?", opts: ["Brain: light", "EMG", "Mains", "Eye movement"], a: "EMG",
    why: "High-frequency load across the top of the DSA with the slow-delta and alpha underneath unchanged. Physiological artefact, frontal, and it will disappear with a relaxant." },
  { mod: "05", cfg: { state: "propofol", ch: 0, art: { mains: 0.75, mainsHz: 50 } }, q: "Artefact or brain?", opts: ["Brain: gamma", "EMG", "Mains", "Electrode pop"], a: "Mains",
    why: "One perfectly straight narrow line at a single frequency. Technical artefact — no physiological rhythm is that narrow or that stable." },
  { mod: "05", cfg: { state: "propofol", ch: 0, art: { eye: 0.8 } }, q: "Artefact or brain?", opts: ["Slow waves", "Eye movement", "Mains", "Burst suppression"], a: "Eye movement",
    why: "Large, brief, stereotyped, repeating, frontal. Physiological artefact. Real slow waves are none of those things." },
  { mod: "05", cfg: { state: "propofol", ch: 0, art: { pop: 0.8 } }, q: "Artefact or brain?", opts: ["Bursts", "EMG", "Electrode pop", "Eye movement"], a: "Electrode pop",
    why: "Abrupt steps with exponential decay and baseline drift, well past 150 µV. Technical — no anaesthetised cortex produces that amplitude." },
  { mod: "11", cfg: { state: "propofol", ch: 0, bsr: 0.55 }, q: "What is the approximate burst suppression ratio?", opts: ["0", "0.2", "0.55", "0.9"], a: "0.55",
    why: "Just over half of each 0.5 s epoch falls under the 5 µV suppression criterion. Check your eye against the measured BSR." },
  { mod: "10", cfg: { casePos: 0.11 }, q: "Which phase of the case?", opts: ["Baseline", "Induction", "Maintenance", "Emergence"], a: "Induction",
    why: "Beta activation with slow-delta only beginning. Paradoxical excitation — a drug effect on the way down, not a patient lightening." },
  { mod: "10", cfg: { casePos: 0.52 }, q: "Alpha has gone. What is this?", opts: ["Lightening", "Nociception", "Deepening", "Artefact"], a: "Nociception",
    why: "Alpha collapses to about 3 per cent of maintenance while slow-delta holds at two thirds. Lightening takes the slow-delta with it; nociception does not." },
  { mod: "10", cfg: { casePos: 0.8 }, q: "Which phase of the case?", opts: ["Induction", "Maintenance", "Incision", "Emergence"], a: "Emergence",
    why: "Slow-delta receding, theta appearing, the alpha weakening, and EMG returning with muscle tone." },
  { mod: "09", cfg: { combo: "propofol+remifentanil" }, q: "Propofol with which second drug?", opts: ["Remifentanil", "Ketamine", "Dexmedetomidine", "Nitrous oxide"], a: "Remifentanil",
    why: "It looks exactly like propofol alone, because the opioid has no EEG signature at clinical dose. It changed the dose needed, not the picture." },
  { mod: "13", cfg: { state: "propofol", ch: 0, age: 0.17 }, q: "This is propofol. Why is there no alpha?", opts: ["Too light", "Too deep", "The patient is an infant", "Electrode fault"], a: "The patient is an infant",
    why: "Frontal alpha emerges around four to five months in sedated infants. A two-month-old shows slow-delta without it, and that is normal (Guay 2025)." },
  { mod: "13", cfg: { state: "propofol", ch: 0, age: 88 }, q: "Same dose, same drug. Why is the amplitude low?", opts: ["Too light", "The patient is elderly", "Burst suppression", "EMG"], a: "The patient is elderly",
    why: "Slow-delta amplitude falls with age — about 30 to 40 µV in a younger adult against 10 to 20 µV at 89. Low amplitude here is age, not depth." },
  { mod: "12", cfg: { state: "ketamine", ch: 0 }, q: "SEF95 reads near 28 Hz. Is the patient light?", opts: ["Yes, lighten is wrong", "No — the agent explains it", "Cannot say", "Yes, deepen"], a: "No — the agent explains it",
    why: "Ketamine's gamma is high-frequency power, so it drags SEF95 and processed indices upward in an anaesthetised patient." },
  { mod: "05", cfg: { state: "awake", ch: 0 }, q: "Frontal channel. What is most of the high-frequency power?", opts: ["Cortical gamma", "Muscle", "Mains", "Alpha harmonic"], a: "Muscle",
    why: "Frontal awake high-frequency activity is substantially frontalis EMG, which is why relaxants move an index without moving the brain." },
  { mod: "01", cfg: { state: "propofol", ch: 0, bsr: 0.5, age: 84 }, q: "Standard maintenance dose, 84 years old. Does this change anything?",
    opts: ["No, this is normal", "Yes — reduce the hypnotic", "Yes — deepen", "Only if the pressure falls"], a: "Yes — reduce the hypnotic",
    why: "Half of each epoch is under the 5 µV suppression criterion on a standard dose. No haemodynamic variable would have told you. Reduce the hypnotic, then look for why this patient needed less." },
  { mod: "02", cfg: { state: "propofol", ch: 0 }, q: "Which display tells you how long this alpha has been present?",
    opts: ["The trace", "The DSA", "Both equally", "Neither"], a: "The DSA",
    why: "The trace shows a few seconds — the state now. The DSA carries the history along its time axis. That division of labour is why the monitor shows both." },
  { mod: "07", cfg: { state: "propofol", ch: 1 }, q: "Propofol at surgical depth, and the alpha is weak. Why?",
    opts: ["Too light", "This is an occipital channel", "The patient is an infant", "Electrode fault"], a: "This is an occipital channel",
    why: "Propofol alpha is frontal. On an occipital derivation it is largely absent — which is anteriorisation, and the reason a forehead sensor sees what it sees." },
  { mod: "14", cfg: { state: "propofol", ch: 0, art: { emg: 0.6 } }, q: "The index has just risen. What do you do first?",
    opts: ["Deepen", "Check the sensor and the EMG", "Give a relaxant", "Nothing"], a: "Check the sensor and the EMG",
    why: "High-frequency load with the slow-delta and alpha unchanged underneath. Artefact first, pharmacology second — the brain has not moved." },
  { mod: "14", cfg: { state: "propofol", ch: 0, bsr: 0.5 }, q: "Which sentence is usable by the team?",
    opts: ["The EEG looks deep", "Burst suppression at 50 per cent on a normal dose — I am reducing the propofol and would like the pressure supported", "The spectrogram shows slow-delta dominance", "I think we should lighten"],
    a: "Burst suppression at 50 per cent on a normal dose — I am reducing the propofol and would like the pressure supported",
    why: "Four parts: what you see, what it means, what you are doing, what you need from them. The others give an impression with no action and no ask." },
  { mod: "04", cfg: { state: "propofol", ch: 0, bsr: 0.45 }, q: "Between the bursts the trace is small but not flat. What is that segment called?",
    opts: ["Attenuation", "Suppression", "Isoelectric", "Artefact"], a: "Suppression",
    why: "Suppression is defined by amplitude: under 5 µV. Attenuation is a fall that does not reach that criterion, and isoelectric is 2 µV or less. Which word you use is a measurement, not an impression." },
  { mod: "04", cfg: { state: "nrem2", ch: 0 }, q: "Describe the 13 Hz activity here in one word.",
    opts: ["Continuous", "Episodic", "Sharp", "Attenuated"], a: "Episodic",
    why: "It arrives in discrete runs under a second long with clear gaps between them. That is what separates a spindle from the continuous alpha of propofol — and it is a description, not yet a diagnosis." },
  { mod: "04", cfg: { state: "quiet", transient: { kind: "vertex", period: 3.0 }, window: 4, scale: 300 }, q: "Read the duration. Which element is this?",
    opts: ["K-complex", "Vertex sharp wave", "Sleep spindle", "Slow wave"], a: "Vertex sharp wave",
    why: "Around 140 ms. A K-complex runs about 900 ms and a spindle about 800 ms, so duration alone settles it. This is why the readout is on screen — sharpness is a measurement, not an impression." },
  { mod: "04", cfg: { state: "quiet", transient: { kind: "spindleRun", period: 3.0 }, window: 4, scale: 200 }, q: "Element or rhythm?",
    opts: ["A single deflection", "A run of oscillation", "Artefact", "Suppression"], a: "A run of oscillation",
    why: "One event lasting about 800 ms, containing many cycles at 11 to 16 Hz. A K-complex or a vertex wave is one deflection; this is a rhythm with a beginning and an end." },
  { mod: "03", cfg: { band: "theta", window: 4, scale: 180 }, q: "One band, alone. Which is it?",
    opts: ["Delta", "Theta", "Alpha", "Beta"], a: "Theta",
    why: "Six cycles a second, so about 170 ms a cycle. Delta would be one to four, alpha eight to twelve. Counting against the one-second gridlines settles it without the spectrogram." },
  { mod: "03", cfg: { band: "gamma", window: 2, scale: 300 }, q: "At 300 µV full scale this band is almost invisible. Why?",
    opts: ["It is filtered out", "Amplitude falls as frequency rises", "The gain is broken", "It is artefact"], a: "Amplitude falls as frequency rises",
    why: "Slow runs around 120 µV peak to peak and gamma around 12 — a factor of ten. That 1/f character is why no single fixed gain shows every band, and why the µV readout matters more than the picture." },
  { mod: "09", cfg: { combo: "propofol+dexmedetomidine" }, q: "Two stripes. Which is which?",
    opts: ["Both continuous", "Solid alpha, broken sigma", "Solid sigma, broken alpha", "Both broken"], a: "Solid alpha, broken sigma",
    why: "Propofol's alpha runs continuously; dexmedetomidine's spindles are episodic. Continuity separates them, not frequency — and this combination is a teaching interpolation, not a measured morphology." },
  { mod: "09", cfg: { combo: "sevoflurane+n2o" }, q: "This record looks lighter than the patient is. Why?",
    opts: ["The vaporiser is low", "Nitrous oxide does not suppress the EEG typically", "Artefact", "The sensor has failed"], a: "Nitrous oxide does not suppress the EEG typically",
    why: "Slow-delta falls and high-frequency activity rises, so an index built on GABA-A anaesthesia reads high while the patient is adequately anaesthetised. Direction is sourced; the magnitudes here were chosen." },
  { mod: "03", cfg: { band: "beta", window: 3, scale: 120 }, q: "Which band, and when would you expect to see it?",
    opts: ["Delta, deep anaesthesia", "Beta, induction or light anaesthesia", "Gamma, ketamine", "Theta, sevoflurane"], a: "Beta, induction or light anaesthesia",
    why: "Around 18 cycles a second. Beta rises at induction before consciousness is lost — paradoxical excitation rather than lightening — and again when anaesthesia is light." },
  { mod: "02", cfg: { state: "propofol", art: { emg: 0.5 } }, q: "The top of the DSA has lit up. What has changed underneath?",
    opts: ["The slow-delta", "The alpha", "Nothing", "Both"], a: "Nothing",
    why: "High-frequency load with the slow-delta and alpha unchanged beneath it. The DSA shows you which part of the picture moved; a single number could not have." },
  { mod: "11", cfg: { state: "propofol", bsr: 0.85, age: 40 }, q: "BSR is 85 per cent. What is the trace doing between bursts?",
    opts: ["Flat, zero", "Under 5 µV", "Under 20 µV", "Oscillating at 1 Hz"], a: "Under 5 µV",
    why: "Suppression is defined by amplitude, not by flatness — under 5 µV. At 2 µV or less you would call it electrocerebral inactivity, which is a different statement." },
  { mod: "12", cfg: { state: "nrem2" }, q: "SEF95 here is about 3 Hz, the same as dexmedetomidine. What does that tell you?",
    opts: ["Same drug", "Same depth", "The number cannot separate them", "Sensor error"], a: "The number cannot separate them",
    why: "Natural stage 2 sleep and an alpha-2 agonist give nearly the same spectral edge from entirely different pharmacology. One number, two states — which is the argument for reading the spectrum." },
  { mod: "07", cfg: { state: "awake", ch: 0 }, q: "Awake patient, frontal channel. Where has the alpha gone?",
    opts: ["Suppressed by the drug", "It is occipital", "Filtered out", "There is none when awake"], a: "It is occipital",
    why: "Awake alpha is the posterior dominant rhythm. A forehead sensor sees a fraction of it, which is why anteriorisation under propofol looks like an arrival rather than a migration." },
  { mod: "10", cfg: { casePos: 0.21 }, q: "Beta has just collapsed into slow-delta. What has happened?",
    opts: ["Incision", "Loss of consciousness", "Emergence", "Artefact"], a: "Loss of consciousness",
    why: "The induction sequence: beta activation first, then collapse into slow-delta, then the frontal alpha builds. The alpha arrives after the slow waves, not with them." },
  { mod: "14", cfg: { casePos: 0.64 }, q: "You treated the nociception and the alpha came back. What do you tell the surgeon?",
    opts: ["Nothing, it is resolved", "That you have deepened them", "What you saw, what you did, and that nothing changes for them", "Ask them to pause"], a: "What you saw, what you did, and that nothing changes for them",
    why: "See, mean, doing, need. Here the need is nil, and saying so briefly is still worth doing — it tells them the change was yours and that it does not affect their field." },
  { mod: "06", cfg: { state: "rem", ch: 0 }, q: "Frontal channel, REM sleep. Would the raw trace alone let you call this?",
    opts: ["Yes, easily", "No — it resembles wake", "Only with EMG", "Only in children"], a: "No — it resembles wake",
    why: "On the trace REM sits close to wake. The discriminators are on the spectrogram: higher background power, and alpha in bursts at a lower frequency than wake's persistent rhythm." },
  { mod: "13", cfg: { state: "awake", age: 0.25, ch: 1 }, q: "Awake three-month-old, before induction. Which band dominates?",
    opts: ["Alpha", "Delta", "Beta", "Theta"], a: "Delta",
    why: "Delta predominates in the awake record at every paediatric age (Markus 2026). The adult teaching — awake means posterior alpha — does not transfer, and it makes a rise in delta a weaker depth signal in a child than in an adult." },
  { mod: "13", cfg: { state: "propofol", age: 1.2 }, q: "The index has risen in a 14-month-old on stable sevoflurane. Total EEG power is unchanged. What is this?",
    opts: ["Emergence", "A false positive", "Burst suppression", "Electrode failure"], a: "A false positive",
    why: "Yoon's discriminator: at true emergence power falls across all bands, delta 52 dB against 179. A false positive keeps its total power and moves it up the spectrum — delta and theta down, alpha and beta up, spectral edge to 19–22 Hz." },
  { mod: "13", cfg: { state: "propofol", age: 0.17 }, q: "Two-month-old. Which of these can you still rely on?",
    opts: ["The processed index", "SEF95", "The burst suppression ratio", "The raw trace"], a: "The raw trace",
    why: "Under three months the BSR and SEF95 are both unreliable and there are no alpha oscillations to read (Bong & Yuan 2026). The raw waveform stays reliable at every age — it is the derived numbers that fail first." },
  { mod: "13", cfg: { state: "propofol", age: 1.5 }, q: "Someone cites the BIS meta-analysis to justify index-guided sevoflurane in an 18-month-old. Is that sound?",
    opts: ["Yes, nine RCTs", "No — under-2s were excluded", "Only for TIVA", "Only over 4 years"], a: "No — under-2s were excluded",
    why: "Derylo 2026 explicitly excluded children under two, and included 2–4 year olds despite the index not being validated below four. Its findings are real for children over two and say nothing about this patient." },
  { mod: "13", cfg: { state: "propofol", age: 1.5, bsr: 0.85 }, q: "Isoelectric EEG in a young child — what is the reported association?",
    opts: ["Awareness", "Hypotension between induction and incision", "Emergence delirium", "Nothing"], a: "Hypotension between induction and incision",
    why: "Odds ratio 3.5 to 4.6 between induction and incision, and 3.6 to 7.1 during maintenance, across a 15-centre study (Bong & Yuan 2026). Observational, and the between-site range of 9 to 88 per cent suggests practice rather than patients." },
];


/* ===================== point-of-care reference ============================
   Deliberately written as REFERENCE, not instruction. It states criteria and
   what a finding is consistent with; it does not tell anyone what to do to a
   patient. A card that gives management steps is a different object with a
   different approval bar, and the line is worth not crossing by accident.
   ========================================================================= */

const LOOKUP = [
  {
    id: "amp", title: "Amplitude criteria", r: "guay",
    rows: [
      ["Suppression", "under 5 µV"],
      ["Suppression detection, most monitors", "threshold set at 10 µV"],
      ["Electrocerebral inactivity", "2 µV or less"],
      ["Slow-delta, younger adult", "30 to 40 µV"],
      ["Slow-delta, around 89 years", "10 to 20 µV"],
    ],
  },
  {
    id: "bands", title: "Frequency bands", r: "guay",
    rows: [
      ["Slow", "below 1 Hz"],
      ["Delta", "1 to 4 Hz"],
      ["Theta", "4 to 8 Hz"],
      ["Alpha", "8 to 12 Hz"],
      ["Beta", "13 to 25 Hz"],
      ["Gamma", "above 25 Hz"],
    ],
    foot: "Purdon 2015 Part I put alpha at 9 to 12. Say which set you are using.",
  },
  {
    id: "agents", title: "Agent signatures", r: "purdon15",
    rows: [
      ["Propofol", "slow-delta with a continuous frontal alpha"],
      ["Sevoflurane", "the propofol pattern plus theta near 5 Hz"],
      ["Ketamine", "gamma alternating with slow-delta; alpha and beta reduced"],
      ["Dexmedetomidine", "slow-delta with episodic spindles"],
      ["Opioid alone", "no signature of its own at clinical dose"],
    ],
    foot: "Continuity separates a propofol alpha from spindles, not frequency.",
  },
  {
    id: "age", title: "Age expectations", r: "guay",
    rows: [
      ["Youngest infants", "no frontal alpha; slow-delta dominant"],
      ["Frontal alpha emerges", "around 4 to 5 months, in sedated infants"],
      ["Alpha power peaks", "around 6 to 8 years"],
      ["Older age", "alpha declines; indiscernible in some elderly"],
      ["Under 2 years", "processed index can read falsely high"],
      ["Older children", "essentially adult-like"],
    ],
    foot: "Narcotrend is the only processed EEG with an age-adjusted algorithm, so findings do not transfer between devices.",
  },
  {
    id: "change", title: "What a change is consistent with", r: "guay",
    rows: [
      ["Alpha drops out, slow-delta holds", "nociception, before lightening — read with the other signs"],
      ["Alpha and slow-delta both fall", "lightening"],
      ["High-frequency load, rest unchanged", "EMG or another artefact"],
      ["Index rises on ketamine", "the agent; gamma is high-frequency power"],
      ["Low amplitude at a normal dose", "age, or depth — the trace tells you which"],
      ["Record breaks into bursts", "suppression; check amplitude against 5 µV"],
    ],
    foot: "Each of these is one input. None of them is settled by the EEG alone.",
  },
  {
    id: "artefact", title: "Artefact check", r: "guay",
    rows: [
      ["Frontalis EMG", "physiological · high frequencies, rest unchanged"],
      ["Blink and eye movement", "physiological · large, brief, stereotyped, frontal"],
      ["Mains", "technical · one narrow line at 50 or 60 Hz"],
      ["Electrode pop and drift", "technical · abrupt steps past 150 µV"],
    ],
    foot: "Technical artefacts have shapes physiology cannot make. Check the sensor before the pharmacology.",
  },
  {
    id: "paeds", title: "Paediatric reliability by age", r: "bong",
    rows: [
      ["Under 3 months", "raw trace reliable · BSR unreliable · SEF95 unreliable · no alpha, slow-delta only"],
      ["3 to 6 months", "raw, BSR and DSA reliable · alpha oscillations only from 4 to 5 months"],
      ["6 months to 1 year", "raw, BSR and DSA reliable · a shift in SEF to lower frequency indicates deeper hypnosis"],
      ["All ages", "the raw waveform stays reliable when the derived numbers do not"],
      ["Under 2 years", "index read falsely high in 70% of children, 28% of maintenance (Yoon 2025)"],
      ["Awake baseline, any paediatric age", "delta predominant before induction (Markus 2026)"],
    ],
    foot: "The index meta-analysis showing reduced agent and faster recovery excluded children under two, so it does not speak to this group.",
  },
  {
    id: "sef", title: "SEF95 orientation values", r: "bong",
    rows: [
      ["Sedation", "15 to 20 Hz"],
      ["Maintenance", "10 to 15 Hz"],
      ["Laryngoscopy or incision", "6 to 14 Hz"],
      ["Emergence, measured", "20.7 ± 2.6 Hz"],
      ["Light, end-tidal sevoflurane under 0.7 MAC", "16.9 ± 2 Hz"],
      ["Deep, over 0.8 MAC", "9.6 ± 3.2 Hz"],
      ["Ketamine or nitrous oxide", "SEF95 rises despite deeper hypnosis"],
    ],
    foot: "Suggested targets for propofol or sevoflurane in children. No association with age was found for the measured values. Unreliable under three months.",
  },
];

/* ---- further reading, distinct from the sources the teaching rests on ---- */

const FURTHER = {
  note: "The sources above are what this programme's claims rest on. These are what to read next. The paediatric selection follows the curriculum curated by PALNET, the Pediatric Anesthesia Learning Network, at pedseeg.com.",
  items: [
    { t: "General anesthesia, sleep, and coma", a: "Brown, Lydic, Schiff", j: "N Engl J Med 2010;363(27):2638-2650", doi: "10.1056/NEJMra0808281",
      w: "The mental model the rest of the field is built on." },
    { t: "Age-dependent EEG patterns during sevoflurane general anaesthesia in infants", a: "Cornelissen, Kim, Purdon, Brown, Berde", j: "eLife 2015;4:e06513", doi: "10.7554/eLife.06513",
      w: "Open access. The empirical basis for developmental EEG teaching, which this programme currently takes second-hand from Guay 2025." },
    { t: "Intraoperative paediatric electroencephalography monitoring: an updated review", a: "Yuan, Bong, Chao", j: "Korean J Anesthesiol 2024;77(3):289-305", doi: "10.4097/kja.23843",
      w: "The most current paediatric review." },
    { t: "Age-dependent changes in propofol-induced EEG oscillations in children", a: "Lee, Akeju, Terzakis et al.", j: "Anesthesiology 2017", doi: "10.1097/ALN.0000000000001717",
      w: "Prospective, and the propofol counterpart to Cornelissen." },
    { t: "A narrative review illustrating the clinical utility of EEG-guided anaesthesia care in children", a: "Bong, Balanza, Khoo et al.", j: "Anesth Analg 2023", doi: "10.1213/ANE.0000000000006267",
      w: "Case-based reasoning with annotated records rather than theory." },
    { t: "Using EEG to guide propofol and sevoflurane dosing in paediatric anaesthesia", a: "Yuan, Xu, Skowno", j: "Anesthesiol Clin 2020;38(3):709-725", doi: "10.1016/j.anclin.2020.06.007",
      w: "Practical titration, which is the step past anything taught here." },
    { t: "The ageing brain: age-dependent EEG changes during propofol and sevoflurane", a: "Purdon, Pavone, Akeju et al.", j: "Br J Anaesth 2015;115 Suppl 1:i46-i57", doi: "10.1093/bja/aev213",
      w: "The other end of the age axis." },
    { t: "Interpreting intraoperative EEG: beyond indices to the essential role of raw EEG and the DSA", a: "Rajan, Nuti et al.", j: "J Neurosurg Anesthesiol 2025", doi: "10.1097/ANA.0000000000001056",
      w: "The argument this programme's index module makes, at length." },
    { t: "Introducing the Safe Brain Initiative's EEG boot camp for anaesthesia", a: "von Dincklage, Helfrich, Koch et al.", j: "BMC Anesthesiology 2025", doi: "10.1186/s12871-025-03276-8",
      w: "Open access. A standardised perioperative EEG training model — the implementation counterpart to a self-study app." },
  ],
};

const REAL_RECORDS = {
  title: "Where to see real records",
  body: "Every waveform in this programme is synthesised. It can teach you to recognise a signature and to describe what you see; it cannot teach you acquisition, and it cannot show you a real patient. That gap closes with real recordings and time at a monitor, not with more simulation.",
  links: [
    ["EEG for Anesthesia", "A free video introduction to the signal and how anaesthetics shape it.", "youtube.com/@eegforanesthesia3954"],
    ["PALNET workshops and site visits", "Small-group interpretation of real cases, and in-theatre teaching at your own institution.", "pedseeg.com"],
  ],
};

/* ===================== storage ============================================ */

const KEY_STORE = "eeg-programme:v9";
const KEY_OLD = "eeg-programme:v2";
const EMPTY_PROG = { done: {}, last: null, seenIntro: false, drill: { seen: 0, right: 0, byMod: {}, box: {}, idx: 0 } };

async function loadProgress() {
  try {
    if (!window.storage) return null;
    const r = await window.storage.get(KEY_STORE, false);
    return { ...EMPTY_PROG, ...JSON.parse(r.value) };
  } catch {
    // migrate anyone who started on the old key rather than silently orphan them
    try {
      const old = await window.storage.get(KEY_OLD, false);
      const p = { ...EMPTY_PROG, ...JSON.parse(old.value) };
      p.drill = { ...EMPTY_PROG.drill, ...(p.drill || {}) };
      await window.storage.set(KEY_STORE, JSON.stringify(p), false);
      return p;
    } catch { return null; }
  }
}
async function saveProgress(p) {
  try { if (window.storage) await window.storage.set(KEY_STORE, JSON.stringify(p), false); } catch { /* best effort */ }
}

/* ===================== config resolution ================================== */

function resolveCfg(cfg) {
  if (cfg.band) return { ...cfg, custom: BAND_DEMO[cfg.band] };
  if (cfg.casePos != null) return { ...cfg, custom: caseState(cfg.casePos) };
  if (cfg.combo) return { ...cfg, custom: COMBOS[cfg.combo] };
  return cfg;
}

/* ===================== phone-first UI ====================================
   Rebuilt for a phone held in one hand. Navigation lives in the thumb zone,
   the instrument takes only the height it earns, and each screen carries one
   teaching point rather than a page of prose.
   ========================================================================= */

const P = {
  bg: "#0E1116",
  surface: "#171B22",
  surface2: "#212831",
  line: "#2C3540",
  ink: "#F2EEE6",
  dim: "#99A2AE",
  accent: "#F0A63C",
  ok: "#5FBF8F",
  warn: "#E0796E",
};

const AUTHOR = "Dr Ganesh Sivasankara";
const CREDENTIALS = "MD · FRCA · FCARCSI · Consultant Anaesthetist";

const UI = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const NUM = "'Newsreader', Georgia, serif";
const MN = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace";

function useViewport() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth || 390 : 390);
  useEffect(() => {
    const on = () => setW(window.innerWidth || 390);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return { w, narrow: w < 620 };
}

/* ---- scope --------------------------------------------------------------- */

// The scope's signal history lives OUTSIDE the component. Only one scope is ever
// on screen, and holding this in refs meant every tab change unmounted it and
// threw away 37.5 s of spectrogram.
const SCOPE = {
  buf: new Float64Array(FS * 12),
  win: new Float64Array(FS * 12),
  wr: 0,
  cols: [],
  eng: makeEngine(3),
  t: 0,
  acc: 0,
};

function Scope({ cfg, trace = 104, spec = 104, onPause }) {
  const traceRef = useRef(null);
  const specRef = useRef(null);
  const lastRef = useRef(0);
  const cfgRef = useRef(cfg);
  const [ro, setRo] = useState({ pp: 0, sef: 0, bsr: 0, sqi: 100, dur: 0, amp: 0 });
  cfgRef.current = cfg;

  const NCOL = 150;
  const NBIN = Math.round(40 / DF);

  useEffect(() => {
    let raf;
    const tc = traceRef.current, sc = specRef.current;
    if (!tc || !sc) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const off = document.createElement("canvas");
    off.width = NCOL; off.height = NBIN;
    const octx = off.getContext("2d");
    if (!octx) return;
    const img = octx.createImageData(NCOL, NBIN);

    const fit = (cv) => {
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      return cv.getContext("2d");
    };
    let tctx = fit(tc), sctx = fit(sc);
    const onResize = () => { tctx = fit(tc); sctx = fit(sc); };
    window.addEventListener("resize", onResize);
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const minGap = reduced ? 1000 / 12 : 0;

    const step = (now) => {
      raf = requestAnimationFrame(step);
      if (lastRef.current && now - lastRef.current < minGap) return;
      if (!lastRef.current) lastRef.current = now;
      let dt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      dt = Math.min(dt, 0.1);
      const c = resolveCfg(cfgRef.current);
      if (c.paused) { lastRef.current = now; return; }

      const nNew = Math.floor(dt * FS);
      const buf = SCOPE.buf;
      for (let i = 0; i < nNew; i++) {
        SCOPE.t += 1 / FS;
        buf[SCOPE.wr] = SCOPE.eng(SCOPE.t, c, c.ch ?? 0);
        SCOPE.wr = (SCOPE.wr + 1) % buf.length;
      }
      SCOPE.acc += dt;

      const win = SCOPE.win;
      const wr = SCOPE.wr;
      win.set(buf.subarray(wr));
      win.set(buf.subarray(0, wr), buf.length - wr);

      if (SCOPE.acc >= 0.25) {
        SCOPE.acc = 0;
        const psd = spectrum(win.subarray(win.length - WIN_N), NFFT, 3);
        SCOPE.cols.push(psd);
        if (SCOPE.cols.length > NCOL) SCOPE.cols.shift();
        let mx = -1e9, mn = 1e9;
        for (let i = 0; i < win.length; i++) { if (win[i] > mx) mx = win[i]; if (win[i] < mn) mn = win[i]; }
        const el = c.transient ? measureTransient(win.subarray(win.length - Math.round((c.window ?? 5) * FS))) : { dur: 0, amp: 0 };
        setRo({ pp: mx - mn, sef: sefBand(psd), bsr: measuredBSR(win), sqi: signalQuality(win, psd), dur: el.dur, amp: el.amp });
      }

      const W = tc.width, H = tc.height;
      tctx.fillStyle = P.surface;
      tctx.fillRect(0, 0, W, H);
      const secs = c.window ?? 5;
      const n = Math.min(win.length, Math.round(secs * FS));
      const uvPerPx = (c.scale ?? 200) / H;
      tctx.strokeStyle = "rgba(240,166,60,0.22)";
      tctx.lineWidth = 1;
      for (const uv of [-50, 50]) {
        const y = H / 2 - uv / uvPerPx;
        if (y > 2 && y < H - 2) { tctx.beginPath(); tctx.moveTo(0, y); tctx.lineTo(W, y); tctx.stroke(); }
      }
      // Clinical EEG is drawn negative-up. The engine emits physiological
      // polarity, so the display flips unless the user asks for positive-up.
      const pol = c.polarity === "pos-up" ? 1 : -1;
      tctx.strokeStyle = P.ink;
      tctx.lineWidth = Math.max(1, 1.2 * dpr);
      tctx.lineJoin = "round";
      tctx.beginPath();
      const start = win.length - n;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = H / 2 - (pol * win[start + i]) / uvPerPx;
        if (i === 0) tctx.moveTo(x, y); else tctx.lineTo(x, y);
      }
      tctx.stroke();

      const cols = SCOPE.cols;
      const map = c.map === "viridis" ? viridis : jet;
      const lo = -8, hi = 44;
      for (let x = 0; x < NCOL; x++) {
        const col = cols[cols.length - NCOL + x];
        for (let y = 0; y < NBIN; y++) {
          const o = (y * NCOL + x) * 4;
          if (!col) { img.data[o] = 23; img.data[o + 1] = 27; img.data[o + 2] = 34; img.data[o + 3] = 255; continue; }
          const db = 10 * Math.log10(Math.max(1e-6, col[NBIN - 1 - y]));
          const rgb = map((db - lo) / (hi - lo));
          img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0);
      sctx.drawImage(off, 0, 0, sc.width, sc.height);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, [NBIN]);

  const rc = resolveCfg(cfg);
  const title = rc.custom ? rc.custom.label : ((STATES[cfg.state] || {}).label || "");
  const chip = { fontFamily: MN, fontSize: 10.5, letterSpacing: "0.06em", color: P.dim };
  const sqiCol = ro.sqi > 75 ? P.ok : ro.sqi > 45 ? P.accent : P.warn;

  return (
    <div style={{ background: P.surface, borderRadius: 14, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 13px 5px", gap: 8 }}>
        <span style={{ ...chip, color: P.ink, fontFamily: UI, fontSize: 12.5, fontWeight: 500 }}>{title}</span>
        <span style={chip}>{(cfg.ch ?? 0) === 0 ? "frontal" : "occipital"}</span>
      </div>
      <canvas ref={traceRef} role="img" aria-label={`Live EEG trace, ${title}, ${Math.round(ro.pp)} microvolts peak to peak`} style={{ display: "block", width: "100%", height: trace }} />
      <canvas ref={specRef} role="img" aria-label={`Density spectral array, 0 to 40 hertz, spectral edge frequency ${ro.sef.toFixed(1)} hertz`} style={{ display: "block", width: "100%", height: spec }} />
      <div style={{ display: "flex", gap: 12, padding: "2px 13px 4px", flexWrap: "wrap", alignItems: "center" }}>
        <span style={chip}>{Math.round(ro.pp)} µV</span>
        <span style={chip}>SEF95 {ro.sef.toFixed(1)}</span>
        <span style={{ ...chip, color: ro.bsr > 0.05 ? P.warn : P.dim }}>BSR {(ro.bsr * 100).toFixed(0)}%</span>
        {cfg.transient ? (
          <span style={{ ...chip, color: P.accent }}>{Math.round(ro.dur * 1000)} ms · {Math.round(ro.amp)} µV pk</span>
        ) : null}
        <span style={{ ...chip, color: sqiCol, marginLeft: "auto" }}>Q{Math.round(ro.sqi)}</span>
        {onPause ? (
          <button onClick={onPause} aria-label={cfg.paused ? "Resume the trace" : "Still the trace"} style={{
            background: "none", border: "none", cursor: "pointer", padding: "0 4px", minHeight: 36,
            fontFamily: MN, fontSize: 11, color: cfg.paused ? P.accent : P.dim,
          }}>{cfg.paused ? "resume" : "still"}</button>
        ) : null}
      </div>
    </div>
  );
}

/* ---- primitives ---------------------------------------------------------- */

function Btn({ children, onClick, kind = "ghost", full, size = "md" }) {
  const base = {
    fontFamily: UI, fontWeight: 600, cursor: "pointer", borderRadius: 12,
    minHeight: size === "lg" ? 52 : 44, padding: size === "lg" ? "0 22px" : "0 16px",
    fontSize: size === "lg" ? 16 : 14.5, width: full ? "100%" : undefined,
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
  };
  const kinds = {
    primary: { background: P.accent, color: P.bg, border: "none" },
    ghost: { background: "transparent", color: P.ink, border: `1px solid ${P.line}` },
    quiet: { background: P.surface2, color: P.ink, border: "none" },
  };
  return <button style={{ ...base, ...kinds[kind] }} onClick={onClick}>{children}</button>;
}

function Pill({ children, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      fontFamily: UI, fontSize: 13, fontWeight: 500, cursor: "pointer",
      borderRadius: 999, minHeight: 38, padding: "0 15px",
      background: active ? P.accent : P.surface2, color: active ? P.bg : P.dim, border: "none",
    }}>{children}</button>
  );
}

function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <span style={{ display: "flex", justifyContent: "space-between", fontFamily: UI, fontSize: 13, color: P.dim, marginBottom: 9 }}>
        <span>{label}</span><span style={{ color: P.accent, fontFamily: MN, fontSize: 12.5 }}>{fmt(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={`${label}, currently ${fmt(value)}`}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  );
}

function Ring({ done, total, size = 54 }) {
  const r = (size - 6) / 2, cx = size / 2, circ = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }} role="img" aria-label={`${done} of ${total} modules complete`}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={P.line} strokeWidth="4" />
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={P.accent} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={`${circ * frac} ${circ}`} transform={`rotate(-90 ${cx} ${cx})`} />
      <text x={cx} y={cx + 5} textAnchor="middle" style={{ fontFamily: UI, fontSize: 15, fontWeight: 600, fill: P.ink }}>{done}</text>
    </svg>
  );
}

function Dots({ n, i }) {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
      {Array.from({ length: n }, (_, k) => (
        <span key={k} style={{
          height: 4, borderRadius: 2, flex: k === i ? "0 0 18px" : "0 0 4px",
          background: k === i ? P.accent : k < i ? P.dim : P.line,
        }} />
      ))}
    </div>
  );
}

/* ---- controls ------------------------------------------------------------ */

function ArtefactControls({ cfg, setCfg }) {
  const art = cfg.art || {};
  const set = (k, v) => setCfg({ ...cfg, art: { ...art, [k]: v } });
  return (
    <div>
      {[["emg", "Frontalis EMG", "physiological"], ["eye", "Blink / eye movement", "physiological"],
        ["mains", "Mains interference", "technical"], ["pop", "Electrode pop / drift", "technical"]].map(([k, l, kind]) => (
        <Slider key={k} label={`${l} · ${kind}`} value={art[k] || 0} min={0} max={1} step={0.05}
          onChange={(v) => set(k, v)} fmt={(v) => `${Math.round(v * 100)}%`} />
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Pill active={(art.mainsHz || 50) === 50} onClick={() => set("mainsHz", 50)}>50 Hz</Pill>
        <Pill active={(art.mainsHz || 50) === 60} onClick={() => set("mainsHz", 60)}>60 Hz</Pill>
        <Pill onClick={() => setCfg({ ...cfg, art: {} })}>Clear</Pill>
      </div>
    </div>
  );
}

function CaseScrubber({ cfg, setCfg }) {
  const p = cfg.casePos ?? 0;
  const ph = casePhase(p);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontFamily: UI, fontSize: 15, fontWeight: 600, color: P.accent }}>{ph.n}</span>
        <span style={{ fontFamily: MN, fontSize: 11.5, color: P.dim }}>{Math.round(p * 100)}%</span>
      </div>
      <input type="range" min={0} max={1} step={0.005} value={p} aria-label={`Position through the case, currently ${ph.n}`}
        onChange={(e) => setCfg({ ...cfg, casePos: parseFloat(e.target.value) })} />
      <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.5, color: P.dim, margin: "10px 0 12px" }}>{ph.d}</p>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, WebkitOverflowScrolling: "touch" }}>
        {CASE_KEYS.map((k) => (
          <button key={k.n} onClick={() => setCfg({ ...cfg, casePos: k.p })} style={{
            fontFamily: UI, fontSize: 12.5, whiteSpace: "nowrap", cursor: "pointer",
            borderRadius: 999, minHeight: 36, padding: "0 13px", border: "none",
            background: Math.abs(p - k.p) < 0.02 ? P.accent : P.surface2,
            color: Math.abs(p - k.p) < 0.02 ? P.bg : P.dim,
          }}>{k.n}</button>
        ))}
      </div>
    </div>
  );
}

function ComboControls({ cfg, setCfg }) {
  const cur = cfg.combo || "propofol+remifentanil";
  const c = COMBOS[cur];
  return (
    <div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
        {Object.entries(COMBOS).map(([k, v]) => (
          <Pill key={k} active={cur === k} onClick={() => setCfg({ ...cfg, combo: k, casePos: null })}>{v.label}</Pill>
        ))}
      </div>
      <div style={{ background: P.surface2, borderRadius: 12, padding: "12px 14px" }}>
        <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
          color: c.sourced ? P.ok : P.warn, margin: "0 0 5px" }}>
          {c.sourced ? "Sourced" : "Teaching interpolation"}
        </p>
        <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.5, color: P.dim, margin: 0 }}>{c.note}</p>
      </div>
    </div>
  );
}

function BandControls({ cfg, setCfg }) {
  const cur = cfg.band || "alpha";
  const b = BAND_DEMO[cur];
  return (
    <div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
        {Object.entries(BAND_DEMO).map(([k, v]) => (
          <Pill key={k} active={cur === k} onClick={() => setCfg({ ...cfg, band: k, transient: null, casePos: null, combo: null })}>{v.label}</Pill>
        ))}
      </div>
      <div style={{ background: P.surface2, borderRadius: 12, padding: "12px 14px" }}>
        <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: P.accent, margin: "0 0 5px" }}>
          {b.band} · {b.lo} to {b.hi} Hz · {Math.round(1000 / b.f)} ms a cycle
        </p>
        <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.5, color: P.dim, margin: 0 }}>{b.note}</p>
      </div>
    </div>
  );
}

function ElementControls({ cfg, setCfg }) {
  const kind = (cfg.transient && cfg.transient.kind) || "kcomplex";
  const spec = TRANSIENTS[kind];
  return (
    <div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
        {Object.entries(TRANSIENTS).map(([k, v]) => (
          <Pill key={k} active={kind === k}
            onClick={() => setCfg({ ...cfg, state: "quiet", transient: { kind: k, period: 3.0 } })}>{v.label}</Pill>
        ))}
      </div>
      <div style={{ background: P.surface2, borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
        <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
          color: spec.sourced ? P.ok : P.warn, margin: "0 0 5px" }}>
          {spec.label} · {spec.measures || "duration"} {Math.round(spec.dur * 1000)} ms{spec.sourced ? "" : " · criterion not in a held source"}
        </p>
        <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.5, color: P.dim, margin: 0 }}>{spec.note}</p>
      </div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        <Pill active={(cfg.polarity || "neg-up") === "neg-up"} onClick={() => setCfg({ ...cfg, polarity: "neg-up" })}>Negative up</Pill>
        <Pill active={cfg.polarity === "pos-up"} onClick={() => setCfg({ ...cfg, polarity: "pos-up" })}>Positive up</Pill>
        <Pill onClick={() => setCfg({ ...cfg, transient: null, state: "nrem2" })}>See it in NREM 2</Pill>
      </div>
    </div>
  );
}

function Control({ which, cfg, setCfg }) {
  if (which === "band") return <BandControls cfg={cfg} setCfg={setCfg} />;
  if (which === "element") return <ElementControls cfg={cfg} setCfg={setCfg} />;
  if (which === "bsr") return <Slider label="Depth · burst suppression ratio" value={cfg.bsr || 0} min={0} max={1} step={0.05} onChange={(v) => setCfg({ ...cfg, bsr: v })} fmt={(v) => `${Math.round(v * 100)}%`} />;
  if (which === "age") return <Slider label="Patient age" value={cfg.age} min={0.08} max={95} step={0.08} onChange={(v) => setCfg({ ...cfg, age: v })} fmt={(v) => (v < 1 ? `${Math.round(v * 12)} mo` : `${Math.round(v)} yr`)} />;
  if (which === "art") return <ArtefactControls cfg={cfg} setCfg={setCfg} />;
  if (which === "case") return <CaseScrubber cfg={cfg} setCfg={setCfg} />;
  if (which === "combo") return <ComboControls cfg={cfg} setCfg={setCfg} />;
  if (which === "display") return (
    <div>
      <Slider label="Trace window" value={cfg.window} min={2} max={10} step={1} onChange={(v) => setCfg({ ...cfg, window: v })} fmt={(v) => `${v} s`} />
      <Slider label="Vertical scale" value={cfg.scale} min={40} max={500} step={10} onChange={(v) => setCfg({ ...cfg, scale: v })} fmt={(v) => `${v} µV`} />
    </div>
  );
  return null;
}


/* ---- drill scheduling ----------------------------------------------------
   A three-box Leitner queue. An item answered correctly moves up a box and is
   seen less often; a wrong answer sends it back to box 1. Items you have never
   seen come first. Replaces "next record = idx + 1", which showed every item
   once, in the same order, forever.                                          */

function nextDrill(prog, currentIdx, pool) {
  const box = (prog.drill && prog.drill.box) || {};
  const candidates = pool.map((d, i) => i).filter((i) => i !== currentIdx);
  const unseen = candidates.filter((i) => box[i] === undefined);
  if (unseen.length) return unseen[Math.floor(Math.random() * unseen.length)];
  // weight by box: box 1 is four times as likely as box 3
  const weights = candidates.map((i) => 1 / Math.max(1, box[i] || 1) ** 2);
  const total = weights.reduce((a, w) => a + w, 0);
  let r = Math.random() * total;
  for (let k = 0; k < candidates.length; k++) { r -= weights[k]; if (r <= 0) return candidates[k]; }
  return candidates[0];
}

function scoreDrill(prog, idx, right, mod) {
  const d = prog.drill || {};
  const box = { ...(d.box || {}) };
  box[idx] = right ? Math.min(3, (box[idx] || 1) + 1) : 1;
  const byMod = { ...(d.byMod || {}) };
  const m = byMod[mod] || { seen: 0, right: 0 };
  byMod[mod] = { seen: m.seen + 1, right: m.right + (right ? 1 : 0) };
  return { ...prog, drill: { ...d, seen: (d.seen || 0) + 1, right: (d.right || 0) + (right ? 1 : 0), box, byMod } };
}

/* ---- screens ------------------------------------------------------------- */

function Landing({ onStart, onSkip }) {
  const mins = MODULES.reduce((a, m) => a + m.mins, 0);
  const fact = { fontFamily: UI, fontSize: 14.5, lineHeight: 1.5, color: P.dim, margin: "0 0 9px", paddingLeft: 15, position: "relative" };
  const dot = { position: "absolute", left: 0, top: 8, width: 5, height: 5, borderRadius: 3, background: P.accent };
  return (
    <div>
      <Scope cfg={{ state: "propofol", ch: 0, age: 40, bsr: 0, window: 5, scale: 220, map: "jet", art: {} }} trace={112} spec={112} />

      <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: P.accent, margin: "22px 0 8px" }}>
        A teaching instrument
      </p>
      <h1 style={{ fontFamily: UI, fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.1, margin: "0 0 12px" }}>
        Reading the EEG
      </h1>
      <p style={{ fontFamily: UI, fontSize: 17, lineHeight: 1.45, color: P.ink, margin: "0 0 22px" }}>
        Fourteen modules on the raw EEG and the density spectral array, for anaesthetists learning to read
        the brain rather than the number. Everything above is live and running now.
      </p>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "0 0 20px", marginBottom: 20, borderBottom: `1px solid ${P.line}` }}>
        <span style={{ fontFamily: UI, fontSize: 15, fontWeight: 600, color: P.ink }}>{AUTHOR}</span>
        <span style={{ fontFamily: UI, fontSize: 13.5, color: P.dim }}>{CREDENTIALS}</span>
      </div>

      <div style={{ background: P.surface, borderRadius: 14, padding: "16px 17px", marginBottom: 18 }}>
        <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.dim, margin: "0 0 11px" }}>Before you start</p>
        <p style={fact}><span style={dot} />{MODULES.length} modules, {mins} minutes, designed for separate sittings. It remembers where you stopped.</p>
        <p style={fact}><span style={dot} />Every waveform is synthesised from published parameters. It teaches recognition, not acquisition, and it is not a patient.</p>
        <p style={fact}><span style={dot} />Nothing is downloaded and nothing is sent anywhere. Your progress stays on this device.</p>
        <p style={{ ...fact, margin: 0 }}><span style={dot} />Mapped to the ESAIC 2026 learning outcomes, but it cannot certify you against them.</p>
      </div>

      <Btn kind="primary" size="lg" full onClick={onStart}>Start at the beginning</Btn>
      <div style={{ marginTop: 10 }}>
        <Btn kind="ghost" full onClick={onSkip}>I already read raw EEG — skip the foundations</Btn>
      </div>
      <p style={{ fontFamily: UI, fontSize: 13, lineHeight: 1.5, color: P.dim, margin: "16px 0 0", textAlign: "center" }}>
        You can reopen this from More.
      </p>
    </div>
  );
}

function Home({ prog, onOpen, onSession }) {
  const done = Object.keys(prog.done).length;
  const resume = prog.last && MODULES[prog.last.mi] ? prog.last : null;
  const nextIdx = resume ? resume.mi : MODULES.findIndex((m) => !prog.done[m.id]);
  const next = MODULES[nextIdx === -1 ? MODULES.length - 1 : nextIdx];
  const mins = MODULES.filter((m) => !prog.done[m.id]).reduce((a, m) => a + m.mins, 0);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
        <Ring done={done} total={MODULES.length} />
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontFamily: UI, fontSize: 21, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Reading the EEG</h1>
          <p style={{ fontFamily: UI, fontSize: 13.5, color: P.dim, margin: "3px 0 0" }}>
            {done ? `${done} of ${MODULES.length} done · ${mins} min left` : `${MODULES.length} modules · ${mins} min`}
          </p>
        </div>
      </div>

      <button onClick={() => onOpen(MODULES.indexOf(next), resume ? resume.pi : 0)} style={{
        width: "100%", textAlign: "left", cursor: "pointer", border: "none",
        background: P.surface, borderRadius: 16, padding: "16px 17px", marginBottom: 22,
        display: "flex", alignItems: "center", gap: 15,
      }}>
        <span style={{ fontFamily: NUM, fontSize: 38, lineHeight: 1, color: P.accent, fontWeight: 500 }}>{next.n}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.dim, marginBottom: 3 }}>
            {resume ? `Resume · point ${resume.pi + 1}` : done ? "Continue" : "Start here"}
          </span>
          <span style={{ display: "block", fontFamily: UI, fontSize: 17, fontWeight: 600, color: P.ink, lineHeight: 1.25 }}>{next.title}</span>
          <span style={{ display: "block", fontFamily: UI, fontSize: 13, color: P.dim, marginTop: 3 }}>{next.mins} min · {next.points.length} points</span>
        </span>
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10 }}>
        <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.dim, margin: 0 }}>All modules</p>
        <button onClick={() => onOpen(5, 0)} style={{
          background: "none", border: "none", cursor: "pointer", padding: "6px 0",
          fontFamily: UI, fontSize: 13, fontWeight: 600, color: P.accent, minHeight: 36,
        }}>Skip the foundations ›</button>
      </div>
      <p style={{ fontFamily: UI, fontSize: 13.5, lineHeight: 1.5, color: P.dim, margin: "0 0 12px" }}>
        Modules 01 to 05 are foundations — why to look, the two displays, the bands, morphology and artefacts.
        If you already read raw EEG, start at Awake, and asleep.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {MODULES.map((m, i) => {
          const isDone = !!prog.done[m.id];
          return (
            <button key={m.id} onClick={() => onOpen(i)} style={{
              width: "100%", textAlign: "left", cursor: "pointer", border: "none",
              background: P.surface, borderRadius: 12, padding: "13px 15px",
              display: "flex", alignItems: "center", gap: 13, minHeight: 56,
            }}>
              <span style={{ fontFamily: NUM, fontSize: 19, color: isDone ? P.ok : P.dim, width: 26, flexShrink: 0 }}>{m.n}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontFamily: UI, fontSize: 15.5, fontWeight: 600, color: P.ink, lineHeight: 1.3 }}>{m.title}</span>
                <span style={{ display: "block", fontFamily: UI, fontSize: 12.5, color: P.dim, marginTop: 2 }}>{m.mins} min · {m.codes.join(" ")}</span>
              </span>
              {isDone ? <span style={{ color: P.ok, fontSize: 16 }} aria-label="complete">✓</span> : null}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 18 }}>
        <Btn kind="ghost" full onClick={onSession}>Run as a teaching session</Btn>
      </div>
    </div>
  );
}

function ModuleScreen({ mi, pi, setPi, cfg, setCfg, onBack, onDone, narrow }) {
  const [notes, setNotes] = useState(false);
  const mod = MODULES[mi];
  const pt = mod.points[Math.min(pi, mod.points.length - 1)];
  const last = pi === mod.points.length - 1;
  const ref = REFS[pt.r];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} aria-label="Back to all modules" style={{
          background: P.surface2, border: "none", borderRadius: 10, width: 40, height: 40,
          color: P.ink, fontSize: 19, cursor: "pointer", flexShrink: 0,
        }}>‹</button>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontFamily: UI, fontSize: 15.5, fontWeight: 600, lineHeight: 1.25,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mod.title}</span>
          <span style={{ display: "block", fontFamily: MN, fontSize: 11.5, color: P.dim, marginTop: 1 }}>{mod.n} · {pi + 1} of {mod.points.length}</span>
        </span>
        <button onClick={() => setNotes(!notes)} aria-label="Teaching notes" style={{
          background: notes ? P.accent : P.surface2, border: "none", borderRadius: 10, minWidth: 40, height: 40,
          color: notes ? P.bg : P.dim, fontFamily: UI, fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0,
        }}>T</button>
      </div>

      {notes ? (
        <div style={{ background: P.surface, borderRadius: 12, padding: "13px 15px", marginBottom: 14, borderLeft: `3px solid ${P.accent}` }}>
          <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.accent, margin: "0 0 6px" }}>Teaching notes</p>
          <p style={{ fontFamily: UI, fontSize: 15, lineHeight: 1.55, color: P.ink, margin: "0 0 8px" }}>{mod.prompt}</p>
          <p style={{ fontFamily: MN, fontSize: 11.5, color: P.dim, margin: 0 }}>{mod.codes.join(" · ")}</p>
        </div>
      ) : null}

      <Scope cfg={cfg} trace={narrow ? 96 : 132} spec={narrow ? 96 : 132} onPause={() => setCfg({ ...cfg, paused: !cfg.paused })} />

      <div style={{ margin: "16px 0 14px" }}><Dots n={mod.points.length} i={pi} /></div>

      <p style={{ fontFamily: UI, fontSize: narrow ? 18.5 : 21, lineHeight: 1.42, fontWeight: 500, margin: "0 0 14px", letterSpacing: "-0.01em" }}>{pt.t}</p>

      {pt.look ? (
        <div style={{ background: P.surface, borderRadius: 12, padding: "12px 14px", marginBottom: 16 }}>
          <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.accent, margin: "0 0 5px" }}>Look for</p>
          <p style={{ fontFamily: UI, fontSize: 15, lineHeight: 1.5, color: P.ink, margin: 0 }}>{pt.look}</p>
        </div>
      ) : null}

      {pt.ctrl ? <div style={{ marginBottom: 14 }}><Control which={pt.ctrl} cfg={cfg} setCfg={setCfg} /></div> : null}

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <Pill active={(cfg.ch ?? 0) === 0} onClick={() => setCfg({ ...cfg, ch: 0 })}>Frontal</Pill>
        <Pill active={cfg.ch === 1} onClick={() => setCfg({ ...cfg, ch: 1 })}>Occipital</Pill>
      </div>

      <p style={{ fontFamily: MN, fontSize: 11.5, color: ref && ref.ok ? P.dim : P.warn, margin: "0 0 16px" }}>
        {ref ? ref.s + (ref.ok ? "" : " · flagged") : ""}
      </p>

      <div style={{ display: "flex", gap: 10 }}>
        {pi > 0 ? <Btn kind="quiet" onClick={() => setPi(pi - 1)}>Back</Btn> : null}
        <div style={{ flex: 1 }}>
          <Btn kind="primary" size="lg" full onClick={() => (last ? onDone() : setPi(pi + 1))}>
            {last ? "Finish module" : "Next"}
          </Btn>
        </div>
      </div>

    </div>
  );
}

function DrillScreen({ prog, persist, cfg, setCfg, narrow, only, onDone }) {
  const pool = only ? DRILLS.filter((d) => d.mod === only) : DRILLS;
  const [idx, setIdx] = useState(() => (only ? 0 : (prog.drill && prog.drill.idx) || 0));
  const [picked, setPicked] = useState(null);
  const [asked, setAsked] = useState(0);
  const d = pool[idx % pool.length];
  const load = (i) => {
    const nd = pool[i % pool.length];
    setIdx(i % pool.length); setPicked(null);
    setCfg((c) => ({ ...c, bsr: 0, age: 40, ch: 0, art: {}, casePos: null, combo: null, transient: null, band: null, polarity: 'neg-up', window: 5, scale: 200, ...nd.cfg }));
  };
  useEffect(() => { load(idx); }, []); // eslint-disable-line
  const answer = (o) => {
    if (picked) return;
    setPicked(o);
    setAsked(asked + 1);
    const globalIdx = DRILLS.indexOf(d);
    const p = scoreDrill(prog, globalIdx, o === d.a, d.mod);
    persist({ ...p, drill: { ...p.drill, idx: only ? p.drill.idx : idx } });
  };
  const pct = prog.drill.seen ? Math.round((prog.drill.right / prog.drill.seen) * 100) : null;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h1 style={{ fontFamily: UI, fontSize: 21, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          {only ? "Module check" : "Drill"}
        </h1>
        <span style={{ fontFamily: MN, fontSize: 12, color: P.dim }}>
          {pct !== null ? `${prog.drill.right}/${prog.drill.seen} · ${pct}%` : "no attempts"}
        </span>
      </div>
      <Scope cfg={cfg} trace={narrow ? 96 : 132} spec={narrow ? 96 : 132} />
      <p style={{ fontFamily: MN, fontSize: 11, color: P.dim, margin: "14px 0 8px" }}>
        {only ? `Question ${asked + (picked ? 0 : 1)} · module ${d.mod}` : `Module ${d.mod} · box ${(prog.drill.box || {})[DRILLS.indexOf(d)] || 1} of 3`}
      </p>
      <p style={{ fontFamily: UI, fontSize: narrow ? 18.5 : 21, fontWeight: 600, lineHeight: 1.35, margin: "0 0 16px", letterSpacing: "-0.01em" }}>{d.q}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {d.opts.map((o) => {
          const isA = picked && o === d.a;
          const isW = picked && o === picked && o !== d.a;
          return (
            <button key={o} onClick={() => answer(o)} style={{
              width: "100%", textAlign: "left", cursor: picked ? "default" : "pointer",
              minHeight: 52, padding: "13px 16px", borderRadius: 12, fontFamily: UI,
              fontSize: 15.5, fontWeight: 500, lineHeight: 1.35,
              background: isA ? "rgba(95,191,143,0.14)" : isW ? "rgba(224,121,110,0.14)" : P.surface,
              color: isA ? P.ok : isW ? P.warn : P.ink,
              border: `1px solid ${isA ? P.ok : isW ? P.warn : "transparent"}`,
            }}>{o}</button>
          );
        })}
      </div>
      {picked ? (
        <div style={{ background: P.surface, borderRadius: 12, padding: "13px 15px", marginBottom: 16 }}>
          <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
            color: picked === d.a ? P.ok : P.warn, margin: "0 0 6px" }}>
            {picked === d.a ? "Correct" : `Answer: ${d.a}`}
          </p>
          <p style={{ fontFamily: UI, fontSize: 15, lineHeight: 1.55, margin: 0 }}>{d.why}</p>
        </div>
      ) : null}
      {only && asked >= Math.min(3, pool.length) && picked ? (
        <Btn kind="primary" size="lg" full onClick={onDone}>Finish check</Btn>
      ) : (
        <Btn kind="primary" size="lg" full onClick={() => load(only ? (idx + 1) % pool.length : nextDrill(prog, DRILLS.indexOf(d), DRILLS))}>
          Next record
        </Btn>
      )}
    </div>
  );
}

function BenchScreen({ cfg, setCfg, narrow }) {
  const section = { fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.dim, margin: "22px 0 10px" };
  return (
    <div>
      <h1 style={{ fontFamily: UI, fontSize: 21, fontWeight: 700, margin: "0 0 14px", letterSpacing: "-0.02em" }}>Bench</h1>
      <Scope cfg={cfg} trace={narrow ? 104 : 140} spec={narrow ? 104 : 140} />
      <p style={section}>State or agent</p>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {Object.keys(STATES).filter((k) => k !== "quiet").map((s) => (
          <Pill key={s} active={cfg.state === s && !cfg.combo && cfg.casePos == null}
            onClick={() => setCfg({ ...cfg, state: s, combo: null, casePos: null })}>{STATES[s].label}</Pill>
        ))}
      </div>
      <p style={section}>One band at a time</p>
      <BandControls cfg={cfg} setCfg={setCfg} />
      <p style={section}>Waveform elements</p>
      <ElementControls cfg={cfg} setCfg={setCfg} />
      <p style={section}>Combinations</p>
      <ComboControls cfg={cfg} setCfg={setCfg} />
      <p style={section}>The case</p>
      <CaseScrubber cfg={cfg} setCfg={setCfg} />
      <p style={section}>Artefacts</p>
      <ArtefactControls cfg={cfg} setCfg={setCfg} />
      <p style={section}>Display</p>
      <Slider label="Patient age" value={cfg.age} min={0.08} max={95} step={0.08} onChange={(v) => setCfg({ ...cfg, age: v })} fmt={(v) => (v < 1 ? `${Math.round(v * 12)} mo` : `${Math.round(v)} yr`)} />
      <Slider label="Burst suppression ratio" value={cfg.bsr || 0} min={0} max={1} step={0.05} onChange={(v) => setCfg({ ...cfg, bsr: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
      <Slider label="Trace window" value={cfg.window} min={2} max={10} step={1} onChange={(v) => setCfg({ ...cfg, window: v })} fmt={(v) => `${v} s`} />
      <Slider label="Vertical scale" value={cfg.scale} min={40} max={500} step={10} onChange={(v) => setCfg({ ...cfg, scale: v })} fmt={(v) => `${v} µV`} />
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        <Pill active={(cfg.ch ?? 0) === 0} onClick={() => setCfg({ ...cfg, ch: 0 })}>Frontal</Pill>
        <Pill active={cfg.ch === 1} onClick={() => setCfg({ ...cfg, ch: 1 })}>Occipital</Pill>
        <Pill active={cfg.map === "jet"} onClick={() => setCfg({ ...cfg, map: "jet" })}>Jet</Pill>
        <Pill active={cfg.map === "viridis"} onClick={() => setCfg({ ...cfg, map: "viridis" })}>Viridis</Pill>
      </div>
      <p style={{ fontFamily: UI, fontSize: 14, lineHeight: 1.55, color: P.dim, marginTop: 18 }}>
        Jet is the map used in the source papers and on most clinical monitors, so it is the default. Viridis is
        perceptually uniform. Learn on jet, because that is what theatre shows you.
      </p>
    </div>
  );
}

function RefScreen() {
  const [open, setOpen] = useState(LOOKUP[0].id);
  return (
    <div>
      <h1 style={{ fontFamily: UI, fontSize: 21, fontWeight: 700, margin: "0 0 6px", letterSpacing: "-0.02em" }}>Reference</h1>
      <p style={{ fontFamily: UI, fontSize: 13.5, lineHeight: 1.5, color: P.dim, margin: "0 0 16px" }}>
        Criteria and what a finding is consistent with. It does not tell you what to do — that judgement is yours and your department's.
      </p>

      {LOOKUP.map((card) => {
        const isOpen = open === card.id;
        const ref = REFS[card.r];
        return (
          <div key={card.id} style={{ background: P.surface, borderRadius: 14, marginBottom: 8, overflow: "hidden" }}>
            <button onClick={() => setOpen(isOpen ? null : card.id)} aria-label={card.title} style={{
              width: "100%", textAlign: "left", background: "transparent", border: "none", cursor: "pointer",
              minHeight: 54, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12,
              fontFamily: UI, fontSize: 16, fontWeight: 600, color: P.ink,
            }}>
              <span style={{ flex: 1 }}>{card.title}</span>
              <span style={{ color: P.accent, fontSize: 15, transform: isOpen ? "rotate(90deg)" : "none", display: "inline-block" }}>›</span>
            </button>
            {isOpen ? (
              <div style={{ padding: "0 16px 14px" }}>
                {card.rows.map((row) => (
                  <div key={row[0]} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "7px 0", borderTop: `1px solid ${P.line}` }}>
                    <span style={{ fontFamily: UI, fontSize: 14.5, fontWeight: 600, color: P.ink, flex: "0 0 42%", lineHeight: 1.35 }}>{row[0]}</span>
                    <span style={{ fontFamily: UI, fontSize: 14.5, color: P.dim, flex: 1, lineHeight: 1.35 }}>{row[1]}</span>
                  </div>
                ))}
                {card.foot ? (
                  <p style={{ fontFamily: UI, fontSize: 13.5, lineHeight: 1.5, color: P.dim, margin: "11px 0 0", paddingTop: 10, borderTop: `1px solid ${P.line}` }}>{card.foot}</p>
                ) : null}
                <p style={{ fontFamily: MN, fontSize: 11, color: ref && ref.ok ? P.dim : P.warn, margin: "9px 0 0" }}>
                  {ref ? ref.s + (ref.ok ? "" : " · flagged") : ""}
                </p>
              </div>
            ) : null}
          </div>
        );
      })}

      <div style={{ background: P.surface, borderRadius: 14, padding: "15px 16px", marginTop: 14, borderLeft: `3px solid ${P.accent}` }}>
        <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.accent, margin: "0 0 7px" }}>{REAL_RECORDS.title}</p>
        <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.55, color: P.ink, margin: "0 0 12px" }}>{REAL_RECORDS.body}</p>
        {REAL_RECORDS.links.map((l) => (
          <div key={l[0]} style={{ marginBottom: 10 }}>
            <span style={{ display: "block", fontFamily: UI, fontSize: 14.5, fontWeight: 600, color: P.ink }}>{l[0]}</span>
            <span style={{ display: "block", fontFamily: UI, fontSize: 13.5, lineHeight: 1.45, color: P.dim, margin: "2px 0" }}>{l[1]}</span>
            <span style={{ display: "block", fontFamily: MN, fontSize: 12, color: P.accent }}>{l[2]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MoreScreen({ prog, persist }) {
  const [panel, setPanel] = useState("framework");
  const all = FRAMEWORK.flatMap(([, , items]) => items);
  const n2 = all.filter((i) => i[2] === 2).length;
  const n1 = all.filter((i) => i[2] === 1).length;
  const n0 = all.filter((i) => i[2] === 0).length;
  const dot = (s) => (s === 2 ? P.ok : s === 1 ? P.accent : P.line);
  const word = (s) => (s === 2 ? "covered" : s === 1 ? "partly covered" : "out of scope");
  return (
    <div>
      <h1 style={{ fontFamily: UI, fontSize: 21, fontWeight: 700, margin: "0 0 14px", letterSpacing: "-0.02em" }}>More</h1>
      <div style={{ display: "flex", gap: 7, marginBottom: 18 }}>
        <Pill active={panel === "framework"} onClick={() => setPanel("framework")}>Framework</Pill>
        <Pill active={panel === "sources"} onClick={() => setPanel("sources")}>Sources</Pill>
        <Pill active={panel === "about"} onClick={() => setPanel("about")}>About</Pill>
        <Pill active={panel === "reading"} onClick={() => setPanel("reading")}>Reading</Pill>
        <Pill active={panel === "reset"} onClick={() => setPanel("reset")}>Progress</Pill>
      </div>

      {panel === "framework" && (
        <>
          <p style={{ fontFamily: UI, fontSize: 18, fontWeight: 600, margin: "0 0 8px", lineHeight: 1.35 }}>
            {n2} covered · {n1} partly · {n0} out of scope
          </p>
          <p style={{ fontFamily: UI, fontSize: 14, lineHeight: 1.55, color: P.dim, margin: "0 0 20px" }}>
            Against the 58 learning outcomes in Berger-Estilita et al., Eur J Anaesthesiol 2026;43:1-12. That paper
            defines outcomes only — no assessment standard, no proficiency bar, no mapping to training year — so this
            programme cannot certify anyone against it. Seven of the twelve advanced outcomes are research and
            mentorship activities rather than EEG competencies.
          </p>
          {FRAMEWORK.map(([level, dim, items]) => (
            <div key={level + dim} style={{ marginBottom: 18 }}>
              <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: P.dim, margin: "0 0 8px" }}>{level} · {dim}</p>
              {items.map(([code, text, status, where]) => (
                <div key={code} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: P.surface, borderRadius: 10, padding: "10px 12px", marginBottom: 6 }}>
                  <span aria-label={word(status)} title={word(status)} style={{ width: 8, height: 8, borderRadius: 4, background: dot(status), flexShrink: 0, marginTop: 6 }} />
                  <span style={{ fontFamily: MN, fontSize: 11.5, color: P.accent, width: 42, flexShrink: 0, paddingTop: 1 }}>{code}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontFamily: UI, fontSize: 14.5, lineHeight: 1.4 }}>{text}</span>
                    <span style={{ display: "block", fontFamily: MN, fontSize: 11, color: status === 0 ? P.warn : P.dim, marginTop: 3 }}>{where}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      {panel === "sources" && (
        <>
          <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.55, margin: "0 0 16px" }}>
            Every waveform here is synthesised from published parameters. It is idealised — the only artefacts are the
            ones you switch on, and there is no electrode drift, no inter-patient variation and no pathology. It teaches
            recognition, not acquisition. {REAL_RECORDS.links.map((l) => l[2]).join(" and ")} are where to see real records.
          </p>
          {Object.entries(REFS).map(([k, r]) => (
            <div key={k} style={{ background: P.surface, borderRadius: 12, padding: "12px 14px", marginBottom: 8 }}>
              <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: r.ok ? P.accent : P.warn, margin: "0 0 5px" }}>
                {r.s}{r.ok ? "" : " · flagged"}
              </p>
              <p style={{ fontFamily: UI, fontSize: 13.5, lineHeight: 1.5, color: P.dim, margin: 0 }}>{r.full}</p>
              {r.doi ? <p style={{ fontFamily: MN, fontSize: 11.5, color: P.dim, margin: "4px 0 0" }}>doi {r.doi}</p> : null}
              {r.note ? <p style={{ fontFamily: UI, fontSize: 13, lineHeight: 1.5, color: P.warn, margin: "5px 0 0" }}>{r.note}</p> : null}
            </div>
          ))}
          <p style={{ fontFamily: UI, fontSize: 13, lineHeight: 1.5, color: P.dim, margin: "12px 0 0" }}>
            Declared conflicts. Berger-Estilita 2026: six authors report Medtronic travel support, four Medtronic speaker
            fees, two Masimo grants, one BIS and Narcotrend honoraria, one Medtronic consulting for EEG teaching;
            Medtronic owns BIS through Covidien. Purdon 2015 discloses a Masimo licensing agreement with MGH. Guay 2025:
            Brown cofounded Pascall Systems with royalties from Masimo and issued patents, Guay reports Masimo travel
            support, and recordings were made on a Masimo Sedline. Bong &amp; Yuan 2026 also declares a Masimo interest.
          </p>
        </>
      )}

      {panel === "about" && (
        <div>
          <h2 style={{ fontFamily: UI, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 10px" }}>Reading the EEG</h2>
          <p style={{ fontFamily: UI, fontSize: 15.5, lineHeight: 1.55, color: P.ink, margin: "0 0 14px" }}>
            {MODULES.length} modules, {MODULES.reduce((a, m) => a + m.mins, 0)} minutes, on the raw EEG and the density
            spectral array for anaesthetists learning to read the brain rather than the number.
          </p>
          <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.55, color: P.dim, margin: "0 0 14px" }}>
            Every waveform is synthesised from published parameters. It teaches recognition, not acquisition. It is
            mapped to the ESAIC 2026 learning outcomes and cannot certify anyone against them — that paper defines
            outcomes only and sets no assessment standard. Nothing is downloaded and no data leaves this device.
          </p>
          <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.55, color: P.dim, margin: "0 0 16px" }}>
            The sources every claim rests on are under Sources. What to read next is under Reading. Where to see real
            records is at the foot of the Reference tab.
          </p>
          <div style={{ padding: "14px 0 16px", marginBottom: 16, borderTop: `1px solid ${P.line}`, borderBottom: `1px solid ${P.line}` }}>
            <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.dim, margin: "0 0 6px" }}>Written by</p>
            <p style={{ fontFamily: UI, fontSize: 16, fontWeight: 600, color: P.ink, margin: "0 0 2px" }}>{AUTHOR}</p>
            <p style={{ fontFamily: UI, fontSize: 14, color: P.dim, margin: 0 }}>{CREDENTIALS}</p>
          </div>
          <Btn kind="ghost" full onClick={() => persist({ ...prog, seenIntro: false })}>Show the opening screen again</Btn>
        </div>
      )}

      {panel === "reading" && (
        <>
          <p style={{ fontFamily: UI, fontSize: 14.5, lineHeight: 1.55, color: P.dim, margin: "0 0 16px" }}>{FURTHER.note}</p>
          {FURTHER.items.map((it) => (
            <div key={it.doi} style={{ background: P.surface, borderRadius: 12, padding: "13px 15px", marginBottom: 8 }}>
              <p style={{ fontFamily: UI, fontSize: 15, fontWeight: 600, lineHeight: 1.35, margin: "0 0 4px" }}>{it.t}</p>
              <p style={{ fontFamily: UI, fontSize: 13, color: P.dim, margin: "0 0 6px" }}>{it.a} · {it.j}</p>
              <p style={{ fontFamily: UI, fontSize: 14, lineHeight: 1.5, color: P.ink, margin: "0 0 6px" }}>{it.w}</p>
              <p style={{ fontFamily: MN, fontSize: 11.5, color: P.accent, margin: 0 }}>doi {it.doi}</p>
            </div>
          ))}
        </>
      )}

      {panel === "reset" && (
        <div>
          <p style={{ fontFamily: UI, fontSize: 15, lineHeight: 1.55, color: P.dim, margin: "0 0 16px" }}>
            {Object.keys(prog.done).length} of {MODULES.length} modules complete.
            {prog.drill.seen ? ` ${prog.drill.right} of ${prog.drill.seen} drill records correct.` : " No drill attempts yet."}
          </p>
          <p style={{ fontFamily: UI, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.dim, margin: "0 0 10px" }}>Accuracy by module</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
            {MODULES.map((m) => {
              const a = (prog.drill.byMod || {})[m.n];
              const pct = a && a.seen ? Math.round((a.right / a.seen) * 100) : null;
              return (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 11, background: P.surface, borderRadius: 10, padding: "9px 12px" }}>
                  <span style={{ fontFamily: NUM, fontSize: 16, color: P.dim, width: 24, flexShrink: 0 }}>{m.n}</span>
                  <span style={{ flex: 1, minWidth: 0, fontFamily: UI, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</span>
                  <span style={{ height: 4, width: 54, background: P.line, borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
                    <span style={{ display: "block", height: 4, width: `${pct || 0}%`, background: pct === null ? P.line : pct >= 70 ? P.ok : P.warn }} />
                  </span>
                  <span style={{ fontFamily: MN, fontSize: 11.5, color: pct === null ? P.dim : pct >= 70 ? P.ok : P.warn, width: 44, textAlign: "right", flexShrink: 0 }}>
                    {pct === null ? "—" : `${pct}%`}
                  </span>
                </div>
              );
            })}
          </div>
          <Btn kind="ghost" full onClick={() => persist(EMPTY_PROG)}>Reset all progress</Btn>
        </div>
      )}
    </div>
  );
}

function Session({ mi, pi, setMi, setPi, cfg, setCfg, onExit }) {
  const mod = MODULES[mi];
  const pt = mod.points[Math.min(pi, mod.points.length - 1)];
  const next = () => { if (pi < mod.points.length - 1) setPi(pi + 1); else if (mi < MODULES.length - 1) { setMi(mi + 1); setPi(0); } };
  const prev = () => { if (pi > 0) setPi(pi - 1); else if (mi > 0) { setMi(mi - 1); setPi(MODULES[mi - 1].points.length - 1); } };
  useEffect(() => {
    const k = (e) => {
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); next(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <div style={{ minHeight: "100vh", background: P.bg, color: P.ink, fontFamily: UI, padding: "22px 20px 40px" }}>
      <div style={{ maxWidth: 940, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <span style={{ fontFamily: UI, fontSize: 14, fontWeight: 600, color: P.accent }}>{mod.n} · {mod.title}</span>
          <Btn kind="quiet" onClick={onExit}>Exit</Btn>
        </div>
        <Scope cfg={cfg} trace={170} spec={170} />
        <p style={{ fontSize: "clamp(21px, 3.4vw, 33px)", lineHeight: 1.34, fontWeight: 500, margin: "22px 0 12px", letterSpacing: "-0.015em" }}>{pt.t}</p>
        {pt.look ? <p style={{ fontSize: "clamp(15px, 2vw, 18px)", lineHeight: 1.5, color: P.dim, margin: "0 0 16px" }}>{pt.look}</p> : null}
        {pt.ctrl ? <div style={{ marginBottom: 16 }}><Control which={pt.ctrl} cfg={cfg} setCfg={setCfg} /></div> : null}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Btn kind="quiet" onClick={prev}>Back</Btn>
          <Btn kind="primary" onClick={next}>Next</Btn>
          <span style={{ fontFamily: MN, fontSize: 12, color: P.dim, marginLeft: "auto" }}>{pi + 1}/{mod.points.length}</span>
        </div>
        <p style={{ fontSize: 15, lineHeight: 1.55, color: P.dim, marginTop: 22, paddingTop: 16, borderTop: `1px solid ${P.line}` }}>{mod.prompt}</p>
        <p style={{ fontFamily: MN, fontSize: 11.5, color: P.dim, marginTop: 12 }}>Arrow keys to move · Esc to exit</p>
      </div>
    </div>
  );
}

/* ---- app ----------------------------------------------------------------- */

export function App() {
  const [tab, setTab] = useState("learn");
  const [view, setView] = useState("home");
  const [mi, setMi] = useState(0);
  const [pi, setPi] = useState(0);
  const [inSession, setInSession] = useState(false);
  const [showIntro, setShowIntro] = useState(false);
  const [cfg, setCfg] = useState({ state: "awake", ch: 0, age: 40, bsr: 0, window: 5, scale: 200, map: "jet", art: {} });
  const [prog, setProg] = useState(EMPTY_PROG);
  const { narrow } = useViewport();

  useEffect(() => {
    loadProgress().then((p) => {
      if (p) setProg(p);
      // the landing is orientation, not a gate: shown on the first run only,
      // and reachable from More afterwards
      if (!p || !p.seenIntro) setShowIntro(true);
    });
  }, []);
  const persist = useCallback((p) => { setProg(p); saveProgress(p); }, []);

  const pt = MODULES[mi].points[Math.min(pi, MODULES[mi].points.length - 1)];
  useEffect(() => {
    if (view === "module" && !inSession) persist({ ...prog, last: { mi, pi } });
  }, [mi, pi, view]); // eslint-disable-line
  useEffect(() => {
    if (view === "module" || inSession) {
      setCfg((c) => ({ ...c, bsr: 0, age: 40, ch: 0, art: {}, casePos: null, combo: null, transient: null, band: null, polarity: 'neg-up', window: 5, scale: 200, ...pt.cfg }));
    }
  }, [mi, pi, view, inSession]); // eslint-disable-line

  const openModule = (i, atPoint = 0) => { setMi(i); setPi(atPoint); setView("module"); };
  const finishModule = () => setView("check");
  const finishCheck = () => {
    persist({ ...prog, done: { ...prog.done, [MODULES[mi].id]: true }, last: null });
    if (mi < MODULES.length - 1) { setMi(mi + 1); setPi(0); setView("module"); } else setView("home");
  };

  if (inSession) {
    return <Session mi={mi} pi={pi} setMi={setMi} setPi={setPi} cfg={cfg} setCfg={setCfg} onExit={() => setInSession(false)} />;
  }

  const TABS = [["learn", "Learn"], ["drill", "Drill"], ["bench", "Bench"], ["ref", "Ref"], ["more", "More"]];

  return (
    <div style={{ minHeight: "100vh", background: P.bg, color: P.ink, fontFamily: UI }}>
      <Styles />
      <main style={{ maxWidth: 620, margin: "0 auto", padding: "20px 17px 108px" }}>
        {tab === "learn" && view === "home" && showIntro && (
          <Landing
            onStart={() => { persist({ ...prog, seenIntro: true }); setShowIntro(false); openModule(0, 0); }}
            onSkip={() => { persist({ ...prog, seenIntro: true }); setShowIntro(false); openModule(5, 0); }}
          />
        )}
        {tab === "learn" && view === "home" && !showIntro && (
          <Home prog={prog} onOpen={openModule} onSession={() => { setMi(0); setPi(0); setInSession(true); }} />
        )}
        {tab === "learn" && view === "check" && (
          <DrillScreen prog={prog} persist={persist} cfg={cfg} setCfg={setCfg} narrow={narrow}
            only={MODULES[mi].n} onDone={finishCheck} />
        )}
        {tab === "learn" && view === "module" && (
          <ModuleScreen mi={mi} pi={pi} setPi={setPi} cfg={cfg} setCfg={setCfg} narrow={narrow}
            onBack={() => setView("home")} onDone={finishModule} />
        )}
        {tab === "drill" && <DrillScreen prog={prog} persist={persist} cfg={cfg} setCfg={setCfg} narrow={narrow} />}
        {tab === "bench" && <BenchScreen cfg={cfg} setCfg={setCfg} narrow={narrow} />}
        {tab === "ref" && <RefScreen />}
        {tab === "more" && <MoreScreen prog={prog} persist={persist} />}
      </main>

      <nav style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 10,
        background: "rgba(14,17,22,0.94)", borderTop: `1px solid ${P.line}`,
        backdropFilter: "blur(12px)", paddingBottom: "env(safe-area-inset-bottom)",
      }}>
        <div style={{ maxWidth: 620, margin: "0 auto", display: "flex" }}>
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => { setTab(k); if (k === "learn") setView("home"); }}
              aria-label={l} style={{
                flex: 1, minHeight: 58, background: "transparent", border: "none", cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                color: tab === k ? P.accent : P.dim, fontFamily: UI, fontSize: 11.5, fontWeight: 600,
              }}>
              <span style={{ width: 20, height: 3, borderRadius: 2, background: tab === k ? P.accent : "transparent" }} />
              {l}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error("EEG programme error:", err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return React.createElement("div",
      { style: { minHeight: "100vh", background: P.bg, color: P.ink, fontFamily: UI, padding: "44px 20px" } },
      React.createElement("div", { style: { maxWidth: 560, margin: "0 auto" } },
        React.createElement("p", { style: { fontSize: 11.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: P.warn, margin: 0 } }, "Something broke"),
        React.createElement("h1", { style: { fontSize: 24, fontWeight: 700, margin: "6px 0 12px", letterSpacing: "-0.02em" } }, "The programme stopped."),
        React.createElement("p", { style: { fontSize: 15.5, lineHeight: 1.55, color: P.dim, margin: "0 0 16px" } },
          "Reload to carry on. Progress is saved per module, so you will come back where you were. If it happens again, the message below is what to report."),
        React.createElement("pre", { style: { fontFamily: MN, fontSize: 12.5, lineHeight: 1.5, color: P.warn, background: P.surface, borderRadius: 12, padding: "13px 15px", whiteSpace: "pre-wrap", margin: 0 } },
          String((this.state.err && this.state.err.message) || this.state.err))
      )
    );
  }
}

export default function Root() {
  return React.createElement(Boundary, null, React.createElement(App, null));
}

function Styles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Newsreader:wght@400;500&display=swap');
      *{ -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
      input[type=range]{ -webkit-appearance:none; appearance:none; width:100%; height:4px; background:${P.line}; border-radius:2px; }
      input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:26px; height:26px; border-radius:50%; background:${P.accent}; cursor:pointer; }
      input[type=range]::-moz-range-thumb{ width:26px; height:26px; border:0; border-radius:50%; background:${P.accent}; cursor:pointer; }
      button:focus-visible, input:focus-visible{ outline:2px solid ${P.accent}; outline-offset:3px; }
      button:active{ opacity:0.75; }
    `}</style>
  );
}
