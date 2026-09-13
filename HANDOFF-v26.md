# Reading the EEG v26 - fault sweep plus the five artefact cards, 13 September 2026

Base: the repo's app2.jsx (4482 lines, v23), mini.js and build_html.py, received by paperclip.
Engine, modules, drills, references, framework, look-up cards and primer cards are byte-identical
to the file received. Nothing a learner reads has changed.

## The fault, and its class
The readout "ms · 891117 µV pk" was not a readout bug. The renderer (mini.js) tore down and
re-created any text child whose value was 0 or "" on every re-render, and it could only append
a re-created node at the end of its parent. So "0 µV" became "µV0" on the second frame and
stayed reversed once the value changed, "0 ms · 0 µV pk" became "ms · 891117 µV pk", and
"0 of 14 modules complete" became "of 14 modules complete.0". Any zero or empty first child
anywhere in the app was exposed, which is why the Progress screen showed it once and not on a
retake (it depends on whether a second render happened before the screenshot).

Fixed in mini.js, two lines of cause:
1. sameType() tested the new child as falsy; it now tests only for undefined/null.
2. Children are placed at their index with insertBefore, not appended; falls back to
   appendChild where a DOM has no insertBefore (the test harness).
Proved on the original renderer versus the patched one with order_unit.cjs (four failures
become four passes; canvas identity across re-renders still preserved).

## Other changes (all small, all visible in a diff of app2.jsx: 36 lines)
- VERSION v26, BUILT 13 September 2026 (More > About). v25 was the fix build alone; v26 adds the
  five artefact primer cards (Artefact, Muscle, Eye blink, Electrical noise, Electrode pop), taken
  mechanically out of the compiled v24 page you sent: the 28-card array parsed from it equals the v24
  set exactly, the first 23 are byte-identical to v23 in the source, PSCOPE_MAX 26 to 34, the primer
  now reads 28 terms. Nothing else from v24 was needed; the engine is unchanged.
- The html element now follows the theme. It was fixed at the dark boot colour, so on chart
  paper an overscroll bounce on iOS showed a dark band above and below the page.
- Isolated-element screen (module 04, points 5-9, 13): SEF95 and BSR chips are hidden when the
  state is "quiet". They were measuring the silent background and read "BSR 33%" in red beside
  a K-complex. Duration, peak, µV and Q remain.
- Sources panel: every doi in an entry is tappable, not only the first (the paediatric set
  carries two in its text).
- build_html.py names its output from the VERSION constant, and now carries the home-screen
  and link-preview head block that was pasted into index.html by hand on 8 August and lost on
  rebuild. Check the wording against the live page's head; if it differs and you prefer the old
  wording, edit it in build_html.py, not in index.html. Run LinkedIn's Post Inspector once after
  deploying so its cached card refreshes.

## Verification, in a real browser (Chromium, iPhone viewport, both themes)
- Every module and every teaching point, 104 screens x 2 themes: readout strips match their
  expected form, no NaN/undefined text, no console errors.
- Landing, primer index (28 live thumbnails) and all 28 cards with every control option,
  module check flow (module 01 to its check to module 02), drill answering, Bench controls
  including the case scrubber at 0%, every Reference card, More (Framework counts, Sources
  with 13 doi links, About showing v26, Reading, Progress sentence in the right order), theme
  toggle, "Show the opening screen again", session mode with arrow keys: 0 failures in each theme.
- Your mini_test.cjs: 11 of 13 pass. The two that fail also fail on the unpatched v23 build,
  so they are stale tests, not regressions: the theme button adds a third SVG circle, and
  Boundary is no longer a global.

## To deploy (repo root, replacing the old files)
index.html (same content as reading-the-eeg-v26.html), app2.jsx, mini.js, build_html.py.
Keep reading-the-eeg-card.png and eeg-icon-180.png where they are.

## Left for your call, unchanged
- Module 05 point 4 says the mains line is "a single horizontal line" on the DSA, but every
  DSA in the app tops out at 40 Hz, so a 50 or 60 Hz line never shows there. Content, so not
  touched.
- The two stale renderer tests above, if you want mini_test.cjs green again: expect 3 circles,
  and reach Boundary through Root rather than as a global.
