/*
 * ProofboardChecker -- dependency-free JS port of bench/ir.py + bench/roles.py +
 * bench/validate.py (T0 + T2). docs/PLAYGROUND.md is the contract; docs/IR.md is the spec.
 *
 * Works as a browser global (window.ProofboardChecker), as CommonJS (require(...)), and from
 * a Cloudflare Worker (globalThis.ProofboardChecker). No build step, no dependencies.
 *
 * ProofboardChecker.check(ir, catalog) -> {verdict, findings, metrics, roles}
 * ProofboardChecker.MODULE      -- board/free-zone/bench-connector geometry (bench/common.py)
 * ProofboardChecker.footprints  -- {fp: {w, h, pads: {"1": [x,y], ...}}} (bench/footprints.py)
 *
 * `catalog` is the parsed contents of site/assets/catalog.json (tools/export_catalog.py).
 * Calling check() also refreshes ProofboardChecker.MODULE/.footprints from that catalog, so a
 * page that calls check() at least once can rely on them afterwards; the values below are a
 * static fallback (identical to bench/common.py) usable before any catalog has been loaded.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ small Python-isms ---
  // Python's f-string default formatting differs from JS's in exactly two ways that matter
  // here: f"{x}" on a `repr()`'d value quotes strings (and lists of strings), and f"{x}" on a
  // float that happens to be integer-valued keeps a trailing ".0" that plain Number#toString
  // drops. These helpers exist only to keep message text byte-identical to Python's.

  function pyRepr(v) {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return pyReprStr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    return String(v);
  }

  function pyReprStr(s) {
    var hasSingle = s.indexOf("'") !== -1;
    var hasDouble = s.indexOf('"') !== -1;
    var quote = (hasSingle && !hasDouble) ? '"' : "'";
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === "\\") out += "\\\\";
      else if (ch === quote) out += "\\" + quote;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\r") out += "\\r";
      else out += ch;
    }
    return quote + out + quote;
  }

  function pyNumStr(x) {
    if (typeof x !== "number") return String(x);
    if (!isFinite(x)) return x > 0 ? "inf" : (x < 0 ? "-inf" : "nan");
    return String(x);
  }

  // Force the ".0" Python shows for a float that happens to be a whole number (e.g. a
  // resistor value in ohms, which bench/catalog.py always produces via float arithmetic).
  function pyFloatStr(x) {
    if (Number.isInteger(x)) return x.toFixed(1);
    return pyNumStr(x);
  }

  function pyStr(v) {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    return String(v);
  }

  function fmtFixed(x, digits) {
    if (x === null || x === undefined || !isFinite(x)) return String(x);
    var sign = (x < 0 && x !== 0) ? "" : ""; // toFixed already handles sign
    return x.toFixed(digits);
  }

  function round(x, digits) {
    if (x === null || x === undefined) return x;
    // Number#toFixed rounds based on the double's actual (correctly-rounded-to-decimal)
    // value, matching Python's round() for doubles; `Math.round(x * 10**n) / 10**n` can
    // double-round and disagree with Python right at a x.xx5 boundary (e.g. 18.965 - 2.05).
    return Number(x.toFixed(digits));
  }

  function sortedCopy(arr) {
    return arr.slice().sort();
  }

  // ------------------------------------------------------------------------- findings -----
  function mkFinding(rule, tier, severity, blame, message, extra) {
    extra = extra || {};
    return {
      rule: rule,
      tier: tier,
      severity: severity,
      blame: blame,
      value: extra.value !== undefined ? extra.value : null,
      limit: extra.limit !== undefined ? extra.limit : null,
      unit: extra.unit !== undefined ? extra.unit : null,
      source: extra.source !== undefined ? extra.source : null,
      message: message,
    };
  }

  // ------------------------------------------------------------------------- IR v1 (ir.py) --
  var IR_VERSION = 1;
  var NET_RE = /^[A-Z][A-Z0-9_]{0,15}$/;
  var NET_RE_PATTERN = "^[A-Z][A-Z0-9_]{0,15}$";
  var REQUIRED_NETS = ["EN", "GND", "VIN", "VOUT"];
  var ALLOWED_ROT = [0, 90, 180, 270];
  var PART_FIELDS = ["ref", "part", "x", "y", "rot", "pins"];
  var MODULE_ID = "buck-tps563201-22x22-v1";
  var MODULES_SORTED = [MODULE_ID];

  function schemaErr(message, extra) {
    extra = Object.assign({ source: "docs/IR.md §1" }, extra || {});
    return mkFinding("T0.SCHEMA", "T0", "error", "model_error", message, extra);
  }

  function validateSchema(ir) {
    var errs = [];
    if (typeof ir !== "object" || ir === null || Array.isArray(ir)) {
      return [schemaErr("IR document must be a JSON object")];
    }
    if (ir.ir_version !== IR_VERSION) {
      errs.push(schemaErr("ir_version must be " + IR_VERSION + ", got " + pyRepr(ir.ir_version)));
    }
    if (MODULES_SORTED.indexOf(ir.module) === -1) {
      errs.push(schemaErr("module must be one of " + pyRepr(MODULES_SORTED) + ", got " + pyRepr(ir.module)));
    }
    var parts = ir.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      errs.push(schemaErr("parts must be a non-empty list"));
      return errs;
    }
    var seenRefs = {};
    var seenNets = {};
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var where = "parts[" + i + "]";
      if (typeof p !== "object" || p === null || Array.isArray(p)) {
        errs.push(schemaErr(where + ": not an object"));
        continue;
      }
      var missing = PART_FIELDS.filter(function (k) { return !(k in p); });
      if (missing.length) {
        var refForMsg = ("ref" in p) ? pyStr(p.ref) : "?";
        errs.push(schemaErr(where + " (" + refForMsg + "): missing fields " + pyRepr(missing)));
        continue;
      }
      var ref = p.ref;
      where = "part " + pyRepr(ref);
      if (typeof ref !== "string" || ref === "") {
        errs.push(schemaErr(where + ": ref must be a non-empty string"));
      } else if (seenRefs[ref]) {
        errs.push(schemaErr(where + ": duplicate ref"));
      } else {
        seenRefs[ref] = true;
      }
      if (typeof p.part !== "string" || p.part === "") {
        errs.push(schemaErr(where + ": part must be a non-empty string"));
      }
      ["x", "y"].forEach(function (f) {
        if (typeof p[f] !== "number") {
          errs.push(schemaErr(where + ": " + f + " must be a number"));
        }
      });
      if (ALLOWED_ROT.indexOf(p.rot) === -1) {
        errs.push(schemaErr(where + ": rot must be one of [0, 90, 180, 270], got " + pyRepr(p.rot)));
      }
      var pins = p.pins;
      if (typeof pins !== "object" || pins === null || Array.isArray(pins) || Object.keys(pins).length === 0) {
        errs.push(schemaErr(where + ": pins must be a non-empty object"));
        continue;
      }
      Object.keys(pins).forEach(function (pad) {
        var net = pins[pad];
        if (!/^[0-9]+$/.test(pad)) {
          errs.push(schemaErr(where + ": pin key " + pyRepr(pad) + " must be a digit string"));
        }
        if (typeof net !== "string" || !NET_RE.test(net)) {
          errs.push(schemaErr(where + ": pin " + pyRepr(pad) + " net " + pyRepr(net) +
            " does not match " + NET_RE_PATTERN));
        } else {
          seenNets[net] = true;
        }
      });
    }
    var missingNets = REQUIRED_NETS.filter(function (n) { return !seenNets[n]; });
    if (missingNets.length) {
      errs.push(schemaErr("required bench nets missing from the design: " + pyRepr(sortedCopy(missingNets))));
    }
    return errs;
  }

  // ------------------------------------------------------------------- catalog (catalog.py) --
  var E96_FALLBACK = [
    100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130, 133, 137, 140, 143, 147, 150,
    154, 158, 162, 165, 169, 174, 178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226, 232,
    237, 243, 249, 255, 261, 267, 274, 280, 287, 294, 301, 309, 316, 324, 332, 340, 348, 357,
    365, 374, 383, 392, 402, 412, 422, 432, 442, 453, 464, 475, 487, 499, 511, 523, 536, 549,
    562, 576, 590, 604, 619, 634, 649, 665, 681, 698, 715, 732, 750, 768, 787, 806, 825, 845,
    866, 887, 909, 931, 953, 976,
  ];
  var RESISTOR_RE = /^R(0603|0805):([0-9]+)([kKMR]?)([0-9]*)$/;
  var RESISTOR_NOTATION_RE = /^([0-9]+)([kKMR]?)([0-9]*)$/;
  var IC_ALIAS = "IC_TPS563201";

  function PartNotFound(message) {
    this.message = message;
    this.name = "PartNotFound";
  }
  PartNotFound.prototype = Object.create(Error.prototype);
  PartNotFound.prototype.constructor = PartNotFound;

  function parseResistorNotation(valueStr) {
    var s = String(valueStr).trim();
    var m = RESISTOR_NOTATION_RE.exec(s);
    if (!m) throw new PartNotFound("cannot parse resistor notation " + pyRepr(valueStr));
    var intpart = m[1], unit = m[2], frac = m[3];
    var mult = { "": 1.0, "R": 1.0, "k": 1e3, "K": 1e3, "M": 1e6 }[unit];
    var value = parseInt(intpart, 10);
    if (frac) value += parseInt(frac, 10) / Math.pow(10, frac.length);
    return value * mult;
  }

  function isE96(valueOhm, e96set) {
    if (valueOhm === null || valueOhm === undefined || valueOhm <= 0) return false;
    var exp = Math.floor(Math.log10(valueOhm) + 1e-9);
    var mantissa = valueOhm / Math.pow(10, exp - 2);
    var rounded = Math.round(mantissa);
    if (!(rounded >= 100 && rounded <= 999)) return false;
    if (Math.abs(mantissa - rounded) >= 1e-6 * rounded) return false;
    return e96set.has(rounded);
  }

  function getE96Set(catalog) {
    var e96 = (catalog && catalog.resistor_rule && catalog.resistor_rule.e96) || E96_FALLBACK;
    return new Set(e96);
  }

  function getResistorFootprints(catalog) {
    if (catalog && catalog.resistor_rule && catalog.resistor_rule.packages) {
      return catalog.resistor_rule.packages;
    }
    return { "0603": "Resistor_SMD:R_0603_1608Metric", "0805": "Resistor_SMD:R_0805_2012Metric" };
  }

  function getResistorTolerance(catalog) {
    if (catalog && catalog.resistor_rule && typeof catalog.resistor_rule.tolerance_pct === "number") {
      return catalog.resistor_rule.tolerance_pct;
    }
    return 1;
  }

  function resolvePart(partStr, catalog) {
    if (typeof partStr !== "string" || partStr === "") {
      throw new PartNotFound("part must be a non-empty string, got " + pyRepr(partStr));
    }
    var m = RESISTOR_RE.exec(partStr);
    if (m) {
      var pkg = m[1], intpart = m[2], unit = m[3], frac = m[4];
      var valueStr = intpart + unit + frac;
      var valueOhm = parseResistorNotation(valueStr);
      if (!isE96(valueOhm, getE96Set(catalog))) {
        throw new PartNotFound("R" + pkg + ":" + valueStr + ": " + pyFloatStr(valueOhm) +
          " ohm is not an exact E96 value");
      }
      return {
        kind: "R",
        id: "R" + pkg + ":" + valueStr,
        footprint: getResistorFootprints(catalog)[pkg],
        resistance_ohm: valueOhm,
        tolerance_pct: getResistorTolerance(catalog),
        source: "catalog/parts.json -> resistor_rule (E96, UNI-ROYAL 0603WAF/0805W8F)",
      };
    }
    if (partStr === IC_ALIAS) {
      if (catalog && catalog.ic) return catalog.ic;
      throw new PartNotFound(pyRepr(partStr) + " is not a catalog id and not a valid R0603:/R0805: value");
    }
    var inductors = (catalog && catalog.inductors) || [];
    for (var i = 0; i < inductors.length; i++) {
      if (inductors[i].id === partStr) return inductors[i];
    }
    var capacitors = (catalog && catalog.capacitors) || [];
    for (var j = 0; j < capacitors.length; j++) {
      if (capacitors[j].id === partStr) return capacitors[j];
    }
    throw new PartNotFound(pyRepr(partStr) + " is not a catalog id and not a valid R0603:/R0805: value");
  }

  // ------------------------------------------------------------------- geometry (common.py) --
  var ROT_CS = { 0: [1, 0], 90: [0, -1], 180: [-1, 0], 270: [0, 1] };

  function normRot(rot) {
    return ((rot % 360) + 360) % 360;
  }

  function rotateOffset(ox, oy, rot) {
    var cs = ROT_CS[normRot(rot)];
    var cc = cs[0], ss = cs[1];
    return [ox * cc + oy * ss, -ox * ss + oy * cc];
  }

  function courtyardHalf(fpGeo, rot) {
    var w = fpGeo.w, h = fpGeo.h;
    if (normRot(rot) % 180 === 90) {
      var t = w; w = h; h = t;
    }
    return [w / 2.0, h / 2.0];
  }

  function courtyardRect(part, fpGeo) {
    var x = part.pos[0], y = part.pos[1], rot = part.rot || 0;
    var bbox = fpGeo.bbox;
    var corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]];
    var xs = [], ys = [];
    for (var i = 0; i < corners.length; i++) {
      var d = rotateOffset(corners[i][0], corners[i][1], rot);
      xs.push(x + d[0]);
      ys.push(y + d[1]);
    }
    return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
  }

  function absPinPos(part, fpGeo) {
    var x = part.pos[0], y = part.pos[1], rot = part.rot || 0;
    var out = {};
    Object.keys(fpGeo.pads).forEach(function (pad) {
      var off = fpGeo.pads[pad];
      var d = rotateOffset(off[0], off[1], rot);
      out[pad] = [x + d[0], y + d[1]];
    });
    return out;
  }

  function rectsOverlap(a, b, minGap) {
    if (minGap === undefined) minGap = 0.2;
    return (a[0] < b[2] + minGap && b[0] < a[2] + minGap && a[1] < b[3] + minGap && b[1] < a[3] + minGap);
  }

  function dist2(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---------------------------------------------------------- static fallback MODULE/footprints
  var DEFAULT_MODULE = {
    id: MODULE_ID,
    board: 22.0,
    free_zone: [4.5, 1.0, 21.0, 21.0],
    bench_connector: {
      footprint: "Connector_PinHeader_2.54mm:PinHeader_1x05_P2.54mm_Vertical",
      pos: [2.0, 5.92],
      rot: 0,
      pins: { "1": "VIN", "2": "GND", "3": "EN", "4": "GND", "5": "VOUT" },
    },
    bench_nets: ["EN", "GND", "VIN", "VOUT"],
  };

  // ---------------------------------------------------------------------- roles (roles.py) --
  var IC_PIN_NODE = { "1": "N_GND", "2": "N_SW", "3": "N_VIN", "4": "N_FB", "5": "N_EN", "6": "N_BST" };
  var FIXED_NODE_NET = { N_GND: "GND", N_VIN: "VIN", N_EN: "EN" };
  var ROLE_SOURCE = "docs/IR.md §2";
  var REQUIRED_ROLES = ["cin", "cout", "cbst", "l", "r_top", "r_bot"];

  function roleKey(kind, netsArr) {
    var toks = sortedCopy(netsArr);
    return kind + "|" + toks.join(",");
  }

  var ROLE_TABLE = {};
  ROLE_TABLE[roleKey("C", ["N_VIN", "N_GND"])] = "cin";
  ROLE_TABLE[roleKey("C", ["VOUT", "N_GND"])] = "cout";
  ROLE_TABLE[roleKey("C", ["N_BST", "N_SW"])] = "cbst";
  ROLE_TABLE[roleKey("C", ["VOUT", "N_FB"])] = "cff";
  ROLE_TABLE[roleKey("L", ["N_SW", "VOUT"])] = "l";
  ROLE_TABLE[roleKey("R", ["VOUT", "N_FB"])] = "r_top";
  ROLE_TABLE[roleKey("R", ["N_FB", "N_GND"])] = "r_bot";
  ROLE_TABLE[roleKey("R", ["N_VIN", "N_EN"])] = "r_en_up";
  ROLE_TABLE[roleKey("R", ["N_EN", "N_GND"])] = "r_en_dn";

  function roleFinding(rule, severity, message, extra) {
    extra = Object.assign({ source: ROLE_SOURCE }, extra || {});
    return mkFinding(rule, "T0", severity, "model_error", message, extra);
  }

  function rolesCompute(parts) {
    var findings = [];
    var ics = parts.filter(function (p) { return p.catalog.kind === "IC"; });
    if (ics.length !== 1) {
      findings.push(roleFinding("T0.IC_COUNT", "error",
        "design must have exactly one IC_TPS563201, found " + ics.length,
        { value: ics.length, limit: 1 }));
      return { roles: {}, nodes: null, findings: findings };
    }
    var ic = ics[0];
    var pins = {};
    Object.keys(ic.pins).forEach(function (k) { pins[String(k)] = ic.pins[k]; });
    var missingPads = [];
    for (var n = 1; n <= 6; n++) {
      if (!(String(n) in pins)) missingPads.push(String(n));
    }
    if (missingPads.length) {
      findings.push(roleFinding("T0.IC_PINS", "error",
        ic.ref + ": missing pin(s) " + pyRepr(missingPads)));
      return { roles: {}, nodes: null, findings: findings };
    }
    var nodes = {};
    Object.keys(IC_PIN_NODE).forEach(function (pad) {
      nodes[IC_PIN_NODE[pad]] = pins[pad];
    });
    Object.keys(FIXED_NODE_NET).forEach(function (node) {
      var mustBe = FIXED_NODE_NET[node];
      if (nodes[node] !== mustBe) {
        var pad = Object.keys(IC_PIN_NODE).filter(function (p) { return IC_PIN_NODE[p] === node; })[0];
        findings.push(roleFinding("T0.IC_PINS", "error",
          ic.ref + " pin " + pad + " (" + node + ") must be net " + pyRepr(mustBe) +
          ", got " + pyRepr(nodes[node])));
      }
    });
    if (findings.some(function (f) { return f.rule === "T0.IC_PINS"; })) {
      return { roles: {}, nodes: nodes, findings: findings };
    }

    var alias = {};
    alias[nodes.N_GND] = "N_GND";
    alias[nodes.N_VIN] = "N_VIN";
    alias[nodes.N_EN] = "N_EN";
    alias[nodes.N_SW] = "N_SW";
    alias[nodes.N_FB] = "N_FB";
    alias[nodes.N_BST] = "N_BST";

    var roles = {};
    parts.forEach(function (p) {
      if (p === ic) return;
      var kind = p.catalog.kind;
      var pins2 = {};
      Object.keys(p.pins).forEach(function (k) { pins2[String(k)] = p.pins[k]; });
      var nets = Object.keys(pins2).map(function (k) { return pins2[k]; });
      if (nets.length !== 2) {
        findings.push(roleFinding("T0.UNKNOWN_ROLE", "error",
          p.ref + ": expected exactly 2 pins, got " + nets.length));
        return;
      }
      if (nets[0] === nets[1]) {
        findings.push(roleFinding("T0.SHORTED_PART", "error",
          p.ref + ": both pads are on net " + pyRepr(nets[0])));
        return;
      }
      var tokens = nets.map(function (n) { return (n in alias) ? alias[n] : n; });
      var role = ROLE_TABLE[roleKey(kind, tokens)];
      if (role === undefined) {
        findings.push(roleFinding("T0.UNKNOWN_ROLE", "error",
          p.ref + " (" + kind + ") connects nets " + pyRepr(sortedCopy(nets)) +
          ", which is not a role this bench recognises"));
        return;
      }
      if (!roles[role]) roles[role] = [];
      roles[role].push(p);
    });

    var netCount = {};
    parts.forEach(function (p) {
      Object.keys(p.pins).forEach(function (k) {
        var n = p.pins[k];
        netCount[n] = (netCount[n] || 0) + 1;
      });
    });
    var bench = { VIN: true, GND: true, EN: true, VOUT: true };
    Object.keys(netCount).forEach(function (n) {
      if (netCount[n] === 1 && !bench[n]) {
        findings.push(roleFinding("T0.DANGLING_NET", "error", "net " + pyRepr(n) + " has only one pin connected"));
      }
    });

    if (roles.l && roles.l.length > 1) {
      findings.push(roleFinding("T0.L_COUNT", "error",
        "exactly one inductor (role l) expected, found " + roles.l.length,
        { value: roles.l.length, limit: 1 }));
    }

    var missingRoles = REQUIRED_ROLES.filter(function (r) { return !roles[r]; });
    if (missingRoles.length) {
      findings.push(roleFinding("T0.ROLES", "error",
        "design is missing required role(s): " + pyRepr(missingRoles)));
    }

    return { roles: roles, nodes: nodes, findings: findings };
  }

  // -------------------------------------------------------------------- T0 geometry checks ---
  function resolveParts(ir, catalog) {
    var resolved = [];
    var findings = [];
    ir.parts.forEach(function (p) {
      var rec;
      try {
        rec = resolvePart(p.part, catalog);
      } catch (ex) {
        findings.push(mkFinding("T0.PART_KNOWN", "T0", "error", "model_error",
          p.ref + ": " + ex.message,
          { value: p.part, source: "docs/IR.md §1, catalog/parts.json" }));
        return;
      }
      resolved.push({ ref: p.ref, pins: p.pins, x: p.x, y: p.y, rot: p.rot, part: p.part, catalog: rec });
    });
    return { resolved: resolved, findings: findings };
  }

  function partBuild(p) {
    return { pos: [p.x, p.y], rot: p.rot, fp: p.catalog.footprint };
  }

  function checkZone(resolved, catalog, zone) {
    var errs = [];
    var x0 = zone[0], y0 = zone[1], x1 = zone[2], y1 = zone[3];
    resolved.forEach(function (p) {
      var fpGeo = catalog.footprints[p.catalog.footprint];
      if (!fpGeo) {
        errs.push(mkFinding("T0.ZONE", "T0", "error", "model_error",
          p.ref + ": cannot compute courtyard (no footprint geometry for " + p.catalog.footprint + ")"));
        return;
      }
      var r = courtyardRect(partBuild(p), fpGeo);
      if (r[0] < x0 - 1e-6 || r[1] < y0 - 1e-6 || r[2] > x1 + 1e-6 || r[3] > y1 + 1e-6) {
        var rr = r.map(function (v) { return round(v, 2); });
        errs.push(mkFinding("T0.ZONE", "T0", "error", "model_error",
          p.ref + ": courtyard " + pyTuple(rr) + " is outside the free zone " + pyTuple(zone),
          { value: rr, limit: zone, unit: "mm", source: "docs/IR.md §3 T0.ZONE" }));
      }
    });
    return errs;
  }

  function pyTuple(arr) {
    return "(" + arr.map(function (v) { return pyFloatStr(v); }).join(", ") + ")";
  }

  function checkOverlaps(resolved, catalog, minGap) {
    if (minGap === undefined) minGap = 0.2;
    var errs = [];
    var rects = [];
    resolved.forEach(function (p) {
      var fpGeo = catalog.footprints[p.catalog.footprint];
      if (!fpGeo) return;
      rects.push([p.ref, courtyardRect(partBuild(p), fpGeo)]);
    });
    var module = (catalog && catalog.module) || DEFAULT_MODULE;
    var benchFpGeo = catalog.footprints[module.bench_connector.footprint];
    if (benchFpGeo) {
      var benchRect = courtyardRect({ pos: module.bench_connector.pos, rot: module.bench_connector.rot }, benchFpGeo);
      rects.push(["J1", benchRect]);
    }
    for (var i = 0; i < rects.length; i++) {
      for (var j = i + 1; j < rects.length; j++) {
        var ra = rects[i][0], a = rects[i][1];
        var rb = rects[j][0], b = rects[j][1];
        if (rectsOverlap(a, b, minGap)) {
          errs.push(mkFinding("T0.OVERLAP", "T0", "error", "model_error",
            ra + " and " + rb + " overlap or are closer than " + pyNumStr(minGap) + " mm",
            { value: minGap, limit: minGap, unit: "mm", source: "docs/IR.md §3 T0.OVERLAP" }));
        }
      }
    }
    return errs;
  }

  function validateT0(ir, catalog) {
    var findings = validateSchema(ir);
    if (findings.some(function (f) { return f.severity === "error"; })) {
      return { findings: findings, roles: {}, nodes: null, resolved: [] };
    }
    var rp = resolveParts(ir, catalog);
    findings = findings.concat(rp.findings);
    var rc = rolesCompute(rp.resolved);
    findings = findings.concat(rc.findings);
    var zone = (catalog && catalog.module && catalog.module.free_zone) || DEFAULT_MODULE.free_zone;
    findings = findings.concat(checkZone(rp.resolved, catalog, zone));
    findings = findings.concat(checkOverlaps(rp.resolved, catalog));
    return { findings: findings, roles: rc.roles, nodes: rc.nodes, resolved: rp.resolved };
  }

  // -------------------------------------------------------------------------- T2 (validate.py)
  var IOUT_FULL_A = 1.0;
  var VIN_WORST_RIPPLE = 8.4;
  var VOUT_LO = 3.234, VOUT_HI = 3.366;
  var VIN_LO = 6.4;
  var BENCH_SOURCE = "правило стенда, docs/IR.md §4";

  function combineParallel(values) {
    var filtered = values.filter(function (v) { return !!v; });
    if (!filtered.length) return null;
    var sum = 0;
    for (var i = 0; i < filtered.length; i++) sum += 1.0 / filtered[i];
    return 1.0 / sum;
  }

  function combineSeriesTol(valsTols) {
    var nominal = combineParallel(valsTols.map(function (vt) { return vt[0]; }));
    var lo = combineParallel(valsTols.map(function (vt) { return vt[0] * (1 - vt[1] / 100.0); }));
    var hi = combineParallel(valsTols.map(function (vt) { return vt[0] * (1 + vt[1] / 100.0); }));
    return [nominal, lo, hi];
  }

  function sumOrNone(values) {
    for (var i = 0; i < values.length; i++) {
      if (values[i] === null || values[i] === undefined) return null;
    }
    var s = 0;
    for (var j = 0; j < values.length; j++) s += values[j];
    return s;
  }

  function voutFromDivider(rTop, rBot, vfb) {
    if (rBot <= 0) return 0.0;
    return vfb * (1 + rTop / rBot);
  }

  function fmtSource(src) {
    if (!src) return "None";
    var doc = src.doc;
    var page = src.page;
    var section = src.section || "";
    var pageStr = Array.isArray(page) ? page.map(pyStr).join(",") : pyStr(page);
    return pyStr(doc) + ", p." + pageStr + (section ? ", " + section : "");
  }

  function cEff(part, key) {
    var m = part.catalog.c_eff_uF;
    if (!m) return null;
    var v = m[key];
    return (v === undefined) ? null : v;
  }

  function validateT2(roles, nodes, resolved, catalog) {
    var icElec = catalog.ic.electrical;
    var findings = [];
    var metrics = {};

    function warn(rule, message, extra) { findings.push(mkFinding(rule, "T2", "warning", "model_error", message, extra)); }
    function err(rule, message, extra) { findings.push(mkFinding(rule, "T2", "error", "model_error", message, extra)); }
    function info(rule, message, extra) { findings.push(mkFinding(rule, "T2", "info", "model_error", message, extra)); }

    var rTopParts = (roles.r_top || []).map(function (p) { return [p.catalog.resistance_ohm, p.catalog.tolerance_pct]; });
    var rBotParts = (roles.r_bot || []).map(function (p) { return [p.catalog.resistance_ohm, p.catalog.tolerance_pct]; });
    var rTopT = combineSeriesTol(rTopParts), rBotT = combineSeriesTol(rBotParts);
    var rTop = rTopT[0], rTopLo = rTopT[1], rTopHi = rTopT[2];
    var rBot = rBotT[0], rBotLo = rBotT[1], rBotHi = rBotT[2];

    var vfbT = icElec.vfb_tolerance;
    var vfbNom = icElec.vfb_nominal_V.value;
    var voutNom = voutFromDivider(rTop, rBot, vfbNom);
    if (!(VOUT_LO <= voutNom && voutNom <= VOUT_HI)) {
      err("T2.VOUT_NOM", "Vout(nom) = " + fmtFixed(voutNom, 4) + " V outside " + VOUT_LO + "-" + VOUT_HI + " V",
        { value: round(voutNom, 4), limit: [VOUT_LO, VOUT_HI], unit: "V", source: fmtSource(icElec.vout_formula.source) });
    }

    var voutMin = vfbT.value_min_V * (1 + rTopLo / rBotHi);
    var voutMax = vfbT.value_max_V * (1 + rTopHi / rBotLo);
    if (voutMin < VOUT_LO || voutMax > VOUT_HI) {
      warn("T2.VOUT_WORST",
        "Vout(worst case) = [" + fmtFixed(voutMin, 4) + ", " + fmtFixed(voutMax, 4) + "] V outside " +
        VOUT_LO + "-" + VOUT_HI + " V (VFB " + pyNumStr(vfbT.value_min_V) + "-" + pyNumStr(vfbT.value_max_V) +
        " V, R +/-1%)",
        { value: [round(voutMin, 4), round(voutMax, 4)], limit: [VOUT_LO, VOUT_HI], unit: "V", source: fmtSource(vfbT.source) });
    }
    metrics.vout_nom = voutNom;
    metrics.vout_worst = [voutMin, voutMax];

    var lParts = roles.l || [];
    var dIL = null, ipk = null;
    if (lParts.length) {
      var lrec = lParts[0].catalog;
      var lUh = lrec.inductance_uH;
      var lrange = icElec.recommended_inductor_3v3_uH;
      var lsrc = pyStr(lrange.source.doc) + ", " + pyStr(lrange.source.section);
      if (!(lrange.value_min <= lUh && lUh <= lrange.value_max)) {
        err("T2.L_RANGE", "L = " + pyNumStr(lUh) + " uH outside recommended " +
          pyNumStr(lrange.value_min) + "-" + pyNumStr(lrange.value_max) + " uH",
          { value: lUh, limit: [lrange.value_min, lrange.value_max], unit: "uH", source: lsrc });
      }

      var fswRec = icElec.switching_frequency_kHz;
      var fswHz = fswRec.value * 1e3;
      var fswSrc = pyStr(fswRec.source.doc) + ", " + pyStr(fswRec.source.section) +
        " (typ. at " + pyStr(fswRec.condition) + " -- used here at VIN=" + pyNumStr(VIN_WORST_RIPPLE) + " V)";
      dIL = ((VIN_WORST_RIPPLE - voutNom) * voutNom) / (VIN_WORST_RIPPLE * lUh * 1e-6 * fswHz);
      var rippleLimit = 0.4 * IOUT_FULL_A;
      if (dIL > rippleLimit) {
        warn("T2.RIPPLE_I", "ripple dIL = " + fmtFixed(dIL, 3) + " A > 40% of 1.0 A at VIN=" +
          pyNumStr(VIN_WORST_RIPPLE) + " V",
          { value: round(dIL, 3), limit: rippleLimit, unit: "A", source: fswSrc });
      }

      ipk = IOUT_FULL_A + dIL / 2;
      var isat = (lrec.isat_A === undefined) ? null : lrec.isat_A;
      var isatSrc = lrec.source || null;
      var isatSrcStr = (isatSrc && (isatSrc.doc !== undefined || isatSrc.page !== undefined))
        ? (pyStr(isatSrc.doc) + ", p." + pyStr(isatSrc.page))
        : "catalog/parts.json";
      if (isat === null) {
        info("T2.ISAT", lParts[0].ref + ": no Isat in catalog, rule disabled: no source");
      } else if (isat < ipk) {
        err("T2.ISAT", "Isat " + pyNumStr(isat) + " A < peak current " + fmtFixed(ipk, 3) + " A",
          { value: isat, limit: round(ipk, 3), unit: "A", source: isatSrcStr });
      } else if (isat < 1.2 * ipk) {
        warn("T2.ISAT", "Isat " + pyNumStr(isat) + " A < 1.2 x peak current " + fmtFixed(ipk, 3) + " A",
          { value: isat, limit: round(1.2 * ipk, 3), unit: "A", source: isatSrcStr });
      }

      var irms = (lrec.irms_A === undefined) ? null : lrec.irms_A;
      var irmsSrc = isatSrcStr;
      if (irms === null) {
        info("T2.IRMS", lParts[0].ref + ": no Irms in catalog, rule disabled: no source");
      } else if (irms < IOUT_FULL_A) {
        err("T2.IRMS", "Irms " + pyNumStr(irms) + " A < 1.0 A",
          { value: irms, limit: IOUT_FULL_A, unit: "A", source: irmsSrc });
      } else if (irms < 1.2 * IOUT_FULL_A) {
        warn("T2.IRMS", "Irms " + pyNumStr(irms) + " A < 1.2 A",
          { value: irms, limit: 1.2, unit: "A", source: irmsSrc });
      }
    }
    metrics.ripple_A = dIL;
    metrics.ipk_A = ipk;

    var coutRec = icElec.recommended_output_cap_3v3_uF;
    var coutEff = sumOrNone((roles.cout || []).map(function (p) { return cEff(p, "3.3"); }));
    var coutSrc = pyStr(coutRec.source.doc) + ", " + pyStr(coutRec.source.section);
    if (coutEff === null) {
      err("T2.COUT_EFF", "cannot compute effective Cout at 3.3 V (missing dc_bias data)", { source: coutSrc });
    } else if (coutEff < coutRec.value_min_total) {
      err("T2.COUT_EFF", "Cout(eff@3.3V) = " + fmtFixed(coutEff, 2) + " uF < min " + pyNumStr(coutRec.value_min_total) + " uF",
        { value: round(coutEff, 2), limit: coutRec.value_min_total, unit: "uF", source: coutSrc });
    } else if (coutEff > coutRec.value_max_total) {
      warn("T2.COUT_EFF", "Cout(eff@3.3V) = " + fmtFixed(coutEff, 2) + " uF > max " + pyNumStr(coutRec.value_max_total) + " uF",
        { value: round(coutEff, 2), limit: coutRec.value_max_total, unit: "uF", source: coutSrc });
    }
    metrics.cout_eff_uF = coutEff;

    var cinRec = icElec.input_cap_recommendation;
    var cinEff = sumOrNone((roles.cin || []).map(function (p) { return cEff(p, "8.4"); }));
    var cinSrc = pyStr(cinRec.source.doc) + ", " + pyStr(cinRec.source.section);
    if (cinEff === null) {
      err("T2.CIN_EFF", "cannot compute effective Cin at 8.4 V (missing dc_bias data, or rated voltage exceeded)", { source: cinSrc });
    } else if (cinEff < cinRec.value_min_uF) {
      err("T2.CIN_EFF", "Cin(eff@8.4V) = " + fmtFixed(cinEff, 2) + " uF < min " + pyNumStr(cinRec.value_min_uF) + " uF",
        { value: round(cinEff, 2), limit: cinRec.value_min_uF, unit: "uF", source: cinSrc });
    }
    metrics.cin_eff_uF = cinEff;

    [["cin", 8.4], ["cout", 3.3]].forEach(function (pair) {
      var role = pair[0], vreq = pair[1];
      (roles[role] || []).forEach(function (p) {
        var rated = p.catalog.rated_voltage_V;
        if (rated < vreq) {
          err("T2.C_VRATING", p.ref + ": rated " + pyNumStr(rated) + " V < working " + pyNumStr(vreq) + " V",
            { value: rated, limit: vreq, unit: "V", source: "catalog/parts.json" });
        } else if (rated < 1.5 * vreq) {
          warn("T2.C_VRATING", p.ref + ": rated " + pyNumStr(rated) + " V < 1.5 x working " + pyNumStr(vreq) + " V",
            { value: rated, limit: round(1.5 * vreq, 2), unit: "V", source: BENCH_SOURCE });
        }
      });
    });

    var bstRec = icElec.bst_cap_recommendation_uF;
    var bstTotal = sumOrNone((roles.cbst || []).map(function (p) { return p.catalog.capacitance_nominal_uF; }));
    var bstSrc = pyStr(bstRec.source.doc) + ", " + pyStr(bstRec.source.section) +
      " (single recommended value " + pyNumStr(bstRec.value) +
      " uF; the +/-2x band around it is a bench margin, not a separate datasheet range -- see report)";
    if (bstTotal === null) {
      err("T2.CBST", "cannot compute total cbst capacitance", { source: bstSrc });
    } else if (!(0.5 * bstRec.value <= bstTotal && bstTotal <= 2.0 * bstRec.value)) {
      err("T2.CBST", "cbst total = " + pyNumStr(bstTotal) + " uF outside recommended range around " + pyNumStr(bstRec.value) + " uF",
        { value: bstTotal, limit: [0.5 * bstRec.value, 2.0 * bstRec.value], unit: "uF", source: bstSrc });
    }

    if (!(roles.r_en_up && roles.r_en_up.length) && !(roles.r_en_dn && roles.r_en_dn.length)) {
      warn("T2.EN_DEFINED", "EN has neither a pull-up nor a pull-down resistor: its state is undefined when the bench rig's EN pin is floating",
        { source: BENCH_SOURCE });
    } else if (roles.r_en_up && roles.r_en_up.length && roles.r_en_dn && roles.r_en_dn.length) {
      var up = combineParallel(roles.r_en_up.map(function (p) { return p.catalog.resistance_ohm; }));
      var dn = combineParallel(roles.r_en_dn.map(function (p) { return p.catalog.resistance_ohm; }));
      var venh = icElec.en_threshold_high_V;
      var vinOn = venh.value_min * (up + dn) / dn;
      var src = pyStr(venh.source.doc) + ", " + pyStr(venh.source.section);
      if (vinOn > VIN_LO) {
        err("T2.EN_UVLO", "EN divider turns the regulator on only above VIN=" + fmtFixed(vinOn, 3) +
          " V > " + pyNumStr(VIN_LO) + " V (will not start from a depleted battery)",
          { value: round(vinOn, 3), limit: VIN_LO, unit: "V", source: src });
      }
    }

    function bestPadDist(partEntry, targetNet, targetPinAbs, catalog) {
      var fpGeo = catalog.footprints[partEntry.catalog.footprint];
      var padsAbs = absPinPos(partBuild(partEntry), fpGeo);
      var pins2 = {};
      Object.keys(partEntry.pins).forEach(function (k) { pins2[String(k)] = partEntry.pins[k]; });
      var ds = [];
      Object.keys(pins2).forEach(function (pad) {
        if (pins2[pad] === targetNet) ds.push(dist2(padsAbs[pad], targetPinAbs));
      });
      if (!ds.length) return null;
      return Math.min.apply(null, ds);
    }

    var icRec = resolved.filter(function (p) { return p.catalog.kind === "IC"; });
    var loopIn = null, loopSw = null;
    if (icRec.length && roles.cin && roles.cin.length) {
      var icP = icRec[0];
      var icPins2 = {};
      Object.keys(icP.pins).forEach(function (k) { icPins2[String(k)] = icP.pins[k]; });
      var icFpGeo = catalog.footprints[icP.catalog.footprint];
      var icPinsAbs = absPinPos(partBuild(icP), icFpGeo);
      var vinNet = icPins2["3"], gndNet = icPins2["1"];
      var vinDists = roles.cin.map(function (p) { return bestPadDist(p, vinNet, icPinsAbs["3"], catalog); }).filter(function (d) { return d !== null; });
      var gndDists = roles.cin.map(function (p) { return bestPadDist(p, gndNet, icPinsAbs["1"], catalog); }).filter(function (d) { return d !== null; });
      if (vinDists.length && gndDists.length) {
        var bestVin = Math.min.apply(null, vinDists);
        var bestGnd = Math.min.apply(null, gndDists);
        loopIn = Math.max(bestVin, bestGnd);
        if (loopIn > 3.0) {
          warn("T2.LOOP_IN", "input cap loop " + fmtFixed(loopIn, 2) + " mm > 3 mm (VIN leg " +
            fmtFixed(bestVin, 2) + " mm, GND leg " + fmtFixed(bestGnd, 2) + " mm)",
            { value: round(loopIn, 2), limit: 3.0, unit: "mm", source: BENCH_SOURCE });
        }
      }
    }
    if (icRec.length && roles.l && roles.l.length) {
      var icP2 = icRec[0];
      var icPins3 = {};
      Object.keys(icP2.pins).forEach(function (k) { icPins3[String(k)] = icP2.pins[k]; });
      var icFpGeo2 = catalog.footprints[icP2.catalog.footprint];
      var swPin = absPinPos(partBuild(icP2), icFpGeo2)["2"];
      var swNet = icPins3["2"];
      var swDists = roles.l.map(function (p) { return bestPadDist(p, swNet, swPin, catalog); }).filter(function (d) { return d !== null; });
      if (swDists.length) {
        loopSw = Math.min.apply(null, swDists);
        if (loopSw > 4.0) {
          warn("T2.LOOP_SW", "SW-L loop " + fmtFixed(loopSw, 2) + " mm > 4 mm",
            { value: round(loopSw, 2), limit: 4.0, unit: "mm", source: BENCH_SOURCE });
        }
      }
    }
    metrics.loops_mm = { in: loopIn, sw: loopSw };

    return { findings: findings, metrics: metrics };
  }

  // ------------------------------------------------------------------------------- public API
  var T1_SKIPPED = mkFinding("T1.SKIPPED", "T1", "info", "model_error",
    "DRC/ERC run on the server after submission");

  function flattenRoles(roles) {
    var out = {};
    Object.keys(roles || {}).forEach(function (role) {
      roles[role].forEach(function (p) { out[p.ref] = role; });
    });
    return out;
  }

  var ProofboardChecker = {
    MODULE: DEFAULT_MODULE,
    footprints: {},

    setCatalog: function (catalog) {
      if (catalog && catalog.module) ProofboardChecker.MODULE = catalog.module;
      if (catalog && catalog.footprints) ProofboardChecker.footprints = catalog.footprints;
    },

    check: function (ir, catalog) {
      ProofboardChecker.setCatalog(catalog);
      var t0 = validateT0(ir, catalog);
      var findings = t0.findings.slice();
      var hasError = findings.some(function (f) { return f.severity === "error"; });
      if (hasError) {
        return {
          verdict: "fail",
          findings: findings,
          metrics: {},
          roles: flattenRoles(t0.roles),
        };
      }
      findings.push(T1_SKIPPED);
      var t2 = validateT2(t0.roles, t0.nodes, t0.resolved, catalog);
      findings = findings.concat(t2.findings);
      var verdict = findings.some(function (f) { return f.severity === "error"; }) ? "fail" : "pass";
      return {
        verdict: verdict,
        findings: findings,
        metrics: t2.metrics,
        roles: flattenRoles(t0.roles),
      };
    },

    // exposed for the agreement test / debugging; not part of the documented contract
    _internal: {
      validateSchema: validateSchema,
      resolvePart: resolvePart,
      rolesCompute: rolesCompute,
      courtyardRect: courtyardRect,
      PartNotFound: PartNotFound,
    },
  };

  if (typeof globalThis !== "undefined") {
    globalThis.ProofboardChecker = ProofboardChecker;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ProofboardChecker;
  }
})();
