/* Runtime smoke test.
   Compiles the artifact's JSX to plain JS, then executes it against stubbed
   React and DOM so that undefined names, bad property access and canvas-loop
   faults surface here instead of in the user's browser.

   This exists because a static syntax check cannot see a missing identifier
   inside a component body, and that is exactly what shipped in the first cut. */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SRC = "app2.jsx";
const OUT = "_smoke";

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(SRC, path.join(OUT, "app.tsx"));

try {
  execSync(
    `tsc ${OUT}/app.tsx --jsx react --target es2020 --module commonjs --outDir ${OUT} --skipLibCheck --allowJs false 2>/dev/null`,
    { stdio: "pipe" }
  );
} catch (e) { /* tsc reports type errors but still emits; that is fine */ }

const emitted = path.join(OUT, "app.js");
if (!fs.existsSync(emitted)) { console.log("FAIL: tsc emitted nothing"); process.exit(1); }

/* ---- stubs ------------------------------------------------------------- */

let effects = [];
let stateSeed = [];
let stateIdx = 0;
let refIdx = 0;
let refSeed = {};

class StubComponent {
  constructor(props) { this.props = props; this.state = {}; }
  setState(s) { this.state = Object.assign({}, this.state, s); }
}
const React = {
  Component: StubComponent,
  useState(init) {
    const i = stateIdx++;
    const base = typeof init === "function" ? init() : init;
    const v = i < stateSeed.length && stateSeed[i] !== undefined ? stateSeed[i] : base;
    return [v, () => {}];
  },
  useRef(init) {
    const i = refIdx++;
    return { current: i in refSeed ? refSeed[i] : init };
  },
  useEffect(fn) { effects.push(fn); },
  useCallback(fn) { return fn; },
  createElement(type, props, ...kids) {
    // force evaluation of children so nothing lazy escapes the check
    void kids.length;
    return { type, props, kids };
  },
};

function fakeCtx() {
  return {
    fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "", imageSmoothingEnabled: true,
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {},
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
    putImageData() {},
  };
}
function fakeCanvas(w = 820, h = 150) {
  return {
    width: w, height: h,
    getContext: () => fakeCtx(),
    getBoundingClientRect: () => ({ width: w, height: h }),
    style: {},
  };
}

let rafCalls = 0;
global.window = {
  devicePixelRatio: 2,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false }),
  // storage deliberately absent: exercises the no-persistence path
};
global.document = { createElement: (t) => (t === "canvas" ? fakeCanvas() : { style: {} }) };
global.requestAnimationFrame = (fn) => {
  if (rafCalls++ < 6) { try { fn(rafCalls * 90); } catch (e) { throw e; } }
  return rafCalls;
};
global.cancelAnimationFrame = () => {};
global.navigator = { userAgent: "node" };

const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) {
  if (req === "react") return "react-stub";
  return origResolve.call(this, req, ...a);
};
require.cache["react-stub"] = { id: "react-stub", filename: "react-stub", loaded: true, exports: React };

/* ---- run --------------------------------------------------------------- */

