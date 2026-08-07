"""A suite that has never failed has not been shown to measure anything.
   Break the app in specific ways and confirm the RIGHT gate fires."""
import pathlib, subprocess, shutil, os, re
BASE = pathlib.Path('app2_REAL.jsx').read_text()
MUT = [
 ("credentials mistyped as FFARCSI",
  lambda s: s.replace('FCARCSI · Consultant', 'FFARCSI · Consultant'),
  'content', 'credentials are exactly as specified'),
 ("an institution name appears",
  lambda s: s.replace('const AUTHOR = "Dr Ganesh Sivasankara"',
                      'const AUTHOR = "Dr Ganesh Sivasankara, Riyadh"'),
  'content', 'no hospital or institution name'),
 ("a drill loses its module tag",
  lambda s: s.replace('{ mod: "08", cfg: { state: "propofol", ch: 0 }, q: "Which agent?"',
                      '{ mod: "99", cfg: { state: "propofol", ch: 0 }, q: "Which agent?"', 1),
  'content', 'every drill declares the module it tests'),
 ("a drill answer is not among its options",
  lambda s: s.replace('opts: AGENTS, a: "propofol",', 'opts: AGENTS, a: "midazolam",', 1),
  'content', 'every drill answer is among its own options'),
 ("a teaching point overclaims",
  lambda s: s.replace('The EEG reads the target.', 'The EEG proves the target.', 1),
  'content', 'settled-fact language'),
 ("teaching text cross-references a module by NUMBER",
  lambda s: s.replace('look: "Nothing on this display is derived from a haemodynamic variable."',
                      'look: "See module 04 for this."', 1),
  'content', 'cross-references a module by NUMBER'),
 ("the landing drops its cannot-certify statement",
  lambda s: s.replace('but it cannot certify you against them', 'and it certifies you'),
  'content', 'the landing states it cannot certify'),
 ("a reference card starts issuing orders",
  lambda s: s.replace('["Suppression", "under 5 µV"]', '["Suppression", "reduce the propofol"]', 1),
  'content', 'no reference card issues a management instruction'),
 ("an undefined name inside a component",
  lambda s: s.replace('const mins = MODULES.reduce((a, m) => a + m.mins, 0);',
                      'const mins = NOT_A_REAL_NAME.reduce((a, m) => a + m.mins, 0);', 1),
  'smoke', 'Learn / landing'),
 ("a tap target drops below the floor",
  lambda s: s.replace('minHeight: 44, padding: "0 15px"', 'minHeight: 30, padding: "0 15px"', 1),
  'smoke', 'tap targets'),
]
rows = []
for name, fn, suite, expect in MUT:
    mutated = fn(BASE)
    if mutated == BASE:
        rows.append((name, suite, 'MUTATION DID NOT APPLY')); continue
    pathlib.Path('mut/app2.jsx').write_text(mutated)
    cmd = ['node', 'smoke.cjs' if suite == 'smoke' else 'content_gates.cjs']
    out = subprocess.run(cmd, cwd='mut', capture_output=True, text=True).stdout
    fired = [l.strip() for l in out.splitlines() if l.strip().startswith('FAIL') and expect.lower() in l.lower()]
    other = len([l for l in out.splitlines() if l.strip().startswith('FAIL')])
    rows.append((name, suite, ('CAUGHT by "%s"' % expect) if fired else
                 ('MISSED — %d other failures' % other if other else 'MISSED — suite passed')))
w = max(len(r[0]) for r in rows)
print('MUTATION BATTERY — does each gate actually bite?\n')
caught = 0
for name, suite, res in rows:
    ok = res.startswith('CAUGHT')
    caught += ok
    print('  %s %-*s  [%s]  %s' % ('ok  ' if ok else 'MISS', w, name, suite, res))
print('\n%d of %d mutations caught by the right gate' % (caught, len(rows)))
