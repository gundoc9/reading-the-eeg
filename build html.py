#!/usr/bin/env python3
"""Build the standalone page from source. Regenerates it every time from
   app2.jsx + mini.js rather than splicing into the previous output."""
import os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else "app2.jsx"
# the output name follows the VERSION constant in the source, so a version bump
# in one place names the page and nobody edits this file to ship a build
_m = re.search(r'const VERSION = "(v\d+)"', open(os.path.join(HERE, SRC)).read())
OUT = "/mnt/user-data/outputs/reading-the-eeg-%s.html" % (_m.group(1) if _m else "build")

build = os.path.join(HERE, "_bundle")
shutil.rmtree(build, ignore_errors=True)
os.makedirs(build)
shutil.copy(os.path.join(HERE, SRC), os.path.join(build, "app.tsx"))
subprocess.run(["tsc", os.path.join(build, "app.tsx"), "--jsx", "react", "--target", "es2018",
                "--module", "esnext", "--outDir", build, "--skipLibCheck"], capture_output=True)
js_path = os.path.join(build, "app.js")
if not os.path.exists(js_path):
    sys.exit("tsc emitted nothing")

js = open(js_path).read()
js = js.replace('import React, { useState, useEffect, useRef, useCallback } from "react";',
                "const { useState, useEffect, useRef, useCallback } = React;")
js = js.replace("export default function Root", "function Root")
js = js.replace("export function App", "function App")
js = js.replace("export ", "")
for bad in ("import ", "export "):
    if re.search(r"^\s*" + bad, js, re.M):
        sys.exit("build failed: module syntax left in the bundle")
if re.search(r"<[A-Z][A-Za-z]*[\s/>]", js):
    sys.exit("build failed: untransformed JSX left in the bundle")

mini = open(os.path.join(HERE, "mini.js")).read()

SHIM = """
if (!window.storage) {
  window.storage = {
    get: function (k) {
      return new Promise(function (res, rej) {
        var v = null;
        try { v = localStorage.getItem(k); } catch (e) { rej(e); return; }
        if (v === null) rej(new Error("not found")); else res({ key: k, value: v });
      });
    },
    set: function (k, v) {
      return new Promise(function (res, rej) {
        try { localStorage.setItem(k, v); res({ key: k, value: v }); } catch (e) { rej(e); }
      });
    }
  };
}
"""

MOUNT = """
(function () {
  var root = document.getElementById("root");
  var reported = false;
  function report(what, detail) {
    if (reported) return;
    reported = true;
    var diag = ["where: " + what,
      "renderer loaded: " + (typeof React !== "undefined" && !!React.createElement),
      "mount loaded: " + (typeof ReactDOM !== "undefined" && !!ReactDOM.createRoot),
      "app loaded: " + (typeof Root === "function"),
      "page bytes: " + (document.documentElement.outerHTML.length),
      "detail: " + String(detail || "none")].join("\\n");
    root.innerHTML = '<div class="boot"><b>The programme did not start.</b>' +
      'Nothing here is downloaded, so this is not a connection problem. Send the block below and it will say where it stopped.' +
      '<code>' + diag.replace(/[<>&]/g, "") + '</code></div>';
  }
  window.addEventListener("error", function (e) { if (!root.firstElementChild) report("uncaught error", e && e.message); });
  window.addEventListener("unhandledrejection", function (e) { if (!root.firstElementChild) report("unhandled promise", e && e.reason && e.reason.message); });
  try {
    if (typeof Root !== "function") { report("app script did not define Root", "the third script block did not finish"); return; }
    ReactDOM.createRoot(root).render(React.createElement(Root));
  } catch (e) { report("first render threw", (e && e.message) || e); return; }
  setTimeout(function () { if (!root.firstElementChild) report("rendered nothing within 1.5 s", "no error was thrown"); }, 1500);
})();
"""

