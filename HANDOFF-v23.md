# Reading the EEG v23 — the basics primer, integrated

Built 7 August 2026. The app is now **v23**: 23 primer terms in front of the
14 modules.

## What changed in app2.jsx

`app2-v23.jsx` is your own v22 file with the patch applied. Measured against it:

- **1667 lines added** — one self-contained block immediately above `/* ---- app`
- **8 lines changed** — the four edits below, plus VERSION and BUILT
- **0 lines deleted**

Verified byte-identical before and after the patch: the engine block (616 lines),
`MODULES`, `DRILLS`, `REFS`, `FRAMEWORK`, `LOOKUP`, `FURTHER`. Not a word of the
teaching content was touched.

### The five edits

1. `EMPTY_PROG` gains `primer: { seen: false, at: 0 }`.
   Absent means not started, so **no KEY_STORE bump and no migration** — the same
   way `theme` was handled.
2. `App` gains `const [inPrimer, setInPrimer] = useState(false);`
3. `App` gains a branch **before** the `inSession` branch, so the primer bypasses
   the tab shell exactly as `Session` does. It is an on-ramp, not a sixth tab.
4. `Landing` takes `onPrimer`, leads with "Start with the basics", and moves
   module 01 to second. `App` wires it.
5. `THEMES` gains `specInk` and `specRef`, the same value in both palettes, the
   way `specBg` already is. Required by your own gate: no colour literal may live
   outside the table.

**`inPrimer` is declared AFTER `showIntro` on purpose.** `smoke.cjs` seeds
`useState` by call index, so inserting a hook earlier shifts every later one and
the landing seed lands on the wrong hook. Appending keeps your suite working
unmodified.

## Files

- `app2-v23.jsx` — the patched source. This replaces your app2.jsx.
- `mini.js` — reconstructed renderer, 7/7 on its own checks.
- `build_html.py` — reconstructed build script.
- `reading-the-eeg-v23.html` — the built standalone page, 297 KB, 0 outbound URLs.
- `integration.cjs.txt` — the 37-gate integration suite. Rename to `.cjs` to run.

## What was verified

**37 integration gates, run against the real file, not a stub.**

- `SCOPE.cols` 150 → 150. The primer never touches your singleton; it has its own
  `PSCOPES` map, bounded at 26.
- 23 canvases keep node identity across 6 animation frames, 303k draw ops, every
  one with a 2d context and an aria-label.
- A theme switch changes `P` dark → paper with **zero 2d contexts destroyed**.
- Every DSA opens primed at 150 columns — no empty-corner bug.
- Drill, Bench, Ref and More all still render after the primer has run.
- Module 01 opens on its real first teaching point and uses `SCOPE`, not `PSCOPES`.
- Progress carries both `primer` and `last`; still one storage key, still `:v9`.

**Built page:** 0 outbound URLs, safe-area insets present, credentials exact,
no institution named, no memoisation anywhere, every touch target ≥ 44 px, one
engine and one theme table.

## Two engine details the patch had to get right

Your `makeEngine` returns a **bare function**, so it is `s.eng(t, cfg, 0)` and not
`s.eng.sample(...)`. And the spectral edge is called **`sefBand`**, not `sef`.
The standalone primer had both wrong; only building against your real file caught it.

## Links now open (22 of them)

Every doi in Sources and in Reading, plus the EEG for Anesthesia channel and
pedseeg.com, are tappable. They were plain text before, and the reason was your
own gate: it banned every absolute URL in the source.

That gate existed because three web fonts were being **fetched** while the app
said three times that nothing is downloaded. That ban stands. But a destination
the reader **taps** is not a fetch — nothing loads unless they act, and the page
still needs no network to run. The old rule could not tell the two apart.

**`theme_gates_v23.py` amends it** into four gates: nothing is fetched; every
outbound destination is on a declared list; links carry `target="_blank"` and
`rel="noopener noreferrer"`; and the privacy wording names links as the one
exception. `build_html.py` was amended the same way and now prints the tappable
destinations rather than claiming zero URLs.

A site not on the `OUTBOUND` list simply is not tappable — it fails safe rather
than opening somewhere unaudited.

**The privacy wording changed** on the landing and in About, because it had to:
"Links open in a new tab, and only if you tap one."

## The back button was already fixed

The v22 safe-area work is in this build. On an iPhone in portrait the module
header sits 60 px down and the primer header 67 px, clearing the ~47 px iOS
reserves. Both back buttons are reachable.

## The suites were proved non-vacuous

`mutate.py` breaks the app ten specific ways and checks that the **right** gate
fires each time. All ten caught: mistyped credentials, an institution name, a
drill losing its module tag, a drill answer not among its options, a teaching
point overclaiming, a numeric module cross-reference, the landing dropping its
cannot-certify line, a reference card issuing an order, an undefined name inside
a component, and a tap target below the floor.

This matters because `smoke.cjs` and `content_gates.cjs` had to be reconstructed
from a paste — they would not attach. A reconstruction that passed but no longer
bit would be worse than useless. It bites.

## Uploading files, for next time

Recognised code extensions attach as files: `.js`, `.tsx`, `.py`, `.mjs`.
`.cjs` and `.text` do not — they arrive as pasted text and never reach disk.
**Rename the two suites to `smoke.js` and `content_gates.js`.**

## Still open

- **Not yet run on a real device.** The last three genuine defects in this project
  were all found by you on a phone and none by the automated gates. Keep the
  standalone primer hosted until v23 has been used on one.
- The primer is **23 of about 40 planned terms**. Missing: polarity, montage,
  filter, sensor position; three of the wave cards; power, the two axes, the
  colour scale, BSR, the proprietary index; and all five artefact cards.
- **Your three suites now pass against v23**: smoke 17/17, content 36/36,
  theme_gates all but three. Those three (`KEY_STORE referenced once more`,
  `exactly 6 engine lines differ from v14`, `exactly 1 curriculum line differs`)
  compare against `/tmp/app_before.jsx`, the original **v14** as received. I only
  had v22, so I substituted it — and all three fail identically when v22 is run
  against a v22 baseline. Put the real v14 back and they should pass. Worth
  re-running on your side to confirm.