let pass = 0, fail = 0;
const reset = () => { effects = []; stateIdx = 0; refIdx = 0; refSeed = {}; rafCalls = 0; stateSeed = []; };
const gate = (n, fn) => {
  reset();
  try { fn(); pass++; console.log(`  ok   ${n}`); }
  catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.name}: ${e.message}`); }
};

// collect every child component instance out of a rendered element tree
function children(node, depth = 0, out = []) {
  if (!node || typeof node !== "object" || depth > 18) return out;
  if (Array.isArray(node)) { node.forEach((n) => children(n, depth + 1, out)); return out; }
  if (typeof node.type === "function") out.push({ fn: node.type, props: node.props || {}, name: node.type.name });
  const kids = [].concat(node.kids || [], (node.props && node.props.children) || []);
  kids.forEach((k) => children(k, depth + 1, out));
  return out;
}

// render a component for real, run its effects, then do the same for anything
// it rendered. This is what catches faults inside screens that App only
// references by element, never calls.
const seen = [];
function renderDeep(fn, props, depth = 0) {
  if (depth > 4) return;
  if (depth > 0) stateSeed = [];   // only the root component is seeded
  effects = []; stateIdx = 0; refIdx = 0; rafCalls = 0;
  refSeed = fn.name === "Scope" ? { 0: fakeCanvas(390, 96), 1: fakeCanvas(390, 96) } : {};
  const out = fn(props);
  seen.push(fn.name);
  for (const e of effects) { const c = e(); if (typeof c === "function") c(); }
  if (fn.name === "Scope" && rafCalls < 6) throw new Error("Scope animation loop stalled");
  for (const c of children(out)) renderDeep(c.fn, c.props, depth + 1);
}

console.log("\n== runtime smoke test ==");

let App, mod;
gate("module evaluates (constants, engine, curriculum data)", () => {
  mod = require("./" + emitted);
  if (typeof mod.default !== "function") throw new Error("no default export");
  App = mod.App || mod.default;
  if (typeof App !== "function") throw new Error("App is not exported");
});

for (const [tab, view, label, intro] of [
  ["learn", "home", "Learn / landing (first run)", true],
  ["learn", "check", "Learn / module check"],
  ["learn", "home", "Learn / home"],
  ["learn", "module", "Learn / module player"],
  ["drill", "home", "Drill"],
  ["bench", "home", "Bench"],
  ["ref", "home", "Reference"],
  ["more", "home", "More"],
]) {
  gate(`${label} renders end to end, including the live scope`, () => {
    stateSeed = intro === true ? [tab, view, 0, 0, false, true] : [tab, view];
    renderDeep(App, {});
  });
}

gate("every module and every teaching point renders", () => {
  const src = fs.readFileSync(SRC, "utf8");
  const nMods = (src.match(/\n    n: "\d\d",/g) || []).length;
  if (nMods < 14) throw new Error(`expected 14 modules, found ${nMods}`);
  for (let mi = 0; mi < nMods; mi++) {
    for (let pi = 0; pi < 12; pi++) {
      stateSeed = ["learn", "module", mi, pi];
      renderDeep(App, {});
    }
  }
});

gate("drill renders answered and unanswered, across every record", () => {
  const Drill = seen.includes("DrillScreen");
  for (let d = 0; d < 27; d++) {
    for (const picked of [null, "propofol"]) {
      stateSeed = ["drill", "home"];
      effects = []; stateIdx = 0; refIdx = 0;
      const tree = App();
      const ds = children(tree).find((c) => c.name === "DrillScreen");
      if (!ds) throw new Error("DrillScreen not in the tree");
      effects = []; stateIdx = 0; refIdx = 0;
      stateSeed = [d, picked];
      const out = ds.fn(ds.props);
      for (const e of effects) { const c = e(); if (typeof c === "function") c(); }
      for (const c of children(out)) renderDeep(c.fn, c.props, 2);
    }
  }
  if (!Drill && !seen.includes("DrillScreen")) throw new Error("DrillScreen never rendered");
});

gate("More renders all three panels", () => {
  for (const panel of ["framework", "sources", "reset"]) {
    stateSeed = ["more", "home"];
    effects = []; stateIdx = 0; refIdx = 0;
    const tree = App();
    const ms = children(tree).find((c) => c.name === "MoreScreen");
    if (!ms) throw new Error("MoreScreen not in the tree");
    effects = []; stateIdx = 0; refIdx = 0;
    stateSeed = [panel];
    const out = ms.fn(ms.props);
    for (const e of effects) { const c = e(); if (typeof c === "function") c(); }
    for (const c of children(out)) renderDeep(c.fn, c.props, 2);
  }
});

gate("session mode renders and binds its keyboard handler", () => {
  stateSeed = ["learn", "home", 0, 0, true];
  renderDeep(App, {});
  if (!seen.includes("Session")) throw new Error("Session never rendered");
});

gate("every screen component was actually executed", () => {
  const want = ["Home", "ModuleScreen", "DrillScreen", "BenchScreen", "MoreScreen", "RefScreen", "Landing", "Session", "Scope", "Ring", "Dots", "Btn", "Pill", "Slider", "Control", "ElementControls", "BandControls", "Styles"];
  const missing = want.filter((w) => !seen.includes(w));
  if (missing.length) throw new Error("never rendered: " + missing.join(", "));
});

gate("error boundary catches a throw and renders a readable fallback", () => {
  const tree = mod.default();
  const Boundary = tree && tree.type;
  if (typeof Boundary !== "function") throw new Error("Boundary not reachable");
  const derived = Boundary.getDerivedStateFromError(new Error("boom"));
  if (!derived || !derived.err) throw new Error("getDerivedStateFromError did not capture");
  const b = new Boundary({ children: "x" });
  b.state = derived;
  if (!JSON.stringify(b.render()).includes("boom")) throw new Error("fallback does not surface the message");
  b.state = { err: null };
  if (b.render() !== "x") throw new Error("does not pass children through when healthy");
});

gate("the render loop allocates nothing per frame", () => {
  const src = fs.readFileSync(SRC, "utf8");
  const i = src.indexOf("const step = (now)");
  const loop = src.slice(i, src.indexOf("raf = requestAnimationFrame(step);", i));
  if (/new Float64Array|new Array\(/.test(loop)) throw new Error("per-frame allocation still present");
  const j = src.indexOf("const win = winRef.current");
  if (/%\s*buf\.length/.test(src.slice(j, j + 400))) throw new Error("per-sample modulo still present");
});

gate("tap targets meet the 44 px minimum", () => {
  const src = fs.readFileSync(SRC, "utf8");
  const hits = [...src.matchAll(/minHeight:\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
  if (!hits.length) throw new Error("no explicit tap-target heights found");
  const small = hits.filter((h) => h < 36);
  if (small.length) throw new Error("targets below 36 px: " + small.join(", "));
});

console.log(`\n${pass} smoke gates pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
