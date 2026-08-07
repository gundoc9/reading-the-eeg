/* Content gates: run against the curriculum data inside the delivered file. */
const fs = require("fs");
const s = fs.readFileSync("app2.jsx", "utf8");
const grab = (n, o, c) => { const i = s.indexOf(n); const a = s.indexOf(o, i); let d = 0, j = a;
  for (; j < s.length; j++) { if (s[j] === o) d++; else if (s[j] === c) d--; if (d === 0) break; } return s.slice(a, j + 1); };
const AGENTS = ["propofol", "sevoflurane", "ketamine", "dexmedetomidine"];
const REFS = eval("(" + grab("const REFS =", "{", "}") + ")");
const FRAMEWORK = eval("(" + grab("const FRAMEWORK =", "[", "]") + ")");
const MODULES = eval("(" + grab("const MODULES =", "[", "]") + ")");
const DRILLS = eval("(" + grab("const DRILLS =", "[", "]") + ")");

let pass = 0, fail = 0;
const g = (n, c, d) => { c ? (pass++, console.log("  ok   " + n + "  " + (d || ""))) : (fail++, console.log("  FAIL " + n + "  " + (d || ""))); };

console.log("\n== content gates ==");
const all = FRAMEWORK.flatMap((f) => f[2]);
g("framework holds exactly the 58 accepted outcomes", all.length === 58, all.length + " items");
g("basic dimensions total 46, advanced 12",
  FRAMEWORK.filter(f => f[0] === "Basic").flatMap(f => f[2]).length === 46 &&
  FRAMEWORK.filter(f => f[0] === "Advanced").flatMap(f => f[2]).length === 12, "");
g("every outcome code is unique", new Set(all.map(i => i[0])).size === 58, "");
g("every outcome has a status and a location note",
  all.every(i => [0, 1, 2].includes(i[2]) && typeof i[3] === "string" && i[3].length >= 2), "");
const codes = new Set(all.map(i => i[0]));
g("every code cited on a module exists in the framework",
  MODULES.flatMap(m => m.codes).every(c => codes.has(c)), "");
const modNums = new Set(MODULES.map(m => m.n));
const bad = all.filter(i => i[2] > 0).flatMap(i => (i[3].match(/\d\d/g) || [])).filter(n => !modNums.has(n));
g("every module number referenced by an outcome exists", bad.length === 0, bad.join(",") || "");
g("every teaching point cites a reference that exists", MODULES.every(m => m.points.every(p => REFS[p.r])), "");
g("every drill answer is among its own options", DRILLS.every(d => d.opts.includes(d.a)), "");
g("every drill carries an explanation", DRILLS.every(d => d.why && d.why.length > 60), "");
g("flagged references carry a remediation note", Object.values(REFS).every(r => r.ok || (r.note && r.note.length > 30)), "");
g("every module has an aim, a prompt and at least four points",
  MODULES.every(m => m.aim.length > 30 && m.prompt.length > 30 && m.points.length >= 4), "");

// the gate this build exists to add
g("every drill declares the module it tests", DRILLS.every(d => d.mod && modNums.has(d.mod)),
  DRILLS.filter(d => !d.mod || !modNums.has(d.mod)).map(d => d.q).join(" | ") || "");
const per = {}; DRILLS.forEach(d => { per[d.mod] = (per[d.mod] || 0) + 1; });
const untested = MODULES.filter(m => !per[m.n]);
g("every module is tested by at least one drill", untested.length === 0,
  untested.length ? untested.map(m => m.n).join(",") + " untested" : MODULES.length + " modules covered");

// no teaching point may claim more than the evidence class allows
const overclaim = MODULES.flatMap(m => m.points).filter(p =>
  /diagnostic test|proves|always|never fails|guarantees/i.test(p.t));
g("no teaching point uses settled-fact language on an observational claim",
  overclaim.length === 0, overclaim.map(p => p.t.slice(0, 50)).join(" | ") || "");

