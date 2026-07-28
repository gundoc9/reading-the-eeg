# Reading the EEG — handoff

**Current build: v14.** 14 modules, 104 teaching points, 46 drills, 131 minutes.
173 gates across seven suites, all green.

Opens on a first-run landing screen with a live scope as the hero; after that it
goes straight to the module list. Reachable again from More > About.

Attributed to Dr Ganesh Sivasankara on the landing, in More > About and in the
page metadata. No hospital or institution is named anywhere — this is a personal
teaching resource, not a departmental one, and a gate enforces both.

---

## 1. Re-attach these to continue

Nothing persists between sessions. To carry on building, re-upload:

| File | What it is | Without it |
|---|---|---|
| `eeg-teaching-programme-v14.jsx` | the app: engine, curriculum, framework, drills, UI | everything is rebuilt from scratch |
| `engine.mjs` | the reference signal engine; the app's copy is spliced from this | the science has to be re-derived and re-tuned |
| `gates.mjs` `gates2.mjs` `gates3.mjs` `gates4.mjs` | 85 signal gates | no way to prove a change did not break the physiology |
| `content_gates.cjs` | 27 curriculum and framework gates | cross-references and overclaims go unchecked |
| `smoke.cjs` | 16 runtime gates | undefined names and dead screens ship |
| `mini.js` `mini_test.cjs` | the hand-written renderer and its 13 tests | the standalone page cannot be rebuilt |
| `build_html.py` | regenerates `reading-the-eeg.html` from source | no distributable file |

`reading-the-eeg.html` is the deliverable. It is generated, so it does not need
re-uploading unless it is the only copy left.

---

## 2. Papers already held — do NOT re-upload

All extracted, all cited in the app, all flags removed.

- **Berger-Estilita 2026**, Eur J Anaesthesiol 43:1-12 — ESAIC Delphi consensus, 58 learning outcomes. The app's Framework tab maps against it.
- **Yoon 2025**, Pediatr Anesth 35:294-301, doi 10.1111/pan.15058 — n=50, 4-24 months. Index falsely high in 70% of children, 28% of maintenance. The false-positive vs true-emergence discriminator.
- **Markus 2026**, Pediatr Anesth 36:641-649, doi 10.1002/pan.70156 — n=147, 1 month to 8 years, Narcotrend. Delta predominant in every age group *awake*. Six-month threshold for alpha and beta.
- **Derylo 2026**, Pediatr Anesth 36:164-172, doi 10.1111/pan.70080 — 9 RCTs, 730 patients. **Under-2s excluded.**
- **Bong & Yuan 2026**, Anesth Analg 142:1155-1168, doi 10.1213/ANE.0000000000007230 — age-stratified reliability table and SEF95 targets.

Held from earlier sessions, not as PDFs but with parameters extracted and gated:
Purdon 2015 Part I; Guay 2025 Part 2; Prerau 2017; Akeju 2014 (×2) and 2016;
Akeju & Brown 2017.

---

## 3. Still open

**Two citations remain incomplete**, and both are cosmetic — they change a
reference line, not a teaching claim:

- **Long 2022** — RCT, sevoflurane requirements under EEG guidance. Probably Long MHY, Lim EHL, Balanza GA, Allen JC, Purdon PL, Bong CL, *J Clin Anesth* 2022;81:110913. **Verify before asserting.**
- **Kratzer & Davidson 2025** — no details held.

Also flagged in-app and unlikely to change:
- **Purdon PNAS 2013** — cited second-hand through Purdon 2015 and Guay 2025.
- **Display convention** — negative-up polarity, clinical convention, not in a held source.
- **Three drug combinations** — interpolated from single-agent signatures, declared as such on screen.

**Not fixed, and named honestly in the app:**
electrode application, impedance and filters; live artefact mitigation; real
clinical recordings; epileptiform activity. These need a monitor and real
records, not more synthesis.

**Not fixed, from the stress tests:**
no validated assessment; one linear path for a mixed-level group; the coverage
map is self-assessed; the renderer has never run in a real browser.

---

## 4. How to change anything safely

The order matters. Two shipped faults came from getting it wrong.

1. Edit `engine.mjs`, never the copy inside the app.
2. Run `gates.mjs` `gates2.mjs` `gates3.mjs` `gates4.mjs`.
3. **Re-splice the engine into the app** — extract from `export const FS = 128;`
   to the end, strip `export `, convert `makeEngine` to return a bare function,
   remove the `record()` helper by locating its own closing brace. Assert every
   expected symbol survives.
4. Run every suite again *against the engine as it exists inside the app file*,
   not against `engine.mjs`.
5. `tsc --noEmit --jsx preserve` and grep for **TS2304 and TS2552** — undefined
   names. Do not filter to TS1xxx.
6. `node smoke.cjs`, `node content_gates.cjs`.
7. `python3 build_html.py`, then extract the renderer and app back out of the
   built HTML and run `mini_test.cjs` against those.

**Every scripted string replace must assert `count(old) == 1` before patching.**
Four silent no-ops have happened, one of them an indentation mismatch that let a
whole feature quietly not exist.

---

## 5. Standing rules earned the hard way

- A gate that passes may have been structurally unable to see the fault. When one passes, ask what it could not look at.
- Measure a component in isolation before measuring it inside a record. A whole-record measurement nearly let a completely absent artefact through.
- A share-of-total metric silently reports on everything else in the record. Use peak-against-shoulders instead.
- Never re-declare a string a gate is checking; read it from the module that draws it.
- Cross-reference modules by **title**, never by number. Five of seven numeric references were wrong after two renumberings.
- Before claiming a topic is covered, check how many points *demonstrate* it and whether the engine can *draw* what the words name. Three separate gaps were found this way.
- Warm a benchmark before comparing. An unwarmed measurement said a 59% speed-up was a slowdown.
- The reference tab states criteria, never management instructions. A gate enforces it.

---

## 6. Positioning, if it comes up

The app is **pre-work**, not a competitor to PALNET (pedseeg.com). They have the
two things synthesis cannot give: real case recordings and hands-on teaching at
the machine. The value here is doing the vocabulary, bands, morphology and
pattern recognition beforehand, so time with real records is not spent on what
alpha is.

It cannot certify anyone against the ESAIC outcomes — that paper sets no
assessment standard.

Departmental sign-off is the sensible bar before formal teaching use, because
the modules do give management guidance. No patient data touches it; progress is
per-device in `localStorage`.

---

## 7. Live site

**https://gundoc9.github.io/reading-the-eeg/**

Hosted on GitHub Pages from the repository `gundoc9/reading-the-eeg`, public,
licensed CC BY-NC-ND 4.0. `index.html` in the repository root is the built page.

To update it: rebuild with `build_html.py`, then upload the new `index.html`
over the old one. Everyone with the link gets the new version.

Two notes worth keeping:

- iOS Files and Mail previews **do not run JavaScript**. A local copy of the HTML
  shows only the page background on an iPhone or iPad. This is not a fault in the
  file and cannot be fixed in the file — the URL is the only route that works on
  a phone. Do not send anyone a local copy to test.
- The page is self-diagnosing. If it ever fails to start it prints a block naming
  whether the renderer loaded, whether the app script finished, and what threw.
  That block is what to report.
