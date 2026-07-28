#!/usr/bin/env python3
"""Build the standalone page from source.

Regenerates reading-the-eeg.html from app2.jsx + mini.js every time, rather than
splicing into the previous output. Splicing broke once on stale markers, which is
exactly the failure this avoids.

    tsc --jsx react   ->  React.createElement calls, no JSX left
    mini.js           ->  the renderer, inlined; no network dependency at all
    localStorage shim ->  stands in for window.storage outside a Claude artifact
"""
import os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = "/mnt/user-data/outputs/reading-the-eeg.html"

# ---- compile the JSX ------------------------------------------------------
build = os.path.join(HERE, "_bundle")
shutil.rmtree(build, ignore_errors=True)
os.makedirs(build)
shutil.copy(os.path.join(HERE, "app2.jsx"), os.path.join(build, "app.tsx"))
subprocess.run(
    ["tsc", os.path.join(build, "app.tsx"), "--jsx", "react", "--target", "es2018",
     "--module", "esnext", "--outDir", build, "--skipLibCheck"],
    capture_output=True,
)
js_path = os.path.join(build, "app.js")
if not os.path.exists(js_path):
    sys.exit("tsc emitted nothing")

js = open(js_path).read()
js = js.replace('import React, { useState, useEffect, useRef, useCallback } from "react";',
                "const { useState, useEffect, useRef, useCallback } = React;")
js = js.replace("export default function Root", "function Root")
js = js.replace("export function App", "function App")
js = js.replace("export ", "")

for bad, why in [("import ", "module syntax left in the bundle"),
                 ("export ", "module syntax left in the bundle")]:
    if re.search(r"^\s*" + bad, js, re.M):
        sys.exit(f"build failed: {why}")
if re.search(r"<[A-Z][A-Za-z]*[\s/>]", js):
    sys.exit("build failed: untransformed JSX left in the bundle")

mini = open(os.path.join(HERE, "mini.js")).read()

# ---- assemble -------------------------------------------------------------
SHIM = """
/* Progress store. Inside a Claude artifact window.storage is provided; a
   standalone page has none, so back the same interface with localStorage —
   including get() rejecting on a missing key, which is what the app expects. */
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
    var diag = [
      "where: " + what,
      "renderer loaded: " + (typeof React !== "undefined" && !!React.createElement),
      "mount loaded: " + (typeof ReactDOM !== "undefined" && !!ReactDOM.createRoot),
      "app loaded: " + (typeof Root === "function"),
      "page bytes: " + (document.documentElement.outerHTML.length),
      "detail: " + String(detail || "none")
    ].join("\\n");
    root.innerHTML =
      '<div class="boot"><b>The programme did not start.</b>' +
      'Nothing here is downloaded, so this is not a connection problem. Send the block below and it will say where it stopped.' +
      '<code>' + diag.replace(/[<>&]/g, "") + '</code></div>';
  }

  // anything thrown anywhere, including asynchronously, becomes a visible message
  window.addEventListener("error", function (e) {
    if (!root.firstElementChild) report("uncaught error", e && e.message);
  });
  window.addEventListener("unhandledrejection", function (e) {
    if (!root.firstElementChild) report("unhandled promise", e && e.reason && e.reason.message);
  });

  try {
    if (typeof Root !== "function") { report("app script did not define Root", "the third script block did not finish"); return; }
    ReactDOM.createRoot(root).render(React.createElement(Root));
  } catch (e) {
    report("first render threw", (e && e.message) || e);
    return;
  }

  // watchdog: a silent half-render looks identical to a page that never loaded
  setTimeout(function () {
    if (!root.firstElementChild) report("rendered nothing within 1.5 s", "no error was thrown");
  }, 1500);
})();
"""

ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E"
        "%3Crect width='100' height='100' fill='%230E1116'/%3E%3Cpath d='M8 50 L22 50 L28 26 L36 74 "
        "L44 38 L50 62 L56 50 L92 50' stroke='%23F0A63C' stroke-width='6' fill='none' "
        "stroke-linejoin='round'/%3E%3C/svg%3E")

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0E1116">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Reading the EEG</title>
<meta name="author" content="Dr Ganesh Sivasankara">
<meta name="description" content="A teaching instrument on the raw EEG and the density spectral array for anaesthetists. Fourteen modules. Waveforms are synthesised.">
<link rel="apple-touch-icon" href="{ICON}">
<style>
  html,body{{margin:0;padding:0;background:#0E1116;-webkit-text-size-adjust:100%;}}
  #root{{min-height:100vh;}}
  .boot{{color:#99A2AE;font:15px/1.55 -apple-system,system-ui,sans-serif;padding:48px 22px;max-width:520px;margin:0 auto;}}
  .boot b{{color:#F2EEE6;display:block;font-size:19px;margin-bottom:8px;}}
  .boot code{{color:#E0796E;font-size:13px;display:block;margin-top:14px;white-space:pre-wrap;}}
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

open(OUT, "w").write(html)

ext = len(re.findall(r"<script[^>]*\ssrc=", html))
if ext:
    sys.exit(f"build failed: {ext} external script tag(s) — the page must not need a network")
print(f"built {OUT}: {round(len(html)/1024)} KB, {ext} external scripts")