// added after stress test 2: assessment coverage, not just presence
{
  const per = {}; DRILLS.forEach((d) => { per[d.mod] = (per[d.mod] || 0) + 1; });
  const worst = MODULES.map((m) => ({ n: m.n, r: m.points.length / (per[m.n] || 0.5) })).sort((a, b) => b.r - a.r)[0];
  g("no module is worse tested than one drill per four teaching points",
    worst.r <= 4, `worst is module ${worst.n} at ${worst.r.toFixed(1)} points per drill`);
  g("the drill bank is scheduled, not a fixed sequence",
    /nextDrill|box\[/.test(fs.readFileSync("app2.jsx", "utf8")), "three-box Leitner queue");
  g("every module ends in a check drawn from its own drills",
    /only=\{MODULES\[mi\].n\}/.test(fs.readFileSync("app2.jsx", "utf8")), "");
  g("per-module accuracy is recorded", /byMod/.test(fs.readFileSync("app2.jsx", "utf8")), "");
}


// added with the point-of-care reference: it must state criteria, not give orders
{
  const src = fs.readFileSync("app2.jsx", "utf8");
  const LOOKUP = eval("(" + grab("const LOOKUP =", "[", "]") + ")");
  const FURTHER = eval("(" + grab("const FURTHER =", "{", "}") + ")");
  const REAL = eval("(" + grab("const REAL_RECORDS =", "{", "}") + ")");

  g("every reference card cites a source that exists",
    LOOKUP.every((c) => REFS[c.r]), LOOKUP.filter((c) => !REFS[c.r]).map((c) => c.id).join(",") || `${LOOKUP.length} cards`);

  // a point-of-care card that tells someone what to do to a patient is a
  // different object with a different approval bar
  const imperative = /\b(reduce|increase|give|administer|turn (up|down)|stop|start|deepen|lighten|titrate|bolus)\b/i;
  const orders = [];
  LOOKUP.forEach((c) => {
    c.rows.forEach((r) => { if (imperative.test(r[1])) orders.push(`${c.id}: ${r[0]}`); });
    if (c.foot && imperative.test(c.foot)) orders.push(`${c.id}: foot`);
  });
  g("no reference card issues a management instruction", orders.length === 0, orders.join(" | ") || "criteria and readings only");

  g("every further-reading entry has a doi and a reason to read it",
    FURTHER.items.every((i) => i.doi && i.doi.length > 6 && i.w && i.w.length > 25), `${FURTHER.items.length} entries`);
  g("further reading is attributed and kept separate from the sources the teaching rests on",
    /PALNET/.test(FURTHER.note) && /rest on/.test(FURTHER.note), "");
  g("the app names where to see real records",
    REAL.links.length >= 2 && /synthesised/.test(REAL.body) && /cannot/.test(REAL.body), "");
  g("the reference tab is reachable from the navigation",
    /\["ref", "Ref"\]/.test(src) && /tab === "ref"/.test(src), "");
}


// the landing must orient, not oversell
{
  const src = fs.readFileSync("app2.jsx", "utf8");
  const land = src.slice(src.indexOf("function Landing("), src.indexOf("function Home("));
  g("the landing states the synthesis limit", /synthesised/.test(land) && /not a patient/.test(land), "");
  g("the landing states it cannot certify", /cannot certify/.test(land), "");
  g("the landing states nothing leaves the device", /stays on this device/.test(land), "");
  g("the landing is shown once, not on every launch", /seenIntro/.test(src) && /reachable from More|reopen this from More/i.test(src + land), "");
  g("the landing carries no marketing superlative",
    !/(revolution|cutting.edge|world.class|best.in.class|seamless|powerful|comprehensive solution)/i.test(land), "");
}


// authorship: the exact string the author asked for, and no institution
{
  const src = fs.readFileSync("app2.jsx", "utf8");
  g("the author is named", /const AUTHOR = "Dr Ganesh Sivasankara"/.test(src), "");
  g("credentials are exactly as specified",
    /const CREDENTIALS = "MD · FRCA · FCARCSI · Consultant Anaesthetist"/.test(src),
    "FCARCSI, not FFARCSI");
  g("no hospital or institution name appears anywhere in the app",
    !/KFSHRC|King Faisal|Specialist Hospital|Riyadh/i.test(src), "");
  g("attribution appears on the landing and in About",
    (src.match(/\{AUTHOR\}/g) || []).length >= 2, "");
}


// Cross-reference integrity. Five of seven numeric references were pointing at
// the wrong module after two renumberings, and nothing here was looking.
const texts = [];
MODULES.forEach((m) => {
  m.points.forEach((p, i) => { texts.push([`module ${m.n} point ${i + 1}`, p.t]); texts.push([`module ${m.n} look ${i + 1}`, p.look || ""]); });
  texts.push([`module ${m.n} prompt`, m.prompt]);
});
DRILLS.forEach((d, i) => texts.push([`drill ${i + 1}`, d.q + " " + d.why]));

const numeric = texts.filter(([, t]) => /\b[Mm]odule \d\d\b/.test(t));
g("no teaching text cross-references a module by NUMBER", numeric.length === 0,
  numeric.map(([w]) => w).join(", ") || "titles only — numbers cannot go stale");

const ordinal = texts.filter(([, t]) =>
  /\bthis module comes (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\b/i.test(t) ||
  /\b(is|as) the (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last) module\b/i.test(t));
g("no teaching text claims a module's position in the order", ordinal.length === 0,
  ordinal.map(([w]) => w).join(", ") || "");

const titles = MODULES.map((m) => m.title);
g("module titles are unique, so a title reference is unambiguous",
  new Set(titles).size === titles.length, "");
const refs = texts.filter(([w, t]) => titles.some((ti) => t.includes(ti) && !w.startsWith("module " + MODULES.find((m) => m.title === ti).n)));
console.log("  " + refs.length + " cross-references, all by title: " +
  refs.map(([w]) => w.replace("module ", "m")).join(", "));


console.log("  " + MODULES.length + " modules, " + MODULES.reduce((a, m) => a + m.points.length, 0) +
  " teaching points, " + DRILLS.length + " drills, " + MODULES.reduce((a, m) => a + m.mins, 0) + " min");
console.log("  drills per module: " + MODULES.map(m => m.n + ":" + (per[m.n] || 0)).join("  "));
console.log("\n" + pass + " content gates pass, " + fail + " fail\n");
process.exit(fail ? 1 : 0);