SITE = "https://gundoc9.github.io/reading-the-eeg/"   # the published address, used only in link-preview metadata
BOOT = {"bg": "#0E1116", "ink": "#F2EEE6", "dim": "#99A2AE", "warn": "#E0796E", "accent": "#F0A63C"}
ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E"
        "%3Crect width='100' height='100' fill='%23" + BOOT["bg"][1:] + "'/%3E%3Cpath d='M8 50 L22 50 L28 26 L36 74 "
        "L44 38 L50 62 L56 50 L92 50' stroke='%23" + BOOT["accent"][1:] + "' stroke-width='6' fill='none' "
        "stroke-linejoin='round'/%3E%3C/svg%3E")

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="{BOOT["bg"]}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Reading the EEG</title>
<meta name="author" content="Dr Ganesh Sivasankara">
<meta name="description" content="A teaching instrument on the raw EEG and the density spectral array for anaesthetists. A basics primer and fourteen modules. Waveforms are synthesised.">
<link rel="apple-touch-icon" href="{ICON}">
<!-- Home-screen shell and link-preview card. These were pasted into index.html
     by hand on 8 August 2026 and a rebuild wiped them; they live here now.
     The two PNGs sit in the repository root beside index.html. -->
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Reading EEG">
<link rel="apple-touch-icon" sizes="180x180" href="eeg-icon-180.png">
<link rel="icon" type="image/png" href="eeg-icon-180.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Reading the EEG">
<meta property="og:title" content="Reading the EEG">
<meta property="og:description" content="A teaching instrument on the raw EEG and the density spectral array for anaesthetists. A basics primer and fourteen modules. Waveforms are synthesised.">
<meta property="og:url" content="{SITE}">
<meta property="og:image" content="{SITE}reading-the-eeg-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Reading the EEG">
<meta name="twitter:image" content="{SITE}reading-the-eeg-card.png">
<style>
  html,body{{margin:0;padding:0;background:{BOOT["bg"]};-webkit-text-size-adjust:100%;}}
  #root{{min-height:100vh;box-sizing:border-box;
        padding:env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);}}
  .boot{{color:{BOOT["dim"]};font:15px/1.55 -apple-system,system-ui,sans-serif;padding:48px 22px;max-width:520px;margin:0 auto;}}
  .boot b{{color:{BOOT["ink"]};display:block;font-size:19px;margin-bottom:8px;}}
  .boot code{{color:{BOOT["warn"]};font-size:13px;display:block;margin-top:14px;white-space:pre-wrap;}}
</style>
</head>
<body>
<div id="root"></div>
<script>{SHIM}</script>
<script>
{mini}
</script>
<script>
{js}
</script>
<script>{MOUNT}</script>
</body>
</html>
"""

os.makedirs("/mnt/user-data/outputs", exist_ok=True)
open(OUT, "w").write(html)

# A URL the page FETCHES is banned: it makes the "nothing is downloaded" claim
# false and sends every reader's IP somewhere without them choosing to. A URL the
# reader can TAP is not the same thing — it opens a new tab on a deliberate
# action, and the page still needs no network at all to run. The old gate could
# not tell them apart and so banned both, which is why nothing was tappable.
RESOURCE = re.compile(
    r"""(<script[^>]+\bsrc\s*=|@import|<link[^>]+\bhref\s*=\s*["']https?:"""
    r"""|<img[^>]+\bsrc\s*=\s*["']?https?:|url\(\s*["']?https?:"""
    r"""|\bfetch\(\s*["']https?:|XMLHttpRequest|new\s+Image\(|navigator\.sendBeacon)""",
    re.I)
hit = RESOURCE.search(html)
if hit:
    sys.exit("build failed: the page fetches something: " + html[hit.start():hit.start() + 90])

# and every outbound destination that IS present must be one the reader taps
ALLOWED_PREFIXES = (
    "http://www.w3.org/2000/svg",     # an inert XML namespace, not a request
    "https://doi.org/",               # every reference and further-reading item
    "https://pedseeg.com",            # PALNET, named in Where to see real records
    "https://youtube.com/",           # the EEG for Anesthesia channel
    SITE,                             # link-preview metadata: read by LinkedIn's scraper, never fetched by the page
)
found = sorted(u for u in set(re.findall(r"https?://[^\"')> ]+", html))
              if not u.startswith(ALLOWED_PREFIXES))
if found:
    sys.exit("build failed: unexpected outbound destination:\n  " + "\n  ".join(found))

outs = sorted(set(re.findall(r"https?://[^\"')> ]+", html)) - {"http://www.w3.org/2000/svg"})
print(f"built {OUT}: {round(len(html)/1024)} KB, 0 fetched resources, "
      f"{len(outs)} tappable destination(s): {', '.join(outs)}")
