#!/usr/bin/env python3
"""Static gates for the two-theme build of Reading the EEG."""
import re, sys, hashlib

src    = open('/home/claude/src/app2.jsx').read()
before = open('/tmp/app_before.jsx').read()          # the v14 as received
bld    = open('/home/claude/src/build_html.py').read()

fails = []
def gate(ok, name, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")
    if not ok: fails.append(name)

a = src.index('const THEMES = {')
b = src.index('const P = { name: "dark"', a)
def tokens(n):
    i = src.index(f'  {n}: {{', a)
    return dict(re.findall(r'(\w+): "(#[0-9A-Fa-f]{6})"', src[i:src.index('  },', i)]))

COL = re.compile(r'#[0-9A-Fa-f]{6}\b|rgba?\([0-9]')
loose = []
for i, line in enumerate(src.split('\n'), 1):
    off = sum(len(l) + 1 for l in src.split('\n')[:i - 1])
    if a <= off <= b: continue
    if COL.search(line): loose.append((i, line.strip()[:70]))
gate(not loose, "no colour literal outside the THEMES table", str(loose) if loose else "")

tk = {n: set(re.findall(r'^\s{4}(\w+):', src[src.index(f'  {n}: {{', a):src.index('  },', src.index(f'  {n}: {{', a))], re.M)) for n in ('dark','paper')}
gate(tk['dark'] == tk['paper'], "dark and paper declare identical token sets", str(tk['dark'] ^ tk['paper']) or "")
unused = [t for t in tk['dark'] - {'label','note','gridA'} if not re.search(r'P\.' + t + r'\b', src)]
gate(not unused, "every colour token is read somewhere", str(unused))

gate(not re.findall(r'^\s*P\s*=', src, re.M), "P is never reassigned")
gate('for (const k in THEMES[t]) P[k] = THEMES[t][k];' in src, "applyTheme mutates P in place")

eff = src[src.index('function Scope('): src.index('const rc = resolveCfg(cfg);')]
dep = re.search(r'\}, \[([^\]]*)\]\);\s*$', eff.strip())
gate(dep is not None and 'P' not in dep.group(1) and 'theme' not in dep.group(1),
     "Scope's animation effect does not depend on the theme (no remount, no lost spectrogram)",
     f"deps=[{dep.group(1) if dep else '?'}]")
gate('const se = rgbOf(P.specBg);' in eff and 'tint(P.accent, P.gridA)' in eff,
     "Scope reads the theme inside the draw loop, not at mount")
gate('theme: "dark"' in src and 'KEY_STORE = "eeg-programme:v9"' in src,
     "theme defaults to dark and the storage key is unchanged (no migration)")
gate(src.count('KEY_STORE') == before.count('KEY_STORE') + 1,
     "KEY_STORE referenced once more than before (the synchronous boot read)")

seg = lambda t: t[t.index('const FS = 128;'): t.index('/* ---- analysis constants')]
# Every line of the engine that differs from the v14 received must be one of
# these, each with a reason. A gate that just counts differences drifts upward
# one change at a time; this one has to be edited deliberately.
DELIBERATE = [
    ("That supports the nociceptive reading", "case caption reworded to match module 10's own softened wording"),
    ("sourced: true",                          "propofol+ketamine is described in a held source, not interpolated"),
    ("Ketamine does not fade the propofol",    "its note, per Kim 2020 reporting Hayashi"),
    ('amp: 24, topo: "flat"',                  "slow-delta reduced when ketamine is added (Kim 2020)"),
    ('f: 2.2, amp: 9, topo: "flat"',           "delta reduced, same source"),
    ("f: 15.0, amp: 11",                       "the alpha peak moves up into beta — the correction itself"),
]
sa, sb = seg(before).split('\n'), seg(src).split('\n')
if len(sa) != len(sb):
    gate(False, "engine block line count unchanged", f"{len(sa)} -> {len(sb)}")
else:
    diffs = [(x, y) for x, y in zip(sa, sb) if x != y]
    unaccounted = [y.strip()[:60] for _, y in diffs if not any(m in y for m, _ in DELIBERATE)]
    gate(not unaccounted,
         f"all {len(diffs)} engine lines that differ from v14 are declared changes",
         str(unaccounted[:2]) if unaccounted else ", ".join(r for _, r in DELIBERATE)[:90] + "...")
    # Content is pinned byte-for-byte by the engine.mjs comparison below; what
    # this adds is the COUNT, so a seventh change cannot ride in on a marker
    # string that happens to match. A previous version of this gate stripped
    # the NEW lines from one side and the OLD lines survived on the other,
    # which made it fail for the wrong reason.
    gate(len(diffs) == len(DELIBERATE),
         f"exactly {len(DELIBERATE)} engine lines differ from v14 — one per declared change",
         f"{len(diffs)} differ, {len(DELIBERATE)} declared")
# Until engine.mjs was uploaded this could only be asserted indirectly, by
# hashing the app's engine block before and after. Now it can be checked against
# the reference it is supposed to be extracted from.
try:
    eng = open('/home/claude/src/engine.mjs').read()
    def _blk(t):
        return t[t.index('const FS = 128;'): t.index('for (const k of Object.keys(BAND_DEMO))')]
    def _norm(t):
        t = t.replace('export ', '')
        t = t.replace("  return {\n    // returns uV sample at time t (s) for channel ch (0 frontal, 1 occipital)\n    sample(t, cfg, ch) {",
                      "  // returns uV sample at time t (s) for channel ch (0 frontal, 1 occipital)\n  return function sample(t, cfg, ch) {")
        t = t.replace("      return v * (cfg.gain ?? 1);\n    },\n  };\n}", "      return v * (cfg.gain ?? 1);\n  };\n}")
        t = t.replace('function sef(', 'function sefBand(')
        k = t.find('function record(cfg, secs, ch = 0, seed = 3) {')
        if k >= 0: t = t[:k] + t[t.index('\n}\n', k) + 3:]
        return [l.rstrip() for l in t.split('\n') if l.strip()]
    _a, _b = _norm(_blk(eng)), _norm(_blk(src))
    gate(_a == _b, "app engine block matches engine.mjs line for line",
         "identical" if _a == _b else f"{sum(1 for x, y in zip(_a, _b) if x != y)} line(s) differ")
except FileNotFoundError:
    gate(False, "engine.mjs present for comparison", "not in the container")

# The curriculum proper must not move. The drill bank is allowed to GROW, but
# only by appending — prog.drill.box is keyed by index, so inserting would shift
# every stored box for every existing reader.
# Same discipline as the engine block: the curriculum may change, but every
# changed line must be declared with a reason, and the count is fixed. A plain
# hash would have to be re-baselined on every edit, which teaches nobody
# anything; a bare count drifts upward one change at a time.
CURRICULUM_DELTAS = [
    ("the alpha does not fade, it moves",
     "module 09 point 3 now follows the corrected propofol+ketamine morphology, its source tag "
     "moved from interp to kim20, and its look-for no longer says the morphology is not a finding"),
]
ma = lambda t: t[t.index('const MODULES = ['): t.index('/* ===================== drill bank')].split('\n')
ca, cb = ma(before), ma(src)
if len(ca) != len(cb):
    gate(False, "curriculum line count unchanged", f"{len(ca)} -> {len(cb)}")
else:
    cd = [(x, y) for x, y in zip(ca, cb) if x != y]
    unaccounted = [y.strip()[:60] for _, y in cd if not any(m in y for m, _ in CURRICULUM_DELTAS)]
    gate(not unaccounted, f"all {len(cd)} curriculum lines that differ from v14 are declared",
         str(unaccounted[:2]) if unaccounted else CURRICULUM_DELTAS[0][1][:80] + "...")
    gate(len(cd) == len(CURRICULUM_DELTAS),
         f"exactly {len(CURRICULUM_DELTAS)} curriculum line differs from v14",
         f"{len(cd)} differ, {len(CURRICULUM_DELTAS)} declared")
dr = lambda t: t[t.index('const DRILLS = ['): t.index('\n];', t.index('const DRILLS = ['))]
ob = re.split(r'\n  \{ mod: ', dr(before))[1:]
nb = re.split(r'\n  \{ mod: ', dr(src))[1:]
# rstrip because the previously-last item gains a trailing newline once it stops
# being last. That is layout, not content — the item itself must be untouched.
_o = [x.rstrip() for x in ob]; _n = [x.rstrip() for x in nb]
gate(len(_n) >= len(_o) and _n[:len(_o)] == _o,
     "drill bank grew by appending only — no stored Leitner box is displaced",
     f"{len(_o)} -> {len(_n)} items")

# Every answer must be one of its own options, or the item is unanswerable.
# AGENTS is a shared constant, so resolve identifiers rather than skipping them.
_agents = re.findall(r'"([^"]+)"', src[src.index('const AGENTS = ['):src.index(']', src.index('const AGENTS = ['))])
_bad = []
for _p in nb:
    _o = re.search(r'opts: \[(.*?)\]', _p, re.S)
    _lst = re.findall(r'"((?:[^"\\]|\\.)*)"', _o.group(1)) if _o else (_agents if re.search(r'opts: AGENTS', _p) else None)
    _a = re.search(r'a: ("(?:[^"\\]|\\.)*")', _p)
    if _lst is None or not _a: _bad.append(_p[:40]); continue
    if _a.group(1)[1:-1] not in _lst: _bad.append(_a.group(1))
gate(not _bad, f"all {len(nb)} drill answers appear in their own options", str(_bad[:3]))

_mods = {}
for _p in nb: _mods[_p[1:3]] = _mods.get(_p[1:3], 0) + 1
_thin = sorted(k for k, v in _mods.items() if v < 3)
gate(not _thin, "every module has at least three drill items", f"thin: {_thin}")
# AMENDED for v23. This gate existed because three web fonts were being FETCHED
# while the app said three times that nothing is downloaded. That is still banned.
# But it also banned every doi and every site name, which is why the references
# and the video channel were unreachable text for 22 items. A destination the
# reader TAPS is not a fetch: nothing loads unless they act, and the page still
# needs no network to run. So: no fetched resource at all, and every tappable
# destination must appear on a declared list.
_FETCH = re.compile("@import|<script[^>]+\\bsrc\\s*=|\\bfetch\\(\\s*[\"']https?:"
                    "|XMLHttpRequest|new\\s+Image\\(|navigator\\.sendBeacon", re.I)
_f = _FETCH.search(src)
gate(not _f, "app source fetches nothing over the network", _f.group(0) if _f else "")
TAPPABLE = {"https://doi.org/", "https://pedseeg.com",
            "https://youtube.com/@eegforanesthesia3954"}
urls = sorted(set(re.findall(r'https?://[^"\')> ]+', src))
              - {"http://www.w3.org/2000/svg"} - TAPPABLE)
gate(not urls, "every outbound destination is a declared tappable link", str(urls))
gate('target="_blank"' in src and 'rel="noopener noreferrer"' in src,
     "outbound links open in a new tab and cannot reach back into the page")
gate("Links open in a new tab" in src and "only when you tap them" in src,
     "the privacy wording names links as the one exception")

# The previous version of this section carried a hand-written list of 12 pairs
# and missed five, one of which FAILED AA. The class it forgot was text on a
# TINTED ground, so those are now computed from the tokens, not remembered.
def lin(c):
    c /= 255
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
def lum(h):
    r,g,bb = [int(h.lstrip('#')[i:i+2],16) for i in (0,2,4)]
    return .2126*lin(r)+.7152*lin(g)+.0722*lin(bb)
def cr(x,y):
    p,q = lum(x),lum(y); hi,lo = max(p,q),min(p,q); return (hi+.05)/(lo+.05)
def over(fg,al,bg):
    f=[int(fg.lstrip('#')[i:i+2],16) for i in (0,2,4)]
    g=[int(bg.lstrip('#')[i:i+2],16) for i in (0,2,4)]
    return '#%02X%02X%02X' % tuple(round(f[i]*al+g[i]*(1-al)) for i in range(3))

FLAT=[("ink","bg"),("dim","bg"),("accent","bg"),("warn","bg"),
      ("ink","surface"),("dim","surface"),("accent","surface"),("ok","surface"),("warn","surface"),
      ("ink","surface2"),("dim","surface2"),("accent","surface2"),("ok","surface2"),("warn","surface2"),
      ("bg","accent")]
WASH=[("ok",0.14,"bg"),("warn",0.14,"bg")]
IND =[("ok","surface"),("accent","surface"),("dim","surface")]
for n in ('dark','paper'):
    T=tokens(n)
    w1=min(cr(T[f],T[g]) for f,g in FLAT)
    w2=min(cr(T[t],over(T[t],al,T[g])) for t,al,g in WASH)
    w3=min(cr(T[f],T[g]) for f,g in IND)
    gate(w1>=4.5, f"{n}: all {len(FLAT)} flat text pairs pass WCAG AA", f"lowest {w1:.2f}")
    gate(w2>=4.5, f"{n}: text on its own tint passes WCAG AA",         f"lowest {w2:.2f}")
    gate(w3>=3.0, f"{n}: every status indicator clears 3:1",           f"lowest {w3:.2f}")
i=src.index('const dotStyle = (s)')
gate('P.line' not in src[i:i+400], "no status marker uses the rule colour")
gate('borderRadius: 1' in src[i:i+400] and 'border: `2px solid' in src[i:i+400],
     "status coded by shape (disc / square / ring), not by hue alone")

# The theme works by mutating P in place and letting App's re-render repaint the
# tree. Safe ONLY while nothing is memoised — a React.memo or a memoised style
# object would keep the old palette with nothing failing. Guard it.
risky = [t for t in ("React.memo","useMemo","PureComponent","shouldComponentUpdate") if t in src]
gate(not risky, "nothing is memoised, so the in-place theme mutation stays sound", str(risky))

gate('primeScope(cfgRef.current);' in src and 'if (SCOPE.cols.length) return;' in src,
     "the scope primes its history before the first frame")
gate('aria-live="polite"' in src, "screen changes are announced to a screen reader")
gate('const VERSION =' in src and '{VERSION} · built {BUILT}' in src,
     "the build identifies itself in About")

D=tokens('dark')
B=dict(re.findall(r'"(\w+)": "(#[0-9A-Fa-f]{6})"', bld[bld.index('BOOT = {'):bld.index('ICON = (')]))
badb={k:(v,D.get(k)) for k,v in B.items() if D.get(k)!=v}
gate(not badb, "boot-page colours match the dark theme tokens", str(badb))

chunks=re.split(r'\n(?=(?:export )?(?:function|class) )', src)
def body(n):
    for c in chunks:
        if re.match(r'(?:export )?function '+n+r'\(', c): return c
    return ""
SCREENS=["Landing","Home","ModuleScreen","DrillScreen","BenchScreen","RefScreen","MoreScreen","Session"]
missing=[s for s in SCREENS if "<ThemeButton" not in body(s)]
gate(not missing, f"theme control present on all {len(SCREENS)} screens", str(missing) if missing else "")
gate(src.count("let setThemeFromAnywhere")==1 and src.count("setThemeFromAnywhere = chooseTheme;")==1,
     "exactly one module-level setter, installed by App")
tb=body("ThemeButton")
gate("<ThemeButton" not in tb, "the control does not render itself")
gate("aria-label" in tb and "title=" in tb, "the control is labelled for screen readers and on hover")
gate("width: 44, height: 44" in tb, "the control meets Apple's 44pt target")

# Was: an assertion that the new control matched the other header buttons "at
# 40px", which gated consistency with a shortfall and would have frozen it.
# Measure every interactive element instead.
tsz = []
for _m in re.finditer(r'(minHeight|height): (\d+)', src):
    _ln = src[:_m.start()].count('\n')
    _line = src.split('\n')[_ln]
    if 'button' in _line.lower() or 'Btn' in _line or 'minHeight' in _m.group(0) or 'width: 44' in _line:
        _v = int(_m.group(2))
        if _v <= 60: tsz.append(_v)
gate(tsz and min(tsz) >= 44, "every touch target meets Apple's 44pt / WCAG AAA",
     f"smallest {min(tsz) if tsz else '?'} px")

# What a reader is meant to READ is at full strength; only labels and metadata
# sit in the secondary grey. Counted app-wide, not screen by screen — the first
# pass fixed two components and left eleven.
def _styles(t):
    out = []
    for _m in re.finditer(r'style=\{\{', t):
        i = _m.end(); d = 2; j = i
        while j < len(t) and d > 0:
            if t[j] == '{': d += 1
            elif t[j] == '}': d -= 1
            j += 1
        out.append(t[i:j-2])
    return out
_grey = 0
for _st in _styles(src):
    _fs = re.search(r'fontSize: ([\d.]+)', _st); _c = re.search(r'color: ([^,\n]+)', _st)
    if not _fs or not _c or 'P.dim' not in _c.group(1): continue
    if float(_fs.group(1)) < 13 or 'fontWeight: 700' in _st or 'textTransform' in _st or 'MN' in _st: continue
    _grey += 1
# 12 remain and every one is a label: the credentials line, the module minute
# counts, the author/journal lines, the version stamp, the flagged-source
# marker, the keyboard hint, the slider labels, the theme note, and the label
# column of a table whose value column is now the strong one.
gate(_grey <= 12, "paragraph text in the secondary grey is only metadata", f"{_grey} elements")

# "Show the opening screen again" wrote seenIntro:false and nothing else, so it
# deferred to the next launch and read as a dead control. Whatever handles it
# must set the showIntro STATE and leave the More tab.
_h = src[src.index('const showOpening'):src.index('const showOpening') + 320] if 'const showOpening' in src else ''
gate(all(x in _h for x in ('setShowIntro(true)', 'setTab("learn")', 'setView("home")')),
     "the reopen-landing control sets state and navigates, not just storage")
gate('onClick={onShowIntro}' in src, "and the button calls it")

# viewport-fit=cover is set, so the top and side insets must be honoured or the
# header row lands under the status bar where iOS eats the taps.
_vf = 'viewport-fit=cover' in bld
_ins = all(x in bld for x in ('env(safe-area-inset-top)', 'env(safe-area-inset-left)', 'env(safe-area-inset-right)'))
gate(not _vf or _ins, "viewport-fit=cover is matched by top and side safe-area insets")
gate('env(safe-area-inset-bottom)' in src, "and the fixed nav still honours the bottom inset")

print()
sys.exit(1 if fails else 0)
