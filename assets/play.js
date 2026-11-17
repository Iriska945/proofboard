/* Proofboard — play.html interactivity (docs/PLAYGROUND_V2.md). Vanilla JS, no libraries, no
 * build step. Loads site/assets/checker.js + catalog.json + examples.json per the A <-> B
 * contract (ProofboardChecker.check/.MODULE/.footprints; catalog.json's own shape:
 * {module, ic, inductors, capacitors, resistor_rule:{packages,e96,tolerance_pct}, footprints}).
 * checker.js, catalog.json and examples.json are read-only from here.
 */
(function () {
  "use strict";

  // Submission server (part C). Empty until it ships -> "Submissions open soon".
  var API = "";

  var SNAP = 0.05;      // mm
  var NUDGE = 0.05;     // mm, arrow key
  var NUDGE_SHIFT = 0.5; // mm, shift+arrow

  // Fixed L2 netlist: refs, pin->net map and a human role hint are the same for every design on
  // this page (docs/IR.md §5, L2: only part/x/y/rot are chosen). Mirrors bench/reference.ir.json.
  var NETLIST = [
    { ref: "U1", kind: "ic", hint: "Converter IC", pins: { "1": "GND", "2": "SW", "3": "VIN", "4": "FB", "5": "EN", "6": "BST" } },
    { ref: "L1", kind: "inductor", hint: "Inductor · SW → VOUT", pins: { "1": "SW", "2": "VOUT" } },
    { ref: "C1", kind: "cap", hint: "Bootstrap cap · SW → BST", pins: { "1": "SW", "2": "BST" } },
    { ref: "C2", kind: "cap", hint: "Input cap · VIN → GND", pins: { "1": "VIN", "2": "GND" } },
    { ref: "C5", kind: "cap", hint: "Input cap · VIN → GND", pins: { "1": "VIN", "2": "GND" } },
    { ref: "C3", kind: "cap", hint: "Output cap · GND → VOUT", pins: { "1": "GND", "2": "VOUT" } },
    { ref: "C4", kind: "cap", hint: "Output cap · GND → VOUT", pins: { "1": "GND", "2": "VOUT" } },
    { ref: "R1", kind: "res", hint: "Feedback top · VOUT → FB", pins: { "1": "VOUT", "2": "FB" } },
    { ref: "R2", kind: "res", hint: "Feedback bottom · FB → GND", pins: { "1": "FB", "2": "GND" } },
    { ref: "R3", kind: "res", hint: "EN pull-up · VIN → EN", pins: { "1": "VIN", "2": "EN" } },
    { ref: "R4", kind: "res", hint: "EN pull-down · EN → GND", pins: { "1": "EN", "2": "GND" } }
  ];
  var NETLIST_BY_REF = {};
  NETLIST.forEach(function (n) { NETLIST_BY_REF[n.ref] = n; });

  // Part cards, grouped by human role (docs/PLAYGROUND_V2.md §2). Each card lists the refs it
  // covers; a card with >1 ref gets one selector per ref. vWork is the rail voltage used to show
  // "effective capacitance at working voltage" (3.3 V output rail, 8.4 V worst-case battery).
  var CARDS = [
    { id: "ic", refs: ["U1"], kind: "ic", title: "Converter chip", locked: true,
      phrase: "The brain: switches the battery on and off about half a million times a second to make 3.3 V.",
      why: "Fixed for everyone: TI TPS563201. Everything else is your choice." },
    { id: "coil", refs: ["L1"], kind: "inductor", title: "Coil (inductor)",
      phrase: "Stores energy between switching pulses and smooths it into a steady current.",
      why: "Too small a coil saturates — it stops acting like a coil when the current gets high. Thin wire wastes power as heat. TI recommends 2.2–4.7 µH here." },
    { id: "cin", refs: ["C2", "C5"], kind: "cap", vWork: 8.4, title: "Input capacitors",
      sub: { C2: "C2", C5: "C5" },
      phrase: "Tiny reservoirs right next to the chip that hand it fast bursts of current.",
      why: "Keep them close to the chip: every extra millimetre of loop is a little antenna. Ceramic capacitors also lose capacity at high voltage." },
    { id: "cout", refs: ["C3", "C4"], kind: "cap", vWork: 3.3, title: "Output capacitors",
      sub: { C3: "C3", C4: "C4" },
      phrase: "Smooth the 3.3 V output so it doesn't ripple.",
      why: "Ceramic capacitors lose part of their capacity under voltage — small cases lose more. TI wants 20–68 µF of real capacity here." },
    { id: "cbst", refs: ["C1"], kind: "cap", vWork: 3.3, title: "Helper capacitor (bootstrap)",
      phrase: "A tiny capacitor the chip needs to drive its own switch.",
      why: "The datasheet asks for 100 nF (0.1 µF). It rarely needs changing." },
    { id: "fb", refs: ["R1", "R2"], kind: "res", title: "Voltage-setting resistors",
      sub: { R1: "R1 · top", R2: "R2 · bottom" },
      phrase: "Two resistors that tell the chip what voltage to make.",
      why: "Output = 0.768 V × (1 + R1 / R2). 33.2 k and 10 k give 3.32 V." },
    { id: "en", refs: ["R3", "R4"], kind: "res", title: "Turn-on resistors",
      sub: { R3: "R3 · pull-up", R4: "R4 · pull-down" },
      phrase: "Decide at what battery voltage the board switches on.",
      why: "Too high and a half-empty battery never starts the board." }
  ];
  var CARD_BY_REF = {};
  CARDS.forEach(function (c) { c.refs.forEach(function (r) { CARD_BY_REF[r] = c; }); });

  // Human copy for findings (docs/PLAYGROUND_V2.md §4). {value}/{limit} are filled from the
  // finding's own value/limit — never invented here. The TI ranges quoted in fixed text below
  // (2.2–4.7 µH, 3.23–3.37 V, 0.1 µF) are the same constants already quoted in docs/PLAYGROUND_V2.md.
  var RULE_COPY = {
    "T2.ISAT": { title: "The coil saturates", phrase: "At full load it needs to handle {limit} A, but this one handles {value} A." },
    "T2.IRMS": { title: "The coil overheats", phrase: "It's rated for {value} A of continuous current; the board draws 1 A." },
    "T2.L_RANGE": { title: "Coil outside TI's range", phrase: "{value} µH — TI recommends 2.2–4.7 µH for 3.3 V." },
    "T2.RIPPLE_I": { title: "Lots of ripple current", phrase: "The coil current swings by {value} A every cycle. Not fatal, but noisy." },
    "T2.COUT_EFF": { title: "Not enough output capacity", phrase: "Under voltage your output capacitors keep {value} µF; at least {limit} µF is needed." },
    "T2.CIN_EFF": { title: "Not enough input capacity", phrase: "At full battery your input capacitors keep {value} µF; at least {limit} µF is needed." },
    "T2.C_VRATING": { title: "Capacitor voltage too low", phrase: "A capacitor rated {value} V sits on a {limit} V rail." },
    "T2.CBST": { title: "Unusual helper capacitor", phrase: "The chip wants about 0.1 µF here." },
    "T2.VOUT_NOM": { title: "Wrong output voltage", phrase: "Your resistors give {value} V; it must be 3.23–3.37 V." },
    "T2.VOUT_WORST": { title: "Output may drift", phrase: "With normal part tolerances it could land anywhere in {value} V." },
    "T2.EN_DEFINED": { title: "Board may switch on by itself", phrase: "Nothing holds the enable pin when the bench leaves it floating." },
    "T2.EN_UVLO": { title: "Won't start on a low battery", phrase: "It only turns on above {value} V." },
    "T2.LOOP_IN": { title: "Input capacitor too far", phrase: "The input loop is {value} mm; keep it under {limit} mm." },
    "T2.LOOP_SW": { title: "Coil too far from the chip", phrase: "The switch loop is {value} mm; keep it under {limit} mm." },
    "T0.OVERLAP": { title: "Parts overlap", phrase: "{message} — pull them apart." },
    "T0.ZONE": { title: "Part outside the board area", phrase: "Keep everything inside the shaded area." }
  };
  var RULE_COPY_T0_DEFAULT = { title: "Design isn't complete", phrase: "{message}" };

  // Problem-card order within a severity, matching docs/PLAYGROUND_V2.md §4's own rule table
  // (coil problems first) rather than the checker's internal evaluation order.
  var PROBLEM_ORDER = ["T2.ISAT", "T2.IRMS", "T2.L_RANGE", "T2.RIPPLE_I", "T2.COUT_EFF", "T2.CIN_EFF",
    "T2.C_VRATING", "T2.CBST", "T2.VOUT_NOM", "T2.VOUT_WORST", "T2.EN_DEFINED", "T2.EN_UVLO",
    "T2.LOOP_IN", "T2.LOOP_SW", "T0.OVERLAP", "T0.ZONE"];

  // The 14 distinct T2 rule ids this checker can raise (counted directly from checker.js's own
  // validateT2 — same count already published on the home page: "14 engineering rules from the
  // TI datasheet, all enabled"). Used only to show "N of 14 rules passed"; never used to decide
  // pass/fail, which stays entirely the checker's call.
  var RULE_IDS = ["T2.VOUT_NOM", "T2.VOUT_WORST", "T2.L_RANGE", "T2.RIPPLE_I", "T2.ISAT", "T2.IRMS",
    "T2.COUT_EFF", "T2.CIN_EFF", "T2.C_VRATING", "T2.CBST", "T2.EN_DEFINED", "T2.EN_UVLO",
    "T2.LOOP_IN", "T2.LOOP_SW"];

  // Rule -> which refs a "Show me" button should highlight, used only when the finding's own
  // message doesn't already name a ref (see refsForFinding).
  var RULE_REFS = {
    "T2.ISAT": ["L1"], "T2.IRMS": ["L1"], "T2.L_RANGE": ["L1"], "T2.RIPPLE_I": ["L1"],
    "T2.COUT_EFF": ["C3", "C4"], "T2.CIN_EFF": ["C2", "C5"], "T2.CBST": ["C1"],
    "T2.VOUT_NOM": ["R1", "R2"], "T2.VOUT_WORST": ["R1", "R2"],
    "T2.EN_DEFINED": ["R3", "R4"], "T2.EN_UVLO": ["R3", "R4"],
    "T2.LOOP_IN": ["U1", "C2", "C5"], "T2.LOOP_SW": ["U1", "L1"]
  };

  // Fallbacks only used if catalog.json is ever missing resistor_rule (standard E96 mantissas).
  var FALLBACK_RESISTOR_FP = { "0603": "Resistor_SMD:R_0603_1608Metric", "0805": "Resistor_SMD:R_0805_2012Metric" };
  var FALLBACK_E96 = [100,102,105,107,110,113,115,118,121,124,127,130,133,137,140,143,147,150,154,158,
    162,165,169,174,178,182,187,191,196,200,205,210,215,221,226,232,237,243,249,255,261,267,
    274,280,287,294,301,309,316,324,332,340,348,357,365,374,383,392,402,412,422,432,442,453,
    464,475,487,499,511,523,536,549,562,576,590,604,619,634,649,665,681,698,715,732,750,768,
    787,806,825,845,866,887,909,931,953,976];

  function formatR(ohms) {
    var unit = ohms >= 1e6 ? "M" : "k";
    var div = unit === "M" ? 1e6 : 1e3;
    var v = Math.round((ohms / div) * 1000) / 1000;
    if (Number.isInteger(v)) return v + unit;
    var s = String(v), bits = s.split(".");
    var frac = bits[1].replace(/0+$/, "");
    return frac ? bits[0] + unit + frac : bits[0] + unit;
  }
  function formatROhm(ohms) {
    // "33.2 kΩ" style display caption, independent of the compact E96 notation used in part ids.
    var unit = ohms >= 1e6 ? "MΩ" : (ohms >= 1e3 ? "kΩ" : "Ω");
    var div = ohms >= 1e6 ? 1e6 : (ohms >= 1e3 ? 1e3 : 1);
    var v = Math.round((ohms / div) * 100) / 100;
    return v + " " + unit;
  }
  function resistorValuesOhm() {
    var rule = state.catalog && state.catalog.resistor_rule;
    var base = (rule && Array.isArray(rule.e96) && rule.e96.length) ? rule.e96 : FALLBACK_E96;
    var out = [];
    for (var exp = 3; exp <= 5; exp++) for (var i = 0; i < base.length; i++) out.push(Math.round(base[i] * Math.pow(10, exp - 2)));
    return out;
  }
  function resistorPackages() {
    var rule = state.catalog && state.catalog.resistor_rule;
    return (rule && rule.packages) || FALLBACK_RESISTOR_FP;
  }
  var RES_RE = /^R(0603|0805):([0-9]+)([kKMR]?)([0-9]*)$/;
  function parseResistorOhms(partId) {
    var m = RES_RE.exec(partId || "");
    if (!m) return null;
    var mult = { "": 1, "R": 1, "k": 1e3, "K": 1e3, "M": 1e6 }[m[3]];
    var v = parseInt(m[2], 10);
    if (m[4]) v += parseInt(m[4], 10) / Math.pow(10, m[4].length);
    return v * mult;
  }
  function pkgOfResistorPart(partId) {
    var m = RES_RE.exec(partId || "");
    return m ? m[1] : "0603";
  }
  function parseUserOhms(str) {
    var s = String(str || "").trim().replace(",", ".");
    var m = /^([0-9]*\.?[0-9]+)\s*([kKMR]?)\s*$/.exec(s);
    if (!m) return null;
    var mult = { "": 1, "R": 1, "k": 1e3, "K": 1e3, "M": 1e6 }[m[2]];
    return parseFloat(m[1]) * mult;
  }
  function nearestE96Ohm(targetOhm) {
    var vals = resistorValuesOhm();
    var best = vals[0], bestDiff = Infinity;
    vals.forEach(function (v) {
      var diff = Math.abs(v - targetOhm);
      if (diff < bestDiff) { bestDiff = diff; best = v; }
    });
    return best;
  }

  // ------------------------------------------------------------------------------- state
  var state = {
    checker: null, catalog: null, footprints: null, module: null, examples: null,
    design: null,      // {parts:[{ref,part,x,y,rot}]}
    lastResult: null,
    selected: null, dragging: null, highlightRefs: null, highlightTimer: null,
    tipShown: false
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function snap(v) { return Math.round(v / SNAP) * SNAP; }
  function fmt(v, d) { return v == null || isNaN(v) ? "—" : v.toFixed(d == null ? 2 : d); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  // ------------------------------------------------------------------------------- loading
  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(true); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }
  function loadJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status + " loading " + url);
      return r.json();
    });
  }

  async function init() {
    var checkerOk = await loadScript("assets/checker.js");
    state.checker = window.ProofboardChecker;
    if (!checkerOk || !state.checker) { fatal("Could not load assets/checker.js."); return; }

    try {
      state.catalog = await loadJSON("assets/catalog.json");
      state.examples = await loadJSON("assets/examples.json");
    } catch (e) {
      fatal("Could not load assets/catalog.json or assets/examples.json (" + e.message + ").");
      return;
    }
    if (!state.examples || !state.examples.reference || !state.examples.deepseek) {
      fatal("assets/examples.json is missing reference/deepseek designs.");
      return;
    }

    state.module = state.catalog.module || state.checker.MODULE || {};
    state.footprints = state.catalog.footprints || state.checker.footprints || {};

    buildCardsPanel();
    buildSvgStatic();
    attachGlobalHandlers();

    var fromHash = await parseShareHashAsync(location.hash);
    loadDesign(fromHash || designFromIR(state.examples.reference));
    setupSubmitForm();
    maybeShowDragTip();
  }

  function fatal(msg) {
    var el = $("#playRoot");
    if (el) el.innerHTML = '<p class="muted" role="alert" style="padding:28px">' + msg + " Reload the page, or check the console.</p>";
    console.error("[play.js]", msg);
  }

  // ------------------------------------------------------------------------------- IR <-> design
  function designFromIR(ir) {
    return { parts: (ir.parts || []).map(function (p) { return { ref: p.ref, part: p.part, x: p.x, y: p.y, rot: p.rot || 0 }; }) };
  }
  function buildIR(design) {
    return {
      ir_version: 1, module: "buck-tps563201-22x22-v1",
      parts: NETLIST.map(function (n) {
        var d = (design.parts || []).filter(function (p) { return p.ref === n.ref; })[0] || {};
        return { ref: n.ref, part: d.part, x: d.x, y: d.y, rot: d.rot || 0, pins: n.pins };
      })
    };
  }
  function designPart(ref) {
    return (state.design.parts || []).filter(function (p) { return p.ref === ref; })[0];
  }
  function loadDesign(design) {
    state.design = design;
    state.selected = null;
    renderParts();
    updateSelection();
    runCheck();
  }
  function fromReference(mutator) {
    var d = designFromIR(state.examples.reference);
    if (mutator) mutator(d);
    loadDesign(d);
  }

  // ------------------------------------------------------------------------------- catalog lookups
  function shortFp(fp) { return fp ? fp.split(":").pop() : ""; }
  function footprintFor(partId) {
    if (!partId) return null;
    var cat = state.catalog;
    if (cat.ic && cat.ic.id === partId) return cat.ic.footprint;
    var ind = (cat.inductors || []).filter(function (x) { return x.id === partId; })[0];
    if (ind) return ind.footprint;
    var cap = (cat.capacitors || []).filter(function (x) { return x.id === partId; })[0];
    if (cap) return cap.footprint;
    var m = /^R(0603|0805):/.exec(partId);
    if (m) return resistorPackages()[m[1]];
    return null;
  }
  function geoFor(partId) {
    var fp = footprintFor(partId);
    var geo = fp && state.footprints[fp];
    if (geo) return geo;
    return { w: 2, h: 1, bbox: [-1, -0.5, 1, 0.5], pads: {} };
  }
  function catalogRec(partId) {
    var cat = state.catalog;
    if (cat.ic && cat.ic.id === partId) return cat.ic;
    var ind = (cat.inductors || []).filter(function (x) { return x.id === partId; })[0];
    if (ind) return ind;
    return (cat.capacitors || []).filter(function (x) { return x.id === partId; })[0] || null;
  }

  // Image slug convention: footprint name after the colon, lowercased (site/assets/img/parts/<slug>.png).
  function partImageSlug(fp) { return fp ? fp.split(":").pop().toLowerCase() : null; }
  function partImageUrl(fp) {
    var slug = partImageSlug(fp);
    return slug ? "assets/img/parts/" + slug + ".png" : null;
  }

  // Parses a KiCad "<len><wid>Metric" footprint suffix (e.g. "C_0805_2012Metric") into physical
  // body size in mm (2012 -> 2.0 x 1.2 mm) -- this is the footprint's own name, not an invented
  // number. Falls back to the courtyard box (w/h), rounded, when the name doesn't encode a size
  // (e.g. the named inductor footprints, per docs/PLAYGROUND_V2.md's "курт-ярд ... округлить").
  function physicalSizeLabel(fp) {
    var geo = state.footprints[fp];
    var m = /([0-9]{2})([0-9]{2})Metric$/.exec(fp || "");
    if (m) {
      var l = parseInt(m[1], 10) / 10, w = parseInt(m[2], 10) / 10;
      return l.toFixed(1) + " × " + w.toFixed(1) + " mm";
    }
    if (geo) return Math.round(geo.w) + "×" + Math.round(geo.h) + " mm";
    return "";
  }

  function icLabel(ic) { return (ic.mpn || ic.id) + " · " + shortFp(ic.footprint); }
  function inductorOptionLabel(l) {
    var wire = l.dcr_mOhm_typ != null ? l.dcr_mOhm_typ : l.dcr_mOhm_max;
    return l.inductance_uH + " µH · handles " + l.isat_A + " A · " + (wire != null ? wire + " mΩ wire · " : "") + physicalSizeLabel(l.footprint);
  }
  function capOptionLabel(c) {
    return c.capacitance_nominal_uF + " µF · up to " + c.rated_voltage_V + " V · " + physicalSizeLabel(c.footprint);
  }
  function capEffCaption(c, vWork) {
    var eff = c.c_eff_uF && c.c_eff_uF[String(vWork)];
    if (eff == null) return "";
    return "≈ " + eff + " µF at " + vWork + " V";
  }
  function partOptionLabel(partId) {
    var cat = state.catalog;
    if (cat.ic && cat.ic.id === partId) return icLabel(cat.ic);
    var ind = (cat.inductors || []).filter(function (p) { return p.id === partId; })[0];
    if (ind) return inductorOptionLabel(ind);
    var cap = (cat.capacitors || []).filter(function (p) { return p.id === partId; })[0];
    if (cap) return capOptionLabel(cap);
    var m = /^R(0603|0805):(.+)$/.exec(partId || "");
    if (m) return formatROhm(parseResistorOhms(partId));
    return partId || "";
  }

  // ------------------------------------------------------------------------------- part thumbnails
  // Neutral fallback: if the PNG 404s, hide it and leave the drawn placeholder box underneath
  // visible -- never a broken-image icon.
  function thumbEl(fp, alt) {
    var wrap = document.createElement("div");
    wrap.className = "part-thumb";
    var box = document.createElement("div");
    box.className = "part-thumb-box";
    wrap.appendChild(box);
    var url = partImageUrl(fp);
    if (url) {
      var img = document.createElement("img");
      img.alt = alt || "";
      img.loading = "lazy";
      img.onerror = function () { img.remove(); };
      img.src = url;
      wrap.appendChild(img);
    }
    return wrap;
  }

  // ------------------------------------------------------------------------------- cards panel
  function buildCardsPanel() {
    var list = $("#cardsList");
    if (!list) return;
    list.innerHTML = "";
    CARDS.forEach(function (card) {
      var el = document.createElement("div");
      el.className = "part-card";
      el.dataset.card = card.id;

      var top = document.createElement("div");
      top.className = "part-card-top";
      top.tabIndex = 0;
      top.setAttribute("role", "button");
      top.setAttribute("aria-label", "Select " + card.title + " on the board");
      var thumb = thumbEl(footprintFor(firstPartOf(card)), card.title);
      thumb.classList.add("card-thumb-" + card.kind);
      top.appendChild(thumb);
      var text = document.createElement("div");
      text.className = "part-card-text";
      text.innerHTML = "<h3>" + escapeHtml(card.title) + "</h3><p class=\"part-phrase\">" + escapeHtml(card.phrase) + "</p>";
      top.appendChild(text);
      top.addEventListener("click", function () { selectPartAndFocus(card.refs[0]); });
      top.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectPartAndFocus(card.refs[0]); }
      });
      el.appendChild(top);

      if (!card.locked) {
        var controls = document.createElement("div");
        controls.className = "part-card-controls";
        card.refs.forEach(function (ref) {
          controls.appendChild(buildRefControl(card, ref));
        });
        el.appendChild(controls);
      }

      var details = document.createElement("details");
      details.className = "why";
      var ids = card.refs.map(function (r) { return r; }).join(", ");
      details.innerHTML = "<summary>Why it matters</summary><p>" + escapeHtml(card.why) + "</p>" +
        '<p class="mono muted ids" id="ids-' + card.id + '"></p>';
      el.appendChild(details);

      list.appendChild(el);
    });
  }

  function firstPartOf(card) {
    var d = state.design && designPart(card.refs[0]);
    return d && d.part;
  }

  function buildRefControl(card, ref) {
    var n = NETLIST_BY_REF[ref];
    var wrap = document.createElement("div");
    wrap.className = "part-ctrl";
    wrap.dataset.ref = ref;
    var label = document.createElement("label");
    label.textContent = (card.sub && card.sub[ref]) || ref;
    label.setAttribute("for", "ctrl-" + ref);
    wrap.appendChild(label);

    if (n.kind === "res") {
      var row = document.createElement("div");
      row.className = "res-row";
      var minus = document.createElement("button");
      minus.type = "button"; minus.className = "res-step"; minus.textContent = "−";
      minus.setAttribute("aria-label", "Lower " + ref + " to the previous E96 value");
      var input = document.createElement("input");
      input.type = "text"; input.id = "ctrl-" + ref; input.className = "res-input"; input.inputMode = "decimal";
      input.setAttribute("aria-describedby", "cap-" + ref);
      var plus = document.createElement("button");
      plus.type = "button"; plus.className = "res-step"; plus.textContent = "+";
      plus.setAttribute("aria-label", "Raise " + ref + " to the next E96 value");
      row.appendChild(minus); row.appendChild(input); row.appendChild(plus);
      wrap.appendChild(row);
      var cap = document.createElement("span");
      cap.className = "ctrl-caption"; cap.id = "cap-" + ref;
      wrap.appendChild(cap);
      var e96note = document.createElement("span");
      e96note.className = "ctrl-e96 mono muted"; e96note.textContent = "E96";
      wrap.appendChild(e96note);

      function stepTo(idxDelta) {
        var d = designPart(ref);
        var ohm = parseResistorOhms(d.part);
        var vals = resistorValuesOhm();
        var idx = vals.indexOf(nearestE96Ohm(ohm));
        idx = clamp(idx + idxDelta, 0, vals.length - 1);
        setResistor(ref, pkgOfResistorPart(d.part), vals[idx]);
      }
      minus.addEventListener("click", function () { stepTo(-1); });
      plus.addEventListener("click", function () { stepTo(1); });
      input.addEventListener("change", function () {
        var raw = parseUserOhms(input.value);
        var d = designPart(ref);
        if (raw == null || raw <= 0) { syncCardsPanel(); return; }
        setResistor(ref, pkgOfResistorPart(d.part), nearestE96Ohm(raw));
      });
    } else {
      var select = document.createElement("select");
      select.id = "ctrl-" + ref;
      optionsForKind(n.kind).forEach(function (o) {
        var opt = document.createElement("option");
        opt.value = o.value; opt.textContent = o.label;
        select.appendChild(opt);
      });
      if (n.kind === "ic") select.disabled = true;
      select.addEventListener("change", function () {
        var d = designPart(ref);
        if (d) d.part = select.value;
        renderParts(); syncCardsPanel(); scheduleRecheck();
      });
      wrap.appendChild(select);
      if (card.vWork) {
        var cap2 = document.createElement("span");
        cap2.className = "ctrl-caption"; cap2.id = "cap-" + ref;
        wrap.appendChild(cap2);
      }
    }
    wrap.addEventListener("click", function (ev) {
      if (ev.target === wrap || ev.target.tagName === "LABEL") selectPartAndFocus(ref);
    });
    return wrap;
  }

  function setResistor(ref, pkg, ohm) {
    var d = designPart(ref);
    d.part = "R" + pkg + ":" + formatR(ohm);
    renderParts(); syncCardsPanel(); scheduleRecheck();
  }

  function optionsForKind(kind) {
    var cat = state.catalog;
    if (kind === "ic") return cat.ic ? [{ value: cat.ic.id, label: icLabel(cat.ic) }] : [];
    if (kind === "inductor") return (cat.inductors || []).map(function (p) { return { value: p.id, label: inductorOptionLabel(p) }; });
    if (kind === "cap") return (cat.capacitors || []).map(function (p) { return { value: p.id, label: capOptionLabel(p) }; });
    return [];
  }

  function syncCardsPanel() {
    CARDS.forEach(function (card) {
      var thumbHost = $('.part-card[data-card="' + card.id + '"] .part-thumb');
      var d0 = designPart(card.refs[0]);
      if (thumbHost && d0 && d0.part) {
        var fresh = thumbEl(footprintFor(d0.part), card.title);
        fresh.className = thumbHost.className;
        thumbHost.replaceWith(fresh);
      }
      card.refs.forEach(function (ref) {
        var d = designPart(ref);
        if (!d || d.part == null) return;
        var rec = catalogRec(d.part);
        if (NETLIST_BY_REF[ref].kind === "res") {
          var input = $("#ctrl-" + ref);
          if (input && document.activeElement !== input) input.value = formatR(parseResistorOhms(d.part));
          var cap = $("#cap-" + ref);
          if (cap) cap.textContent = formatROhm(parseResistorOhms(d.part));
        } else {
          var sel = $("#ctrl-" + ref);
          if (sel) { sel.value = d.part; sel.title = d.part; }
          if (card.kind === "cap" && rec) {
            var capEl = $("#cap-" + ref);
            if (capEl) capEl.textContent = capEffCaption(rec, card.vWork);
          }
        }
      });
      var idsEl = $("#ids-" + card.id);
      if (idsEl) {
        idsEl.textContent = card.refs.map(function (r) {
          var d = designPart(r);
          return r + ": " + (d && d.part ? d.part : "—");
        }).join(" · ");
      }
    });
  }

  function selectPartAndFocus(ref) {
    selectPart(ref);
    var g = $('.part[data-ref="' + ref + '"]');
    if (g) g.focus({ preventScroll: false });
  }

  // ------------------------------------------------------------------------------- SVG board
  var SVG_NS = "http://www.w3.org/2000/svg";
  var VB = { x: -4.6, y: -0.8, w: 27.4, h: 23.6 };
  function se(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function buildSvgStatic() {
    var svg = $("#boardSvg");
    if (!svg) return;
    svg.setAttribute("viewBox", VB.x + " " + VB.y + " " + VB.w + " " + VB.h);
    svg.innerHTML = "";

    var zoneArr = state.module.free_zone || [4.5, 1.0, 21.0, 21.0];
    var zone = Array.isArray(zoneArr) ? { x0: zoneArr[0], y0: zoneArr[1], x1: zoneArr[2], y1: zoneArr[3] } : zoneArr;
    var board = state.module.board || 22.0;

    var gStatic = se("g", { "class": "board-static" });
    var gGrid = se("g", { "class": "grid" });
    for (var i = 0; i <= board; i++) {
      var major = i % 5 === 0;
      gGrid.appendChild(se("line", { x1: i, y1: 0, x2: i, y2: board, "class": major ? "grid-major" : "grid-minor" }));
      gGrid.appendChild(se("line", { x1: 0, y1: i, x2: board, y2: i, "class": major ? "grid-major" : "grid-minor" }));
    }
    gStatic.appendChild(gGrid);
    gStatic.appendChild(se("rect", { x: zone.x0, y: zone.y0, width: zone.x1 - zone.x0, height: zone.y1 - zone.y0, "class": "free-zone" }));
    gStatic.appendChild(se("rect", { x: 0, y: 0, width: board, height: board, "class": "board-outline" }));

    var conn = state.module.bench_connector || { pins: { "1": "VIN", "2": "GND", "3": "EN", "4": "GND", "5": "VOUT" }, pos: [2.0, 5.92], rot: 0, footprint: "Connector_PinHeader_2.54mm:PinHeader_1x05_P2.54mm_Vertical" };
    var connGeo = state.footprints[conn.footprint];
    var bbox = (connGeo && connGeo.bbox) ? [
      conn.pos[0] + connGeo.bbox[0], conn.pos[1] + connGeo.bbox[1],
      conn.pos[0] + connGeo.bbox[2], conn.pos[1] + connGeo.bbox[3]
    ] : [conn.pos[0] - 1.8, conn.pos[1] - 2, conn.pos[0] + 1.8, conn.pos[1] + 12];
    var pitch = 2.54;
    if (connGeo && connGeo.pads && connGeo.pads["1"] && connGeo.pads["2"]) {
      pitch = Math.hypot(connGeo.pads["2"][0] - connGeo.pads["1"][0], connGeo.pads["2"][1] - connGeo.pads["1"][1]) || 2.54;
    }
    var gConn = se("g", { "class": "bench-connector", "aria-hidden": "true" });
    gConn.appendChild(se("rect", { x: bbox[0], y: bbox[1], width: bbox[2] - bbox[0], height: bbox[3] - bbox[1], "class": "connector-body" }));
    Object.keys(conn.pins).forEach(function (pinNum, idx) {
      var py = conn.pos[1] + idx * pitch;
      var px = conn.pos[0];
      gConn.appendChild(se("circle", { cx: px, cy: py, r: 0.45, "class": "connector-pad" }));
      gConn.appendChild(se("line", { x1: VB.x + 2.9, y1: py, x2: px - 0.5, y2: py, "class": "connector-lead" }));
      var t = se("text", { x: VB.x + 0.2, y: py, "class": "connector-label", "text-anchor": "start", "dominant-baseline": "middle" });
      t.textContent = conn.pins[pinNum];
      gConn.appendChild(t);
    });
    gStatic.appendChild(gConn);

    svg.appendChild(gStatic);
    svg.appendChild(se("g", { id: "partsLayer" }));
    svg.appendChild(se("g", { id: "loopsLayer", "aria-hidden": "true" }));
    svg.appendChild(se("g", { id: "tipLayer", "aria-hidden": "true" }));
  }

  function partTitle(ref, d) {
    var n = NETLIST_BY_REF[ref];
    var label = d && d.part ? partOptionLabel(d.part) : "(no part chosen)";
    return ref + " — " + n.hint + ". " + label + ". Rotation " + ((d && d.rot) || 0) + "°. Press R to rotate, arrow keys to move.";
  }

  function renderParts() {
    var layer = $("#partsLayer");
    if (!layer) return;
    layer.innerHTML = "";
    NETLIST.forEach(function (n) {
      var d = designPart(n.ref);
      if (!d) return;
      var geo = geoFor(d.part);
      var bbox = geo.bbox || [-geo.w / 2, -geo.h / 2, geo.w / 2, geo.h / 2];
      var highlighted = state.highlightRefs && state.highlightRefs.indexOf(n.ref) !== -1;
      var g = se("g", {
        "class": "part" + (state.selected === n.ref ? " selected" : "") + (highlighted ? " highlight" : ""),
        "data-ref": n.ref, "tabindex": "0", "role": "button",
        "aria-label": partTitle(n.ref, d),
        "transform": "translate(" + d.x + "," + d.y + ") rotate(" + (d.rot || 0) + ")"
      });
      // courtyard = the grab area, drawn as a faint outline
      g.appendChild(se("rect", { x: bbox[0], y: bbox[1], width: bbox[2] - bbox[0], height: bbox[3] - bbox[1], "class": "part-body" }));

      // top view of the real part: coloured body between the pads, silver pads on top
      var kind = /^IC_/.test(d.part) ? "ic" : (d.part.charAt(0) === "L" ? "ind" : (d.part.charAt(0) === "R" ? "res" : "cap"));
      var padKeys = Object.keys(geo.pads || {});
      var xs = padKeys.map(function (k) { return geo.pads[k][0]; }), ys = padKeys.map(function (k) { return geo.pads[k][1]; });
      var cw = bbox[2] - bbox[0], ch = bbox[3] - bbox[1];
      var bw, bh;
      if (kind === "ic") { bw = cw * 0.42; bh = ch * 0.78; }
      else if (kind === "ind") { bw = cw * 0.78; bh = ch * 0.78; }
      else { bw = (xs.length ? Math.max.apply(null, xs) - Math.min.apply(null, xs) : cw * 0.6) + 0.1; bh = ch * 0.5; }
      g.appendChild(se("rect", { x: -bw / 2, y: -bh / 2, width: bw, height: bh, rx: kind === "ind" ? 0.35 : 0.08,
                                 "class": "part-shape part-" + kind }));
      if (kind === "ic") g.appendChild(se("circle", { cx: -bw / 2 + 0.3, cy: -bh / 2 + 0.3, r: 0.12, "class": "part-pin1" }));
      var padR = kind === "ic" ? 0.22 : Math.min(0.42, Math.min(cw, ch) * 0.2);
      padKeys.forEach(function (pn) {
        var off = geo.pads[pn];
        g.appendChild(se("rect", { x: off[0] - padR, y: off[1] - padR, width: 2 * padR, height: 2 * padR, rx: 0.06, "class": "part-pad" }));
      });
      var label = se("text", { x: 0, y: 0, "class": "part-refdes", "text-anchor": "middle",
                               "dominant-baseline": "central", "transform": "rotate(" + (-(d.rot || 0)) + ")" });
      label.textContent = n.ref;
      g.appendChild(label);

      g.addEventListener("pointerdown", onPartPointerDown);
      g.addEventListener("focus", function () { selectPart(n.ref); });
      layer.appendChild(g);
    });
    renderLoops();
  }

  function selectPart(ref) {
    state.selected = ref;
    $all(".part", $("#partsLayer")).forEach(function (g) {
      g.classList.toggle("selected", g.dataset.ref === ref);
    });
    $all(".part-card").forEach(function (c) { c.classList.remove("active"); });
    $all(".part-ctrl").forEach(function (r) { r.classList.toggle("active", r.dataset.ref === ref); });
    var card = ref && CARD_BY_REF[ref];
    if (card) { var el = $('.part-card[data-card="' + card.id + '"]'); if (el) el.classList.add("active"); }
    var btn = $("#rotateBtn");
    if (btn) btn.disabled = !ref;
  }
  function updateSelection() { selectPart(state.selected); }

  function svgPoint(svg, clientX, clientY) {
    var pt = svg.createSVGPoint ? svg.createSVGPoint() : { x: 0, y: 0 };
    pt.x = clientX; pt.y = clientY;
    var ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    var m = ctm.inverse();
    var p = pt.matrixTransform(m);
    return { x: p.x, y: p.y };
  }

  function onPartPointerDown(ev) {
    var g = ev.currentTarget;
    var ref = g.dataset.ref;
    selectPart(ref);
    g.focus();
    dismissDragTip();
    var svg = $("#boardSvg");
    var d = designPart(ref);
    var start = svgPoint(svg, ev.clientX, ev.clientY);
    state.dragging = { ref: ref, startX: start.x, startY: start.y, origX: d.x, origY: d.y, moved: false };
    try { g.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();

    function onMove(me) {
      var p = svgPoint(svg, me.clientX, me.clientY);
      var dx = p.x - state.dragging.startX, dy = p.y - state.dragging.startY;
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) state.dragging.moved = true;
      var nd = designPart(ref);
      nd.x = snap(state.dragging.origX + dx);
      nd.y = snap(state.dragging.origY + dy);
      g.setAttribute("transform", "translate(" + nd.x + "," + nd.y + ") rotate(" + (nd.rot || 0) + ")");
      renderLoops();
      scheduleRecheck();
    }
    function onUp(ue) {
      g.removeEventListener("pointermove", onMove);
      g.removeEventListener("pointerup", onUp);
      g.removeEventListener("pointercancel", onUp);
      try { g.releasePointerCapture(ue.pointerId); } catch (e) {}
      state.dragging = null;
      runCheck();
    }
    g.addEventListener("pointermove", onMove);
    g.addEventListener("pointerup", onUp);
    g.addEventListener("pointercancel", onUp);
  }

  function rotateSelected() {
    if (!state.selected) return;
    var d = designPart(state.selected);
    if (!d) return;
    d.rot = ((d.rot || 0) + 90) % 360;
    renderParts();
    updateSelection();
    scheduleRecheck();
    runCheck();
  }

  function nudgeSelected(dx, dy) {
    if (!state.selected) return;
    var d = designPart(state.selected);
    if (!d) return;
    d.x = snap(d.x + dx);
    d.y = snap(d.y + dy);
    renderParts();
    updateSelection();
    var g = $('.part[data-ref="' + state.selected + '"]');
    if (g) g.focus();
    scheduleRecheck();
    runCheck();
  }

  // ------------------------------------------------------------------------------- loops overlay
  var ROT_CS = { 0: [1, 0], 90: [0, -1], 180: [-1, 0], 270: [0, 1] };
  function normRot(r) { return ((r % 360) + 360) % 360; }
  function rotOff(ox, oy, rot) {
    var cs = ROT_CS[normRot(rot)], cc = cs[0], ss = cs[1];
    return [ox * cc + oy * ss, -ox * ss + oy * cc];
  }
  function absPad(part, geo, pad) {
    var off = geo.pads && geo.pads[pad];
    if (!off) return null;
    var d = rotOff(off[0], off[1], part.rot || 0);
    return [part.x + d[0], part.y + d[1]];
  }

  function computeLoopPaths() {
    var icD = designPart("U1");
    if (!icD || !icD.part) return {};
    var icGeo = geoFor(icD.part);
    var vinPin = absPad(icD, icGeo, "3"), gndPin = absPad(icD, icGeo, "1"), swPin = absPad(icD, icGeo, "2");
    var inPath = null;
    if (vinPin && gndPin) {
      var best = null, bestDist = Infinity;
      ["C2", "C5"].forEach(function (ref) {
        var d = designPart(ref);
        if (!d || !d.part) return;
        var geo = geoFor(d.part);
        var vp = absPad(d, geo, "1"); // pin 1 = VIN on the input-cap role
        if (!vp) return;
        var dist = Math.hypot(vp[0] - vinPin[0], vp[1] - vinPin[1]);
        if (dist < bestDist) { bestDist = dist; best = { vpad: vp, gpad: absPad(d, geo, "2") }; }
      });
      if (best && best.gpad) inPath = [vinPin, best.vpad, best.gpad, gndPin];
    }
    var swPath = null;
    if (swPin) {
      var ld = designPart("L1");
      if (ld && ld.part) {
        var lgeo = geoFor(ld.part);
        var p1 = absPad(ld, lgeo, "1"), p2 = absPad(ld, lgeo, "2");
        var d1 = p1 ? Math.hypot(p1[0] - swPin[0], p1[1] - swPin[1]) : Infinity;
        var d2 = p2 ? Math.hypot(p2[0] - swPin[0], p2[1] - swPin[1]) : Infinity;
        var near = d1 <= d2 ? p1 : p2;
        if (near) swPath = [swPin, near];
      }
    }
    return { inPath: inPath, swPath: swPath };
  }

  function loopClass(value, limit) {
    if (value == null) return "loop-unknown";
    if (value <= limit) return "loop-good";
    if (value <= limit * 2) return "loop-warn";
    return "loop-bad";
  }

  function renderLoops() {
    var layer = $("#loopsLayer");
    if (!layer) return;
    layer.innerHTML = "";
    var paths = computeLoopPaths();
    var metrics = (state.lastResult && state.lastResult.metrics) || {};
    var loops = metrics.loops_mm || {};

    function drawPath(pts, cls, label, name, limit) {
      if (!pts) return;
      var d = pts.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0] + "," + p[1]; }).join(" ");
      layer.appendChild(se("path", { d: d, "class": "loop-line " + cls, fill: "none" }));
      pts.forEach(function (p) { layer.appendChild(se("circle", { cx: p[0], cy: p[1], r: 0.18, "class": "loop-dot " + cls })); });
      if (label != null && false) {
        var mid = pts[Math.floor(pts.length / 2)];
        var g = se("g", { "class": "loop-badge " + cls, transform: "translate(" + mid[0] + "," + (mid[1] - 1.1) + ")" });
        var txt = name + " " + fmt(label, 1) + " mm" + (label > limit ? " · aim < " + limit : "");
        var wdt = 0.62 * txt.length + 0.8;
        g.appendChild(se("rect", { x: -wdt / 2, y: -0.7, width: wdt, height: 1.4, rx: 0.4 }));
        var t = se("text", { x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central" });
        t.textContent = txt;
        g.appendChild(t);
        layer.appendChild(g);
      }
    }
    drawPath(paths.inPath, loopClass(loops.in, 3), loops.in, "input", 3);
    drawPath(paths.swPath, loopClass(loops.sw, 4), loops.sw, "switch", 4);
    var legend = document.getElementById("loopLegend");
    if (legend) {
      var item = function (name, v, lim) {
        if (v == null) return "";
        var c = loopClass(v, lim);
        return '<span class="loop-key ' + c + '"><i></i>' + name + ' <b>' + fmt(v, 1) + ' mm</b> <small>aim &lt; ' + lim + ' mm</small></span>';
      };
      legend.innerHTML = item("Switch loop (chip → coil)", loops.sw, 4) + item("Input loop (chip → input capacitor)", loops.in, 3);
    }
  }

  // ------------------------------------------------------------------------------- recheck
  var recheckTimer = null;
  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(runCheck, 50);
  }

  function runCheck() {
    if (!state.design) return;
    var ir = buildIR(state.design);
    var result;
    try {
      result = state.checker.check(ir, state.catalog);
    } catch (e) {
      console.error("[play.js] checker threw", e);
      result = { verdict: "fail", findings: [{ rule: "HARNESS", tier: "T0", severity: "error", blame: "harness_limit", message: "The checker raised an error: " + e.message }], metrics: {}, roles: {} };
    }
    state.lastResult = result;
    syncCardsPanel();
    renderVerdict(result);
    renderScoreboard(result);
    renderLoops();
  }

  function sevClass(sev) { return sev === "error" ? "e" : sev === "warning" ? "w" : "i"; }
  function sevLabel(sev) { return sev === "error" ? "ERROR" : sev === "warning" ? "WARN" : "INFO"; }
  function findingLi(f) {
    var src = f.source ? '<span class="src">' + escapeHtml(f.source) + "</span>" : "";
    return '<li><span class="sev ' + sevClass(f.severity) + '">' + sevLabel(f.severity) + "</span><span><code>" +
      escapeHtml(f.rule) + "</code> — " + escapeHtml(f.message) + src + "</span></li>";
  }

  function trimNum(x) {
    // Checker findings already carry a pre-rounded value/limit (round(x,2) or round(x,3)); show
    // it with its own precision instead of re-padding with zeros ("3 mm", not "3.000 mm").
    return String(Math.round(x * 1000) / 1000);
  }
  function fmtPlaceholderValue(v) {
    if (v == null) return "—";
    if (Array.isArray(v)) return v.map(trimNum).join("–");
    if (typeof v === "number") return trimNum(v);
    return String(v);
  }

  function humanFinding(f) {
    var copy = RULE_COPY[f.rule];
    if (!copy && f.tier === "T0") copy = RULE_COPY_T0_DEFAULT;
    if (!copy) copy = { title: f.rule, phrase: "{message}" };
    var phrase = copy.phrase
      .replace("{value}", fmtPlaceholderValue(f.value))
      .replace("{limit}", fmtPlaceholderValue(f.limit))
      .replace("{message}", f.message || "");
    return { title: copy.title, phrase: phrase };
  }

  function refsForFinding(f) {
    var found = (f.message || "").match(/\b([A-Z][A-Z]?[0-9]{1,2})\b/g);
    if (found) {
      var valid = found.filter(function (r) { return NETLIST_BY_REF[r]; });
      if (valid.length) return Array.from(new Set(valid));
    }
    return RULE_REFS[f.rule] || null;
  }

  function problemCard(f, idx) {
    var human = humanFinding(f);
    var refs = refsForFinding(f);
    var sev = f.severity === "error" ? "e" : f.severity === "warning" ? "w" : "i";
    var showBtn = refs ? '<button type="button" class="show-me-btn" data-action="show-me" data-refs="' +
      escapeHtml(refs.join(",")) + '">Show me</button>' : "";
    return '<div class="problem-card sev-' + sev + '">' +
      '<div class="problem-head"><span class="sev ' + sev + '">' + sevLabel(f.severity) + '</span>' +
      '<h3>' + escapeHtml(human.title) + '</h3></div>' +
      '<p class="problem-phrase">' + escapeHtml(human.phrase) + '</p>' +
      showBtn +
      '<details class="tech-detail"><summary>Technical detail</summary><ul class="findings">' + findingLi(f) + '</ul></details>' +
      '</div>';
  }

  function renderVerdict(result) {
    var findings = result.findings || [];
    var visible = findings.filter(function (f) { return f.rule !== "T1.SKIPPED"; });
    var errRules = Array.from(new Set(visible.filter(function (f) { return f.severity === "error"; }).map(function (f) { return f.rule; })));
    var warnRules = Array.from(new Set(visible.filter(function (f) { return f.severity === "warning"; }).map(function (f) { return f.rule; })));

    var headline = $("#verdictHeadline");
    if (headline) {
      var level, text;
      if (errRules.length) {
        level = "fail";
        text = errRules.length + (errRules.length === 1 ? " problem" : " problems") + " to fix";
      } else if (warnRules.length) {
        level = "warn";
        text = "Passes, with " + warnRules.length + (warnRules.length === 1 ? " thing" : " things") + " to watch";
      } else {
        level = "pass";
        text = "Your board would pass every rule";
      }
      headline.textContent = text;
      headline.className = "verdict-headline " + level;
    }

    var list = $("#problemsList");
    if (list) {
      var shown = visible.slice().sort(function (a, b) {
        var rank = { error: 0, warning: 1, info: 2 };
        var sevDiff = rank[a.severity] - rank[b.severity];
        if (sevDiff) return sevDiff;
        // Within the same severity, keep docs/PLAYGROUND_V2.md §4's own rule order (coil
        // problems first) rather than the checker's internal evaluation order.
        var ia = PROBLEM_ORDER.indexOf(a.rule), ib = PROBLEM_ORDER.indexOf(b.rule);
        if (ia === -1) ia = PROBLEM_ORDER.length;
        if (ib === -1) ib = PROBLEM_ORDER.length;
        return ia - ib;
      });
      list.innerHTML = shown.length
        ? shown.map(problemCard).join("")
        : '<p class="muted">Nothing to fix.</p>';
    }
  }

  function renderScoreboard(result) {
    var findings = (result.findings || []).filter(function (f) { return f.rule !== "T1.SKIPPED"; });
    var errRuleIds = new Set(findings.filter(function (f) { return f.severity === "error"; }).map(function (f) { return f.rule; }));
    var passedCount = RULE_IDS.filter(function (r) { return !errRuleIds.has(r); }).length;
    var ok = passedCount === RULE_IDS.length;
    var rulesEl = $("#scoreYouRules");
    if (rulesEl) rulesEl.innerHTML = '<span class="score-icon ' + (ok ? "ok" : "bad") + '">' + (ok ? CHECK_SVG : CROSS_SVG) + "</span>" +
      passedCount + " of " + RULE_IDS.length + " passed";
    var m = result.metrics || {};
    var loops = m.loops_mm || {};
    var loopEl = $("#scoreYouLoop");
    if (loopEl) loopEl.textContent = loops.in != null ? fmt(loops.in, 1) + " mm" : "—";
    var voutEl = $("#scoreYouVout");
    if (voutEl) voutEl.textContent = m.vout_nom != null ? fmt(m.vout_nom, 2) + " V" : "—";

    var metricsEl = $("#metricsCompact");
    if (metricsEl) {
      var rows = [
        ["Output", m.vout_nom != null ? fmt(m.vout_nom, 2) + " V" : "—"],
        ["Input loop", loops.in != null ? fmt(loops.in, 1) + " mm" : "—"],
        ["Switch loop", loops.sw != null ? fmt(loops.sw, 1) + " mm" : "—"],
        ["Real output capacity", m.cout_eff_uF != null ? fmt(m.cout_eff_uF, 1) + " µF" : "—"],
        ["Real input capacity", m.cin_eff_uF != null ? fmt(m.cin_eff_uF, 1) + " µF" : "—"]
      ];
      metricsEl.innerHTML = rows.map(function (r) {
        return '<div class="metric-chip"><span class="mc-l">' + r[0] + "</span><span class=\"mc-v\">" + r[1] + "</span></div>";
      }).join("");
    }
  }

  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var CROSS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  // ------------------------------------------------------------------------------- show-me highlight
  function setHighlight(refs) {
    state.highlightRefs = refs;
    renderParts();
    updateSelection();
    clearTimeout(state.highlightTimer);
    state.highlightTimer = setTimeout(function () { state.highlightRefs = null; renderParts(); updateSelection(); }, 2600);
  }

  // ------------------------------------------------------------------------------- first-visit drag tip
  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, v) { try { window.localStorage.setItem(key, v); } catch (e) {} }

  function maybeShowDragTip() {
    if (lsGet("pb_play_drag_tip_seen")) return;
    var layer = $("#tipLayer");
    var c2 = designPart("C2");
    if (!layer || !c2) return;
    state.tipShown = true;
    var g = se("g", { "class": "drag-tip", transform: "translate(" + c2.x + "," + (c2.y - 2.2) + ")" });
    g.appendChild(se("rect", { x: -9, y: -1.1, width: 18, height: 2.2, rx: 0.5 }));
    var t = se("text", { x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central" });
    t.textContent = "Drag me closer to the chip";
    g.appendChild(t);
    layer.appendChild(g);
    setTimeout(dismissDragTip, 8000);
  }
  function dismissDragTip() {
    if (!state.tipShown) return;
    state.tipShown = false;
    lsSet("pb_play_drag_tip_seen", "1");
    var layer = $("#tipLayer");
    if (layer) layer.innerHTML = "";
  }

  // ------------------------------------------------------------------------------- share (URL hash)
  function bytesToBase64Url(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlToBytes(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    var bin = atob(str);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function compress(bytes) {
    if (!("CompressionStream" in window)) return { bytes: bytes, flag: 0 };
    try {
      var cs = new CompressionStream("deflate-raw");
      var writer = cs.writable.getWriter();
      writer.write(bytes); writer.close();
      var out = await new Response(cs.readable).arrayBuffer();
      return { bytes: new Uint8Array(out), flag: 1 };
    } catch (e) { return { bytes: bytes, flag: 0 }; }
  }
  async function decompress(bytes) {
    if (!("DecompressionStream" in window)) throw new Error("no DecompressionStream");
    var ds = new DecompressionStream("deflate-raw");
    var writer = ds.writable.getWriter();
    writer.write(bytes); writer.close();
    var out = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(out);
  }
  async function buildShareHash(design) {
    var compact = design.parts.map(function (p) { return [p.ref, p.part, p.x, p.y, p.rot || 0]; });
    var json = JSON.stringify(compact);
    var payload = new TextEncoder().encode(json);
    var c = await compress(payload);
    var full = new Uint8Array(c.bytes.length + 1);
    full[0] = c.flag;
    full.set(c.bytes, 1);
    return "d=" + bytesToBase64Url(full);
  }
  async function parseShareHashAsync(hash) {
    if (!hash || hash.indexOf("#d=") !== 0) return null;
    try {
      var bytes = base64UrlToBytes(hash.slice(3));
      var flag = bytes[0];
      var payload = bytes.slice(1);
      if (flag === 1) payload = await decompress(payload);
      var json = new TextDecoder().decode(payload);
      var compact = JSON.parse(json);
      return { parts: compact.map(function (row) { return { ref: row[0], part: row[1], x: row[2], y: row[3], rot: row[4] || 0 }; }) };
    } catch (e) {
      console.warn("[play.js] could not parse #d= share link", e);
      return null;
    }
  }
  async function doShare() {
    var hash = await buildShareHash(state.design);
    history.replaceState(null, "", location.pathname + location.search + "#" + hash);
    var url = location.href;
    var ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch (e) { ok = false; }
    var note = $("#shareNote");
    if (note) {
      note.textContent = ok ? "Link copied to clipboard." : "Could not copy automatically — copy it from the address bar.";
      note.hidden = false;
      clearTimeout(note._t);
      note._t = setTimeout(function () { note.hidden = true; }, 3000);
    }
  }

  // ------------------------------------------------------------------------------- actions / keys
  function attachGlobalHandlers() {
    document.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-action]");
      if (!btn) return;
      var action = btn.dataset.action;
      if (action === "break-it") fromReference(function (d) {
        d.parts.filter(function (p) { return p.ref === "L1"; })[0].part = "L_6R8_SRN2012T_BADISAT_BADDCR";
      });
      else if (action === "move-cap") fromReference(function (d) {
        var c2 = d.parts.filter(function (p) { return p.ref === "C2"; })[0];
        c2.x = 18.5; c2.y = 19.0;
      });
      else if (action === "load-ai") { history.replaceState(null, "", location.pathname + location.search); loadDesign(designFromIR(state.examples.deepseek)); }
      else if (action === "reset") { history.replaceState(null, "", location.pathname + location.search); loadDesign(designFromIR(state.examples.reference)); }
      else if (action === "rotate") rotateSelected();
      else if (action === "share") doShare();
      else if (action === "show-me") { var refs = (btn.dataset.refs || "").split(",").filter(Boolean); if (refs.length) setHighlight(refs); }
    });

    document.addEventListener("keydown", function (ev) {
      var tag = (ev.target && ev.target.tagName) || "";
      var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (!typing && (ev.key === "r" || ev.key === "R")) { rotateSelected(); return; }
      if (!state.selected) return;
      var isPartFocused = ev.target && ev.target.classList && ev.target.classList.contains("part");
      if (!isPartFocused && typing) return;
      var step = ev.shiftKey ? NUDGE_SHIFT : NUDGE;
      if (ev.key === "ArrowUp") { nudgeSelected(0, -step); ev.preventDefault(); }
      else if (ev.key === "ArrowDown") { nudgeSelected(0, step); ev.preventDefault(); }
      else if (ev.key === "ArrowLeft") { nudgeSelected(-step, 0); ev.preventDefault(); }
      else if (ev.key === "ArrowRight") { nudgeSelected(step, 0); ev.preventDefault(); }
    });

    window.addEventListener("hashchange", async function () {
      var d = await parseShareHashAsync(location.hash);
      if (d) loadDesign(d);
    });
  }

  // ------------------------------------------------------------------------------- submit form
  function setupSubmitForm() {
    var form = $("#submitForm");
    if (!form) return;
    var note = $("#submitNote");
    if (!API) {
      $all("input, button", form).forEach(function (el) { el.disabled = true; });
      var btn = $('button[type="submit"]', form);
      if (btn) btn.textContent = "Submissions open soon";
      if (note) note.textContent = "The submission server (part C of this playground) hasn't shipped yet — nothing you enter here is sent anywhere.";
      return;
    }
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var name = $('input[name="silkname"]', form).value.trim();
      var email = $('input[name="email"]', form).value.trim();
      if (!/^[A-Za-z]{1,12}$/.test(name)) {
        if (note) note.textContent = "Name must be 1–12 Latin letters.";
        return;
      }
      var ir = buildIR(state.design);
      fetch(API + "/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ir: ir, silkname: name, email: email || undefined })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (note) note.textContent = res && res.ok ? "Submitted." : "Submission was rejected: " + (res && res.message || "unknown error");
      }).catch(function () {
        if (note) note.textContent = "Could not reach the submission server.";
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
