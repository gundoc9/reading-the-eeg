/* Tests the mini renderer against the real application.
   The renderer is hand-written and cannot be tried in a browser here, so these
   tests carry the weight: they build a small DOM, mount the whole programme,
   drive state changes, and assert the properties a broken renderer would lose. */

const fs = require("fs");
const vm = require("vm");

/* ---- a small DOM ------------------------------------------------------- */

let nodeSeq = 0;
class Node {
  constructor(tag, ns) {
    this.tagName = tag; this.ns = ns || null; this.id = ++nodeSeq;
    this.childNodes = []; this.parentNode = null;
    this.attributes = {}; this.style = {}; this.listeners = {};
    this.value = ""; this._ctxCalls = 0;
  }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { const l = this.listeners[t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }
  getBoundingClientRect() { return { width: 390, height: 96 }; }
  getContext() {
    this._ctxCalls++;
    return {
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {}, putImageData() {},
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    };
  }
  get textContent() { return this.childNodes.map((c) => c.nodeValue !== undefined ? c.nodeValue : c.textContent).join(""); }
}
class TextNode { constructor(v) { this.nodeValue = String(v); this.parentNode = null; this.id = ++nodeSeq; } }

const document = {
  createElement: (t) => new Node(t),
  createElementNS: (ns, t) => new Node(t, ns),
  createTextNode: (v) => new TextNode(v),
};

/* ---- environment ------------------------------------------------------- */

let rafQueue = [], rafId = 0;
const sandbox = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Promise, Symbol,
  Float64Array, Uint8ClampedArray, Map, Set, isNaN, parseFloat, parseInt, setTimeout,
  document,
  queueMicrotask: (f) => f(),
  requestAnimationFrame: (f) => { rafQueue.push(f); return ++rafId; },
  cancelAnimationFrame: () => {},
  localStorage: { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.devicePixelRatio = 2;
sandbox.window.innerWidth = 390;
sandbox.window.addEventListener = () => {};
sandbox.window.removeEventListener = () => {};
sandbox.window.matchMedia = () => ({ matches: false });
sandbox.window.storage = {
  get: (k) => new Promise((res, rej) => { const v = sandbox.localStorage.getItem(k); v === null ? rej(new Error("none")) : res({ key: k, value: v }); }),
  set: (k, v) => new Promise((res) => { sandbox.localStorage.setItem(k, v); res({ key: k, value: v }); }),
};
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync("mini.js", "utf8"), sandbox);
vm.runInContext(fs.readFileSync("_standalone.js", "utf8"), sandbox);

/* ---- helpers ----------------------------------------------------------- */

let pass = 0, fail = 0;
const gate = (n, fn) => {
  try { fn(); pass++; console.log(`  ok   ${n}`); }
  catch (e) { fail++; console.log(`  FAIL ${n}\n         ${e.message}`); }
};
const walk = (n, fn) => { fn(n); (n.childNodes || []).forEach((c) => walk(c, fn)); };
const all = (root, tag) => { const out = []; walk(root, (n) => { if (n.tagName === tag) out.push(n); }); return out; };
const text = (root) => { let s = ""; walk(root, (n) => { if (n.nodeValue !== undefined) s += n.nodeValue + " "; }); return s.replace(/\s+/g, " "); };
const click = (n) => (n.listeners.click || []).forEach((f) => f({ preventDefault() {}, target: n }));
const flushRaf = (times) => { for (let i = 0; i < times; i++) { const q = rafQueue; rafQueue = []; q.forEach((f, k) => f(1000 + i * 90)); } };

console.log("\n== mini renderer, mounted with the real programme ==");

const container = new Node("div");
let root;
gate("the programme mounts", () => {
  root = sandbox.ReactDOM.createRoot(container);
  root.render(sandbox.React.createElement(sandbox.Root));
  if (!container.firstChild) throw new Error("nothing rendered");
});

gate("the home screen renders its module list", () => {
  const btns = all(container, "button");
  if (btns.length < 15) throw new Error(`expected 15+ buttons, got ${btns.length}`);
  const t = text(container);
  for (const w of ["Reading the EEG", "The frequency bands", "Wave morphology and nomenclature"])
    if (!t.includes(w)) throw new Error(`missing text: ${w}`);
});

gate("the progress ring renders as real SVG in the SVG namespace", () => {
  const svg = all(container, "svg")[0];
  if (!svg) throw new Error("no svg element");
  if (svg.ns !== "http://www.w3.org/2000/svg") throw new Error("svg is not namespaced");
  const circles = all(container, "circle");
  if (circles.length !== 2) throw new Error(`expected 2 circles, got ${circles.length}`);
  if (!("stroke-dasharray" in circles[1].attributes)) throw new Error("camelCase SVG attribute was not converted to kebab-case");
});

gate("opening a module renders the player and both canvases", () => {
  const startCard = all(container, "button").find((b) => text(b).includes("Start here") || text(b).includes("Continue") || text(b).includes("Resume"));
  if (!startCard) throw new Error("no start/continue card");
  click(startCard);
  const canvases = all(container, "canvas");
  if (canvases.length !== 2) throw new Error(`expected 2 canvases, got ${canvases.length}`);
  if (!text(container).includes("Why look at all")) throw new Error("module title not shown");
});

gate("the scope acquires a drawing context and runs its animation loop", () => {
  flushRaf(8);
  const canvases = all(container, "canvas");
  if (canvases[0]._ctxCalls === 0) throw new Error("no 2d context was requested");
  if (rafQueue.length === 0) throw new Error("the loop did not schedule another frame");
});

// the property a naive renderer loses
gate("a state change REUSES the canvas nodes rather than rebuilding them", () => {
  const before = all(container, "canvas").map((c) => c.id);
  flushRaf(30);              // drives setRo, which fires four times a second
  root.rerender();
  const after = all(container, "canvas").map((c) => c.id);
  if (before.join() !== after.join())
    throw new Error(`canvas identity changed ${before.join()} -> ${after.join()}; the drawing context would be lost every 250 ms`);
});

gate("Next advances the teaching point and the text actually changes", () => {
  const before = text(container);
  const next = all(container, "button").find((b) => text(b).trim() === "Next");
  if (!next) throw new Error("no Next button");
  click(next);
  root.rerender();
  const after = text(container);
  if (before === after) throw new Error("the screen did not change");
  if (!after.includes("2 of")) throw new Error("point counter did not advance");
});

gate("the bottom navigation switches tabs", () => {
  for (const label of ["Drill", "Bench", "More", "Learn"]) {
    const tab = all(container, "button").find((b) => text(b).trim() === label);
    if (!tab) throw new Error(`no ${label} tab`);
    click(tab);
    root.rerender();
    flushRaf(4);
  }
  if (!text(container).includes("Reading the EEG")) throw new Error("did not return to Learn");
});

gate("a drill can be answered and shows its explanation", () => {
  click(all(container, "button").find((b) => text(b).trim() === "Drill"));
  root.rerender(); flushRaf(4);
  const before = text(container);
  const opts = all(container, "button").filter((b) => {
    const t = text(b).trim();
    return t && !["Learn", "Drill", "Bench", "More", "Next record", "still", "resume"].includes(t);
  });
  if (!opts.length) throw new Error("no answer options");
  click(opts[0]); root.rerender();
  const after = text(container);
  if (after === before) throw new Error("answering changed nothing");
  if (!/Correct|Answer:/.test(after)) throw new Error("no feedback shown");
});

gate("sliders carry their aria labels and respond to input", () => {
  click(all(container, "button").find((b) => text(b).trim() === "Bench"));
  root.rerender(); flushRaf(4);
  const ranges = all(container, "input").filter((i) => i.attributes.type === "range");
  if (ranges.length < 4) throw new Error(`expected several sliders, got ${ranges.length}`);
  if (!ranges.every((r) => r.attributes["aria-label"])) throw new Error("a slider has no aria-label");
  const before = text(container);
  (ranges[0].listeners.change || []).forEach((f) => f({ target: { value: "0.5" } }));
  root.rerender();
  if (text(container) === before) throw new Error("moving a slider changed nothing");
});

gate("styles reach the DOM, with px added to numbers and not to unitless values", () => {
  const styled = [];
  walk(container, (n) => { if (n.style && Object.keys(n.style).length) styled.push(n); });
  if (styled.length < 20) throw new Error(`only ${styled.length} styled nodes`);
  const withMin = styled.filter((n) => n.style.minHeight && !/vh|%/.test(n.style.minHeight));
  if (!withMin.length) throw new Error('no numeric minHeight found');
  if (!withMin.every((n) => /px$/.test(n.style.minHeight))) throw new Error('a numeric minHeight was not suffixed with px');
  const withWeight = styled.find((n) => n.style.fontWeight);
  if (withWeight && /px/.test(withWeight.style.fontWeight)) throw new Error("px wrongly added to fontWeight");
});

gate("the error boundary catches a throw from inside the tree", () => {
  const Boom = () => { throw new Error("boom"); };
  const c2 = new Node("div");
  const r2 = sandbox.ReactDOM.createRoot(c2);
  const B = sandbox.Boundary;
  if (!B) throw new Error("Boundary not exposed");
  r2.render(sandbox.React.createElement(B, null, sandbox.React.createElement(Boom)));
  const t = text(c2);
  if (!t.includes("The programme stopped")) throw new Error("fallback did not render");
  if (!t.includes("boom")) throw new Error("the message was not surfaced");
});

gate("progress is written to localStorage and read back", () => {
  const keys = Object.keys(sandbox.localStorage._s);
  if (!keys.some((k) => k.startsWith("eeg-programme"))) throw new Error(`nothing stored; keys: ${keys.join()}`);
});

console.log(`\n${pass} renderer tests pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
