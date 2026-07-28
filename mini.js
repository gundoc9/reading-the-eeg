/* =========================================================================
   A minimal React-compatible renderer.

   Written because the standalone page must work with NO network at all — an
   external CDN script is blocked in several viewers, and this container cannot
   download React to inline it. This implements only the subset the programme
   uses: createElement, function components with useState / useEffect / useRef /
   useCallback, class components with an error boundary, refs, inline styles,
   SVG, and createRoot().render().

   The property that matters most: reconciliation reuses DOM nodes when the
   element type is unchanged. The scope calls setState four times a second, and
   a renderer that rebuilt the tree would destroy the canvas and its drawing
   context every 250 ms. There is a test for exactly that.
   ========================================================================= */
(function (global) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SVG_TAGS = { svg: 1, circle: 1, path: 1, rect: 1, text: 1, g: 1, line: 1, polyline: 1 };
  var UNITLESS = {
    opacity: 1, zIndex: 1, flex: 1, flexGrow: 1, flexShrink: 1, fontWeight: 1,
    lineHeight: 1, order: 1, zoom: 1, gridRow: 1, gridColumn: 1,
  };

  function flatten(arr, out) {
    out = out || [];
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (Array.isArray(c)) flatten(c, out);
      else if (c !== null && c !== undefined && c !== false && c !== true) out.push(c);
    }
    return out;
  }

  function createElement(type, props) {
    var p = {}, k;
    for (k in (props || {})) p[k] = props[k];
    var kids = flatten(Array.prototype.slice.call(arguments, 2));
    if (kids.length) p.children = kids.length === 1 ? kids[0] : kids;
    else if (p.children !== undefined) kids = flatten([p.children]);
    return { type: type, props: p, kids: kids, key: p.key };
  }

  /* ---- hooks ---------------------------------------------------------- */

  var current = null;   // instance being rendered
  var hookIdx = 0;
  var pendingEffects = [];
  var scheduled = false;
  var roots = [];

  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    (global.queueMicrotask || function (f) { setTimeout(f, 0); })(function () {
      scheduled = false;
      // A throw inside a microtask leaves the page half-rendered and silent,
      // which is indistinguishable from a page that never loaded. Surface it.
      try {
        for (var i = 0; i < roots.length; i++) roots[i].rerender();
      } catch (err) {
        if (global.onRenderError) global.onRenderError(err); else throw err;
      }
    });
  }

  function useState(init) {
    var inst = current, i = hookIdx++;
    if (inst.hooks.length <= i) inst.hooks[i] = { v: typeof init === "function" ? init() : init };
    var h = inst.hooks[i];
    return [h.v, function (next) {
      var v = typeof next === "function" ? next(h.v) : next;
      if (Object.is(v, h.v)) return;
      h.v = v;
      scheduleRender();
    }];
  }

  function useRef(init) {
    var inst = current, i = hookIdx++;
    if (inst.hooks.length <= i) inst.hooks[i] = { v: { current: init } };
    return inst.hooks[i].v;
  }

  function useCallback(fn) { return fn; }

  function depsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }

  function useEffect(fn, deps) {
    var inst = current, i = hookIdx++;
    if (inst.hooks.length <= i) inst.hooks[i] = { deps: undefined, cleanup: null };
    var h = inst.hooks[i];
    var run = deps === undefined || !depsEqual(h.deps, deps);
    h.deps = deps;
    if (run) pendingEffects.push(h, fn);
  }

  var flushing = false;
  function flushEffects() {
    if (flushing) return;            // a nested render must not steal the queue
    flushing = true;
    var list = pendingEffects;
    pendingEffects = [];
    for (var i = 0; i < list.length; i += 2) {
      var h = list[i], fn = list[i + 1];
      if (typeof h.cleanup === "function") { try { h.cleanup(); } catch (e) { /* cleanup must not break the commit */ } }
      var c = null;
      try { c = fn(); } catch (e) { console.error(e); }
      h.cleanup = typeof c === "function" ? c : null;
    }
    flushing = false;
    if (pendingEffects.length) flushEffects();   // anything queued while flushing
  }

  /* ---- DOM ------------------------------------------------------------ */

  function applyStyle(dom, style, prev) {
    var k;
    if (prev) for (k in prev) if (!(style && k in style)) dom.style[k] = "";
    if (!style) return;
    for (k in style) {
      var v = style[k];
      if (v === null || v === undefined || v === false) { dom.style[k] = ""; continue; }
      if (typeof v === "number" && !UNITLESS[k]) v = v + "px";
      dom.style[k] = v;
    }
  }

  function kebab(k) { return k.replace(/([A-Z])/g, "-$1").toLowerCase(); }

  function setProps(dom, props, prev, isSvg) {
    prev = prev || {};
    var k;
    for (k in prev) {
      if (k === "children" || k === "key" || k === "ref") continue;
      if (k in props) continue;
      if (k.slice(0, 2) === "on") dom.removeEventListener(k.slice(2).toLowerCase(), prev[k]);
      else if (k === "style") applyStyle(dom, null, prev.style);
      else dom.removeAttribute(isSvg ? kebab(k) : k);
    }
    for (k in props) {
      if (k === "children" || k === "key" || k === "ref") continue;
      var v = props[k], p = prev[k];
      if (v === p) continue;
      if (k.slice(0, 2) === "on") {
        var ev = k.slice(2).toLowerCase();
        if (p) dom.removeEventListener(ev, p);
        if (v) dom.addEventListener(ev, v);
      } else if (k === "style") {
        applyStyle(dom, v, p);
      } else if (isSvg) {
        dom.setAttribute(kebab(k), v);
      } else if (k === "value") {
        if (dom.value !== String(v)) dom.value = v;
        dom.setAttribute("value", v);
      } else if (k === "className") {
        dom.setAttribute("class", v);
      } else if (v === false || v === null || v === undefined) {
        dom.removeAttribute(k);
      } else {
        dom.setAttribute(k, v === true ? "" : v);
      }
    }
  }

  /* ---- reconciliation -------------------------------------------------- */
  /* inst = { vnode, dom, kids:[inst], hooks:[], comp, isText }             */

  function unmount(inst) {
    if (!inst) return;
    for (var i = 0; i < inst.hooks.length; i++) {
      var h = inst.hooks[i];
      if (h && typeof h.cleanup === "function") { try { h.cleanup(); } catch (e) { /* ignore */ } }
    }
    if (inst.kids) for (var j = 0; j < inst.kids.length; j++) unmount(inst.kids[j]);
    if (inst.vnode && inst.vnode.props && inst.vnode.props.ref) inst.vnode.props.ref.current = null;
  }

  function sameType(inst, vnode) {
    if (!inst || !vnode) return false;
    var a = inst.vnode, b = vnode;
    if (typeof a === "object" && typeof b === "object") {
      if (a.type !== b.type) return false;
      if (a.key !== b.key) return false;
      return true;
    }
    return typeof a !== "object" && typeof b !== "object";
  }

  function reconcile(vnode, parentDom, oldInst, doc) {
    // text
    if (typeof vnode !== "object") {
      if (oldInst && oldInst.isText) { 
        if (oldInst.dom.nodeValue !== String(vnode)) oldInst.dom.nodeValue = String(vnode);
        oldInst.vnode = vnode;
        return oldInst;
      }
      var t = doc.createTextNode(String(vnode));
      return { vnode: vnode, dom: t, kids: [], hooks: [], isText: true };
    }

    // class component
    if (typeof vnode.type === "function" && vnode.type.prototype && vnode.type.prototype.isClassComponent) {
      var ci = oldInst && oldInst.comp ? oldInst : { vnode: vnode, kids: [], hooks: [], comp: new vnode.type(vnode.props) };
      ci.comp.props = vnode.props;
      ci.comp.__rerender = scheduleRender;
      ci.vnode = vnode;
      var rendered;
      try {
        rendered = ci.comp.render();
      } catch (err) {
        if (vnode.type.getDerivedStateFromError) {
          ci.comp.state = Object.assign({}, ci.comp.state, vnode.type.getDerivedStateFromError(err));
          if (ci.comp.componentDidCatch) ci.comp.componentDidCatch(err, {});
          rendered = ci.comp.render();
        } else throw err;
      }
      var childInst;
      try {
        childInst = reconcile(rendered, parentDom, ci.kids[0], doc);
      } catch (err2) {
        if (vnode.type.getDerivedStateFromError) {
          if (ci.kids[0]) unmount(ci.kids[0]);
          ci.comp.state = Object.assign({}, ci.comp.state, vnode.type.getDerivedStateFromError(err2));
          if (ci.comp.componentDidCatch) ci.comp.componentDidCatch(err2, {});
          childInst = reconcile(ci.comp.render(), parentDom, null, doc);
        } else throw err2;
      }
      ci.kids = [childInst];
      ci.dom = childInst.dom;
      return ci;
    }

    // function component
    if (typeof vnode.type === "function") {
      var fi = oldInst && oldInst.hooks && oldInst.fn === vnode.type ? oldInst
             : { vnode: vnode, kids: [], hooks: [], fn: vnode.type };
      if (oldInst && oldInst !== fi) unmount(oldInst);
      fi.vnode = vnode;
      fi.fn = vnode.type;
      var prevCur = current, prevIdx = hookIdx;
      current = fi; hookIdx = 0;
      var out = vnode.type(vnode.props);
      current = prevCur; hookIdx = prevIdx;
      var ci2 = out === null || out === undefined || out === false
        ? null
        : reconcile(out, parentDom, fi.kids[0], doc);
      fi.kids = ci2 ? [ci2] : [];
      fi.dom = ci2 ? ci2.dom : null;
      return fi;
    }

    // host element
    var isSvg = !!SVG_TAGS[vnode.type];
    var inst;
    if (oldInst && !oldInst.isText && !oldInst.fn && !oldInst.comp && oldInst.vnode.type === vnode.type) {
      inst = oldInst;                                   // REUSE the DOM node
      setProps(inst.dom, vnode.props, inst.vnode.props, isSvg);
      inst.vnode = vnode;
    } else {
      if (oldInst) unmount(oldInst);
      var dom = isSvg ? doc.createElementNS(SVG_NS, vnode.type) : doc.createElement(vnode.type);
      inst = { vnode: vnode, dom: dom, kids: [], hooks: [] };
      setProps(dom, vnode.props, null, isSvg);
    }
    if (vnode.props.ref) vnode.props.ref.current = inst.dom;

    var oldKids = inst.kids || [], newKids = [];
    var n = Math.max(oldKids.length, vnode.kids.length);
    for (var i = 0; i < n; i++) {
      var kv = vnode.kids[i], ko = oldKids[i];
      if (kv === undefined) { if (ko) { unmount(ko); if (ko.dom && ko.dom.parentNode) ko.dom.parentNode.removeChild(ko.dom); } continue; }
      var reuse = sameType(ko, kv) ? ko : null;
      if (ko && !reuse) { unmount(ko); if (ko.dom && ko.dom.parentNode) ko.dom.parentNode.removeChild(ko.dom); }
      var ki = reconcile(kv, inst.dom, reuse, doc);
      newKids.push(ki);
      if (ki.dom && ki.dom.parentNode !== inst.dom) inst.dom.appendChild(ki.dom);
    }
    inst.kids = newKids;
    return inst;
  }

  /* ---- public API ------------------------------------------------------ */

  function Component(props) { this.props = props; this.state = {}; }
  Component.prototype.isClassComponent = true;
  Component.prototype.setState = function (s) {
    this.state = Object.assign({}, this.state, typeof s === "function" ? s(this.state) : s);
    if (this.__rerender) this.__rerender();
  };

  function createRoot(container) {
    var doc = container.ownerDocument || global.document;
    var rootInst = null, rootVnode = null;
    var root = {
      render: function (vnode) {
        rootVnode = vnode;
        root.rerender();
      },
      rerender: function () {
        if (!rootVnode) return;
        rootInst = reconcile(rootVnode, container, rootInst, doc);
        if (rootInst.dom && rootInst.dom.parentNode !== container) {
          while (container.firstChild) container.removeChild(container.firstChild);
          container.appendChild(rootInst.dom);
        }
        flushEffects();
      },
    };
    roots.push(root);
    return root;
  }

  global.React = {
    createElement: createElement,
    useState: useState,
    useEffect: useEffect,
    useRef: useRef,
    useCallback: useCallback,
    Component: Component,
  };
  global.ReactDOM = { createRoot: createRoot };
})(typeof window !== "undefined" ? window : globalThis);
