/*
 * RABG: Add Beaten Badges to RetroAchievements — content script
 * ------------------------------------------------------------------
 * Reorganizes the "Game Awards" box on a RetroAchievements profile into
 * two labeled groups (Mastered / Beaten) and adds settings to the site
 * footer (under "Theme"):
 *
 *   Game Awards
 *   Mastered   👑 (hardcore mastered)   🎖 (softcore completed)
 *   ─────────── divider ───────────
 *   Beaten     silver-crown (hardcore)   🎖 (softcore)
 *
 * Footer settings: Beaten Sort (select), Beaten Size + Beaten Color
 * (sliders), Manual Order (toggle — own profile only), Export and Import.
 *
 * * Manual Order (own profile only): when enabled, the owner's beaten
 *   badges render in a personally arranged order. "Edit Badges" starts an
 *   edit mode: press-and-hold-drag to reorder (mouse + touch), ✕ hides a
 *   badge (hidden badges sit at the end, half-transparent, restorable via
 *   ＋), "Finish Editing" saves. New beaten games append at the end,
 *   visible. Data is per-profile: {order:[gameIds], hidden:[gameIds]}.
 *
 * Storage: all RABG settings live in the extension's storage.local
 * (shared with the popup and across tabs). Settings previously kept in
 * the page's localStorage are migrated automatically, once.
 *
 * - Mastered/Completed counters keep RA's own hover descriptions.
 * - Beaten counters show true hardcore/softcore totals from Progression
 *   Status; the hover notes "(N hidden)" = true total − badges shown.
 * - Creates a Game Awards box for profiles that have none.
 * - Games already mastered are excluded from Beaten.
 */
(function () {
  "use strict";

  /* ---------- constants ---------------------------------------------- */

  var crownUrls = { gold: "", silver: "" };
  var SORT_KEY = "ra-beaten-sort-v1";
  var SIZE_KEY = "rabg-beaten-size";    // "50"–"100" (% of full size)
  var COLOR_KEY = "rabg-beaten-color";  // "0"–"100" (% color; 0 = grayscale)
  var MANUAL_ENABLED_KEY = "rabg-manual-enabled"; // "1" / "0"
  var MANUAL_KEY_PREFIX = "rabg-manual-";         // + username → {order, hidden}
  var LEGACY_KEYS = [SORT_KEY, SIZE_KEY, COLOR_KEY];
  var GRID_CLASSES =
    "component w-full place-content-center bg-embed gap-2 grid " +
    "grid-cols-[repeat(auto-fill,minmax(52px,52px))] xl:rounded xl:py-2";
  var SORT_OPTIONS = [
    ["pct-desc", "Percentage (highest)"],
    ["pct-asc", "Percentage (lowest)"],
    ["title-asc", "Game Title (A-Z)"],
    ["title-desc", "Game Title (Z-A)"]
  ];
  var HOLD_MS = 150; // press-and-hold time before a badge can be dragged

  /* ---------- storage layer (extension storage.local, with fallback) -- */

  var STORE = {};          // in-memory mirror of all RABG settings
  var usingExtStorage = false;

  function getStorageApi() {
    if (typeof browser !== "undefined" && browser.storage && browser.storage.local) return browser.storage;
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) return chrome.storage;
    return null;
  }

  function storageGetAll(area, cb) {
    var done = false;
    function finish(items) { if (!done) { done = true; cb(items || {}); } }
    try {
      var p = area.get(null);
      if (p && typeof p.then === "function") { p.then(finish, function () { finish({}); }); return; }
    } catch (e) { /* callback-style API — try below */ }
    try { area.get(null, function (items) { finish(items); }); }
    catch (e) { finish({}); }
  }

  function storageSetItems(area, obj) {
    try {
      var p = area.set(obj);
      if (p && typeof p.catch === "function") {
        p.catch(function (err) { console.info("[RABG] storage write failed:", err); });
      }
    } catch (e) { console.info("[RABG] storage write failed:", e); }
  }

  function persistStore() {
    if (usingExtStorage) {
      storageSetItems(getStorageApi().local, STORE);
    } else {
      try { localStorage.setItem("rabg-store", JSON.stringify(STORE)); } catch (e) {}
    }
  }

  function storeSet(key, value) {
    STORE[key] = value;
    if (usingExtStorage) {
      var obj = {};
      obj[key] = value;
      storageSetItems(getStorageApi().local, obj);
    } else {
      persistStore();
    }
  }

  // One-time migration: settings that used to live in the page's
  // localStorage are copied into extension storage on first run.
  function migrateLegacy() {
    var changed = false;
    for (var i = 0; i < LEGACY_KEYS.length; i++) {
      var k = LEGACY_KEYS[i];
      if (STORE[k] === undefined) {
        try {
          var v = localStorage.getItem(k);
          if (v !== null) { STORE[k] = v; changed = true; }
        } catch (e) {}
      }
    }
    if (changed) persistStore();
  }

  function loadAllPrefs(after) {
    var storage = getStorageApi();
    if (storage && storage.local) {
      usingExtStorage = true;
      var fired = false;
      var go = function (items) {
        if (fired) return;
        fired = true;
        STORE = items || {};
        migrateLegacy();
        after();
      };
      storageGetAll(storage.local, go);
      setTimeout(function () { go(STORE); }, 2000); // safety net
    } else {
      // Fallback (no storage API): keep using the page's localStorage.
      usingExtStorage = false;
      try {
        var raw = localStorage.getItem("rabg-store");
        STORE = raw ? JSON.parse(raw) : {};
      } catch (e) { STORE = {}; }
      migrateLegacy();
      after();
    }
  }

  // Keeps other tabs (and, later, the popup) in sync.
  function startStorageListener() {
    var storage = getStorageApi();
    if (!storage || !storage.onChanged || !storage.onChanged.addListener) return;
    storage.onChanged.addListener(function (changes, area) {
      if (area && area !== "local") return;
      var structural = false;
      for (var key in changes) {
        STORE[key] = changes[key].newValue;
        if (key === SORT_KEY || key === MANUAL_ENABLED_KEY ||
            key.indexOf(MANUAL_KEY_PREFIX) === 0) structural = true;
      }
      // Turning Manual Order off (from the popup or another tab) must also
      // exit an in-progress edit mode on this page.
      if (changes[MANUAL_ENABLED_KEY] && changes[MANUAL_ENABLED_KEY].newValue !== "1") {
        cancelEditModeIfActive();
      }
      applyBeatenStyles();
      syncFooterControls(); // keep footer widgets (select/sliders/switch) in sync
      if (structural) refreshBeatenSection();
    });
  }

  /* ---------- preference accessors (read from STORE) ------------------ */

  function getSortPref() {
    var v = STORE[SORT_KEY];
    for (var i = 0; i < SORT_OPTIONS.length; i++) if (SORT_OPTIONS[i][0] === v) return v;
    return "pct-desc";
  }
  function setSortPref(v) { storeSet(SORT_KEY, v); }

  function getRangePref(key, def, min, max) {
    var v = parseInt(STORE[key], 10);
    if (!isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
  }
  function setRangePref(key, v) { storeSet(key, String(v)); }
  function getBeatenSize() { return getRangePref(SIZE_KEY, 100, 50, 100); }
  function getBeatenColor() { return getRangePref(COLOR_KEY, 100, 0, 100); }

  function isManualEnabled() { return STORE[MANUAL_ENABLED_KEY] === "1"; }
  function setManualEnabled(on) { storeSet(MANUAL_ENABLED_KEY, on ? "1" : "0"); }

  function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function getManualData(username) {
    var v = STORE[MANUAL_KEY_PREFIX + username];
    if (!v) return null;
    var d = (typeof v === "string") ? safeParse(v) : v;
    if (!d || typeof d !== "object" || !d.order || !d.hidden) return null;
    return d;
  }
  function setManualData(username, data) { storeSet(MANUAL_KEY_PREFIX + username, data); }

  // Applies the saved size/grayscale to all beaten tiles via CSS variables.
  function applyBeatenStyles() {
    var size = getBeatenSize() / 100;
    var gray = (100 - getBeatenColor()) / 100;
    var root = document.documentElement;
    root.style.setProperty("--rabg-size", String(size));
    root.style.setProperty("--rabg-gray", String(gray));
  }

  /* ---------- generic helpers ----------------------------------------- */

  function runtime() {
    if (typeof browser !== "undefined" && browser.runtime) return browser.runtime;
    if (typeof chrome !== "undefined" && chrome.runtime) return chrome.runtime;
    return null;
  }

  // The profile being viewed: /user/<name> → <name>
  function getUsername() {
    var parts = location.pathname.split("/").filter(Boolean);
    var name = parts[0] === "user" && parts[1] ? parts[1] : "";
    try { return decodeURIComponent(name); } catch (e) { return name; }
  }

  // The logged-in user, from the navbar account dropdown (absent when
  // logged out): <div class="dropdown nav-item"><a class="nav-link"
  // href="…/user/<name>"> — the only nav-link pointing at a /user/ URL.
  function getViewerUsername() {
    var links = document.querySelectorAll("div.dropdown a.nav-link[href*='/user/']");
    for (var i = 0; i < links.length; i++) {
      var m = (links[i].getAttribute("href") || "").match(/\/user\/([^\/?#]+)/);
      if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    }
    return "";
  }

  function completionOf(row) {
    var pb = row.querySelector('[role="progressbar"]');
    if (pb) {
      var now = parseFloat(pb.getAttribute("aria-valuenow"));
      var max = parseFloat(pb.getAttribute("aria-valuemax"));
      if (isFinite(now) && isFinite(max) && max > 0) return now / max;
    }
    var titled = row.querySelector('[title*="Progress:"]');
    if (titled) {
      var m = titled.getAttribute("title").match(/Progress:\s*([\d.]+)\s*\/\s*([\d.]+)/);
      if (m) { var n = parseFloat(m[1]), d = parseFloat(m[2]); if (d > 0) return n / d; }
    }
    var txt = row.textContent.match(/([\d.]+)\s*of\s*([\d.]+)/);
    if (txt) { var nn = parseFloat(txt[1]), dd = parseFloat(txt[2]); if (dd > 0) return nn / dd; }
    return 0;
  }

  /* ---------- RA page data -------------------------------------------- */

  function readMasteryCounts(awards) {
    var hc = 0, sc = 0, hcTitle = "", scTitle = "";
    var nodes = awards.querySelectorAll("h3 .cursor-help, h3 div[title]");
    for (var i = 0; i < nodes.length; i++) {
      var div = nodes[i];
      var rawTitle = div.getAttribute("title") || "";
      var title = rawTitle.toLowerCase();
      var numEl = div.querySelector(".numitems");
      var num = numEl ? (parseInt(numEl.textContent, 10) || 0) : 0;
      if (title.indexOf("mastered") !== -1 && num) { hc = num; hcTitle = rawTitle; }
      else if (title.indexOf("completed") !== -1 && num) { sc = num; scTitle = rawTitle; }
    }
    var grid = awards.querySelector(".grid");
    if (grid) {
      if (!hc) { hc = grid.querySelectorAll("img.goldimage").length; hcTitle = hc + " games mastered"; }
      if (!sc) { sc = grid.querySelectorAll("img.siteawards").length; scTitle = sc + " games completed"; }
    }
    return { hc: hc, sc: sc, hcTitle: hcTitle, scTitle: scTitle };
  }

  // TRUE beaten totals (hardcore + softcore) from the Progression Status
  // "Total" row. Filled dot (bg-) = hardcore; hollow dot = softcore.
  function getBeatenTotals() {
    var rows = document.querySelectorAll(".progression-status-row");
    for (var i = 0; i < rows.length; i++) {
      var label = rows[i].querySelector("p");
      if (label && /total/i.test(label.textContent)) {
        var cell = rows[i].querySelector('a[href*="any-beaten"]');
        if (!cell) return null;
        var tallies = cell.querySelectorAll(".tally");
        if (!tallies.length) return null;
        var hc = 0, sc = 0;
        for (var j = 0; j < tallies.length; j++) {
          var n = parseInt(tallies[j].textContent.replace(/[^0-9]/g, ""), 10) || 0;
          var dot = tallies[j].querySelector(".dot");
          if (dot && dot.className.indexOf("bg-") !== -1) hc += n;
          else sc += n;
        }
        return { hc: hc, sc: sc };
      }
    }
    return null;
  }

  // Game IDs already mastered/completed in the grid — excluded from Beaten.
  function computeMasteredIds(awards) {
    var ids = Object.create(null);
    var tiles = awards.querySelectorAll("[data-gameid]");
    for (var k = 0; k < tiles.length; k++) {
      if (tiles[k].getAttribute("data-beaten") !== "true") {
        ids[tiles[k].getAttribute("data-gameid")] = true;
      }
    }
    return ids;
  }

  // Beaten games (hardcore + softcore) from the "hide completed games" view,
  // sorted by completion % (highest first), de-duplicated by game ID.
  function getBeatenGames(excludeIds) {
    var scope =
      document.querySelector("#completion-progress-incomplete") ||
      document.querySelector("#completion-progress-all") ||
      document.querySelector("#usercompletedgamescomponent") ||
      document;
    var rows = scope.querySelectorAll("tr");
    var map = Object.create(null);
    var list = [];

    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var awardEl = tr.querySelector("[data-award]");
      if (!awardEl) continue;
      var award = awardEl.getAttribute("data-award");
      var type = null;
      if (award === "beaten-hardcore") type = "hc";
      else if (award === "beaten-softcore") type = "sc";
      else if (award === "beaten") type = "hc";
      else continue;

      var link = tr.querySelector('a[href*="/game/"]');
      var img = tr.querySelector("img");
      if (!link || !img) continue;

      var m = link.getAttribute("href").match(/\/game\/(\d+)/);
      if (!m) continue;

      var gameId = m[1];
      if (excludeIds && excludeIds[gameId]) continue;

      var pct = completionOf(tr);
      if (map[gameId]) {
        if (pct > map[gameId].pct) map[gameId].pct = pct;
        continue;
      }
      var title = (img.getAttribute("alt") || "").replace(/\s*game badge\s*$/i, "").trim();
      map[gameId] = { gameId: gameId, imgSrc: img.getAttribute("src"), pct: pct, type: type, title: title };
      list.push(map[gameId]);
    }

    list.sort(function (a, b) { return b.pct - a.pct; });
    return list;
  }

  /* ---------- manual ordering ----------------------------------------- */

  function manualIsActive(username, viewer) {
    return !!(viewer && username && viewer === username && isManualEnabled());
  }

  // Splits beaten games per manual data: `visible` in the saved order (with
  // unreferenced "new" games appended at the end, visible) and `hiddenGames`.
  // Stale IDs (e.g. games mastered later) simply drop out.
  function applyManualOrder(beaten, manual) {
    var byId = {};
    beaten.forEach(function (g) { byId[g.gameId] = g; });
    var seen = {};
    var visible = [], hiddenGames = [];
    var order = (manual && manual.order) || [];
    var hidden = (manual && manual.hidden) || [];

    order.forEach(function (id) {
      if (seen[id] || !byId[id]) return;
      seen[id] = true;
      if (hidden.indexOf(id) !== -1) hiddenGames.push(byId[id]);
      else visible.push(byId[id]);
    });
    hidden.forEach(function (id) {
      if (seen[id] || !byId[id]) return;
      seen[id] = true;
      hiddenGames.push(byId[id]);
    });
    beaten.forEach(function (g) {           // new games → end, visible
      if (!seen[g.gameId]) visible.push(g);
    });
    return { visible: visible, hiddenGames: hiddenGames };
  }

  /* ---------- DOM builders -------------------------------------------- */

  function crownImg(which) {
    var img = document.createElement("img");
    img.className = "ra-crown-icon";
    img.src = crownUrls[which];
    img.alt = "";
    return img;
  }

  function makeCrownCounter(which, count, title) {
    var c = document.createElement("span");
    c.className = "ra-counter";
    c.setAttribute("title", title);
    var ic = document.createElement("span");
    ic.className = "ra-counter-icon";
    ic.appendChild(crownImg(which));
    var num = document.createElement("span");
    num.className = "numitems";
    num.textContent = String(count);
    c.appendChild(ic);
    c.appendChild(num);
    return c;
  }

  function makeMedalCounter(count, title) {
    var c = document.createElement("span");
    c.className = "ra-counter";
    c.setAttribute("title", title);
    var medal = document.createElement("span");
    medal.className = "ra-medal";
    medal.textContent = "🎖";
    var num = document.createElement("span");
    num.className = "numitems";
    num.textContent = String(count);
    c.appendChild(medal);
    c.appendChild(num);
    return c;
  }

  function makeBeatenTile(game, username) {
    var wrap = document.createElement("div");
    wrap.className = "ra-tile";
    wrap.setAttribute("data-gameid", game.gameId);
    wrap.setAttribute("data-beaten", "true");
    wrap.setAttribute("data-pct", game.pct.toFixed(4));
    wrap.setAttribute("data-tier", game.type);
    wrap.setAttribute("data-title", game.title || "");

    var span = document.createElement("span");
    span.className = "inline";
    span.setAttribute(
      "x-data",
      "tooltipComponent($el, { dynamicType: 'game', dynamicId: '" + game.gameId + "'" +
        (username ? ", dynamicContext: '" + username + "'" : "") + " })"
    );
    span.setAttribute("x-on:mouseover", "showTooltip($event)");
    span.setAttribute("x-on:mouseleave", "hideTooltip");
    span.setAttribute("x-on:mousemove", "trackMouseMovement($event)");

    var a = document.createElement("a");
    a.className = "inline-block";
    a.href = "https://retroachievements.org/game/" + game.gameId;

    var img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.width = 48;
    img.height = 48;
    img.src = game.imgSrc;
    img.alt = "";
    img.className = game.type === "hc" ? "silverimage" : "plainimage";

    a.appendChild(img);
    span.appendChild(a);
    wrap.appendChild(span);
    return wrap;
  }

  function buildGroupLabel(text, first) {
    var d = document.createElement("div");
    d.className = "ra-grouplabel" + (first ? " ra-grouplabel-first" : "");
    var lbl = document.createElement("span");
    lbl.className = "ra-lbl";
    lbl.textContent = text;
    d.appendChild(lbl);
    return d;
  }

  function buildTitle() {
    var h3 = document.createElement("h3");
    h3.className = "flex justify-between gap-2";
    var span = document.createElement("span");
    span.className = "grow";
    span.textContent = "Game Awards";
    h3.appendChild(span);
    return h3;
  }

  function sortBeatenTiles(grid, key) {
    var tiles = Array.prototype.slice.call(grid.children);
    tiles.sort(function (a, b) {
      var pa = parseFloat(a.getAttribute("data-pct")) || 0;
      var pb = parseFloat(b.getAttribute("data-pct")) || 0;
      var ta = a.getAttribute("data-title") || "";
      var tb = b.getAttribute("data-title") || "";
      if (key === "pct-asc") return pa - pb;
      if (key === "title-asc") return ta.localeCompare(tb);
      if (key === "title-desc") return tb.localeCompare(ta);
      return pb - pa; // pct-desc
    });
    tiles.forEach(function (t) { grid.appendChild(t); });
  }

  /* ---------- footer settings (sort / size / color / manual) ---------- */

  function buildFooterRow(extraClass) {
    var row = document.createElement("div");
    row.className = "flex mb-3 items-center" + (extraClass ? " " + extraClass : "");
    var label = document.createElement("div");
    var controls = document.createElement("div");
    // items-center (NOT "align-center", which has no CSS anywhere) so every
    // control — buttons, sliders, and the import hint text — lines up.
    controls.className = "flex items-center ml-2 gap-2";
    row.appendChild(label);
    row.appendChild(controls);
    return { row: row, label: label, controls: controls };
  }

  // Keeps the custom-drawn slider fill (the Chromium track gradient) in
  // sync with the input's value.
  function syncRangeFill(input) {
    if (!input) return;
    var min = parseFloat(input.min), max = parseFloat(input.max);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 100;
    var pct = max > min ? ((parseFloat(input.value) - min) / (max - min)) * 100 : 0;
    if (!isFinite(pct)) pct = 0;
    input.style.setProperty("--ra-fill", Math.max(0, Math.min(100, pct)) + "%");
  }

  function buildRangeRow(rowClass, labelText, srText, min, max, step, value, onInput) {
    var r = buildFooterRow(rowClass);
    r.label.textContent = labelText;
    var sr = document.createElement("label");
    sr.className = "sr-only";
    sr.textContent = srText;
    var range = document.createElement("input");
    range.type = "range";
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.className = "ra-range";
    var val = document.createElement("span");
    val.className = "ra-range-value";
    val.textContent = value + "%";
    range.addEventListener("input", function () { syncRangeFill(range); });
    syncRangeFill(range); // paint the correct fill before first display
    range.addEventListener("input", function () {
      val.textContent = range.value + "%";
      onInput(parseInt(range.value, 10) || min);
    });
    r.controls.appendChild(sr);
    r.controls.appendChild(range);
    r.controls.appendChild(val);
    return r.row;
  }

  function buildSwitchRow(rowClass, labelText, srText, checked, onToggle) {
    var r = buildFooterRow(rowClass);
    r.label.textContent = labelText;
    r.row.title = "Arrange and hide beaten badges on your own profile";
    var sr = document.createElement("label");
    sr.className = "sr-only";
    sr.textContent = srText;
    var wrap = document.createElement("label");
    wrap.className = "ra-switch";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    var slider = document.createElement("span");
    slider.className = "ra-switch-slider";
    wrap.appendChild(input);
    wrap.appendChild(slider);
    input.addEventListener("change", function () { onToggle(input.checked); });
    r.controls.appendChild(sr);
    r.controls.appendChild(wrap);
    return r;
  }

  /* ---------- settings backup (export / import) ------------------------ */

  function knownSettingsKey(k) {
    if (LEGACY_KEYS.indexOf(k) !== -1) return true;
    return k.indexOf("rabg-") === 0 && k !== "rabg-store" && k !== "rabg-site-theme";
  }

  function buildExportPayload() {
    var payload = {};
    for (var k in STORE) if (knownSettingsKey(k)) payload[k] = STORE[k];
    return payload;
  }

  function doExport() {
    try {
      var json = JSON.stringify(buildExportPayload(), null, 2);
      var d = new Date();
      var stamp = d.getFullYear() + "-" +
        ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "rabg-settings-" + stamp + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      console.info("[RABG] Export failed: " + e);
    }
  }

  function doImport(file) {
    try {
      var reader = new FileReader();
      reader.onload = function () {
        var data = safeParse(String(reader.result));
        if (!data || typeof data !== "object") return;
        var count = 0;
        for (var k in data) {
          if (knownSettingsKey(k)) { storeSet(k, data[k]); count++; }
        }
        if (!count) return;
        applyBeatenStyles();
        syncFooterControls();
        refreshBeatenSection();
      };
      reader.readAsText(file);
    } catch (e) {
      console.info("[RABG] Import failed: " + e);
    }
  }

  // Used when Import is triggered from the popup: browsers only allow the
  // file picker from a real in-page click, so we scroll to the footer's
  // Import button, pulse it, and hint at it — one familiar click there runs
  // the proven footer-import flow.
  function highlightFooterImport() {
    var btn = document.querySelector(".ra-footer-import-btn");
    if (!btn) return;
    try { btn.scrollIntoView({ behavior: "smooth", block: "center" }); }
    catch (e) { try { btn.scrollIntoView(); } catch (e2) {} }
    var oldHint = document.querySelector(".ra-import-hint-text");
    if (oldHint && oldHint.parentNode) oldHint.parentNode.removeChild(oldHint);
    var hint = document.createElement("span");
    hint.className = "ra-import-hint-text";
    hint.textContent = "← Click here to import";
    // Insert AFTER the Import button (btn.nextSibling is the hidden file
    // input), so the row reads: [Export] [Import] ← Click here to import.
    btn.parentNode.insertBefore(hint, btn.nextSibling);
    btn.classList.add("ra-import-hint");
    var clear = function () {
      btn.classList.remove("ra-import-hint");
      if (hint.parentNode) hint.parentNode.removeChild(hint);
    };
    btn.addEventListener("click", clear, { once: true });
    setTimeout(clear, 15000);
  }

  /* ---------- footer sync helpers -------------------------------------- */

  // Manages the two edit buttons:
  //  - "Edit Badges" in the footer, next to the Manual Order switch (hidden
  //    while an edit is in progress).
  //  - "Finish Editing" next to the Beaten counters (only while editing).
  // Both appear only on the viewer's own profile with manual order on.
  function setSlotButton(slot, show, label) {
    if (!slot) return;
    var btn = slot.querySelector(".ra-edit-btn");
    if (!show) {
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      return;
    }
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-base btn-base--default btn-base--size-sm ra-edit-btn";
      btn.addEventListener("click", toggleEditMode);
      slot.appendChild(btn);
    }
    btn.textContent = label;
  }

  function updateFooterEditButton() {
    var row = document.querySelector(".ra-footer-manual");
    var fslot = row ? row.querySelector(".ra-edit-slot") : null;
    var bLabel = document.querySelector("#gameawards .ra-beaten-section .ra-grouplabel");
    var ctx = buildContext();
    var editing = !!document.querySelector(".ra-beaten-grid.ra-editing");
    var active = ctx.manualActive && !!bLabel;

    // Footer: "Edit Badges" is ALWAYS visible next to the switch, but it'll be
    // disabled unless this is the viewer's own profile with Manual Order on.
    if (fslot) {
      var btn = fslot.querySelector(".ra-edit-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-base btn-base--default btn-base--size-sm ra-edit-btn";
        btn.addEventListener("click", toggleEditMode);
        fslot.appendChild(btn);
      }
      btn.disabled = !active;
      btn.textContent = editing ? "Finish Editing" : "Edit Badges";
    }

    // Beaten section: "Finish Editing" (only while editing).
    var sslot = null;
    if (bLabel) {
      sslot = bLabel.querySelector(".ra-edit-slot");
      if (active && editing && !sslot) {
        sslot = document.createElement("span");
        sslot.className = "ra-edit-slot";
        bLabel.appendChild(sslot);
      }
    }
    setSlotButton(sslot, active && editing, "Finish Editing");
  }

  // Re-syncs the footer widgets with STORE (after import / storage changes).
  function syncFooterControls() {
    var sel = document.querySelector(".ra-footer-sort-select");
    if (sel) sel.value = getSortPref();
    var size = document.querySelector(".ra-footer-size .ra-range");
    if (size) {
      size.value = String(getBeatenSize());
      syncRangeFill(size);
      var lbl = size.parentNode.querySelector(".ra-range-value");
      if (lbl) lbl.textContent = getBeatenSize() + "%";
    }
    var color = document.querySelector(".ra-footer-color .ra-range");
    if (color) {
      color.value = String(getBeatenColor());
      syncRangeFill(color);
      var lbl2 = color.parentNode.querySelector(".ra-range-value");
      if (lbl2) lbl2.textContent = getBeatenColor() + "%";
    }
    var sw = document.querySelector(".ra-footer-manual .ra-switch input");
    if (sw) sw.checked = isManualEnabled();
    updateFooterEditButton();
  }

  // Exits an in-progress edit mode without saving (e.g. Manual Order off).
  function cancelEditModeIfActive() {
    var grid = document.querySelector(".ra-beaten-grid.ra-editing");
    if (grid) grid.classList.remove("ra-editing");
  }

  // RA's footer is absolutely positioned with a FIXED height (320/350px via
  // --footer-height-md/lg) and the body reserves exactly that much space.
  // Our added settings rows make the footer content taller, which would
  // overflow onto the lighter page background. This re-measures the footer
  // and syncs its height and the body's bottom padding.
  function fixFooterHeight() {
    var footer = document.querySelector("footer");
    if (!footer || !document.body) return;
    if (!footer.querySelector(".ra-footer-sort")) return; // nothing injected
    var cs = getComputedStyle(document.documentElement);
    var md = parseInt(cs.getPropertyValue("--footer-height-md"), 10) || 320;
    var lg = parseInt(cs.getPropertyValue("--footer-height-lg"), 10) || 350;
    var min = window.innerWidth >= 1024 ? lg : md;
    footer.style.boxSizing = "border-box";
    footer.style.height = "auto";
    var h = Math.max(footer.offsetHeight, min);
    footer.style.height = h + "px";
    document.body.style.paddingBottom = h + "px";
  }

  function injectFooterSettings() {
    if (document.querySelector(".ra-footer-sort")) return;
    var themeSelect = document.querySelector("[data-choose-theme]");
    if (!themeSelect) return;
    var themeRow = themeSelect.closest(".flex.mb-3.items-center") ||
                   themeSelect.closest(".flex.items-center");
    if (!themeRow || !themeRow.parentNode) return;

    // --- Beaten Sort row ---
    var sortRow = buildFooterRow("ra-footer-sort");
    sortRow.label.textContent = "Beaten Sort";
    var sr = document.createElement("label");
    sr.className = "sr-only";
    sr.textContent = "Beaten sort order";
    var sel = document.createElement("select");
    sel.className = "ra-footer-sort-select";
    SORT_OPTIONS.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0];
      op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.value = getSortPref();
    sel.addEventListener("change", function () {
      setSortPref(sel.value);
      var ctx = buildContext();
      if (ctx.manualActive) return; // manual order governs own profile
      var grid = document.querySelector("#gameawards .ra-beaten-section .ra-beaten-grid");
      if (grid && !grid.classList.contains("ra-editing")) sortBeatenTiles(grid, sel.value);
    });
    sortRow.controls.appendChild(sr);
    sortRow.controls.appendChild(sel);

    // --- Beaten Size row (50% – 100% of full size) ---
    var sizeRow = buildRangeRow("ra-footer-size", "Beaten Size", "Beaten badge size", 50, 100, 5,
      getBeatenSize(),
      function (v) { setRangePref(SIZE_KEY, v); applyBeatenStyles(); });

    // --- Beaten Color row (0 = full grayscale, 100 = full color) ---
    var colorRow = buildRangeRow("ra-footer-color", "Beaten Color", "Beaten badge color", 0, 100, 5,
      getBeatenColor(),
      function (v) { setRangePref(COLOR_KEY, v); applyBeatenStyles(); });

    // --- Manual Order row (own profile; only while logged in) ---
    var manualRow = null;
    if (getViewerUsername()) {
      manualRow = buildSwitchRow("ra-footer-manual", "Manual Order",
        "Manual order for your own profile",
        isManualEnabled(),
        function (on) {
          cancelEditModeIfActive(); // toggling off discards an edit in progress
          setManualEnabled(on);
          refreshBeatenSection();
        });
      // "Edit Badges" lives here, next to the switch. It is shown only when
      // the current page is the viewer's own profile with manual order on
      // (kept in sync by updateFooterEditButton).
      var slot = document.createElement("span");
      slot.className = "ra-edit-slot";
      manualRow.controls.appendChild(slot);
    }

    // --- Backup row (Export / Import settings as JSON) ---
    var backupRow = buildFooterRow("ra-footer-backup");
    backupRow.label.textContent = "Backup";
    var expBtn = document.createElement("button");
    expBtn.type = "button";
    expBtn.className = "btn-base btn-base--default btn-base--size-sm ra-footer-export-btn";
    expBtn.textContent = "Export";
    expBtn.title = "Download your RABG settings as a JSON file";
    expBtn.addEventListener("click", doExport);
    var impBtn = document.createElement("button");
    impBtn.type = "button";
    impBtn.className = "btn-base btn-base--default btn-base--size-sm ra-footer-import-btn";
    impBtn.textContent = "Import";
    impBtn.title = "Load RABG settings from a JSON file";
    impBtn.addEventListener("click", function () {
      var input = document.querySelector(".ra-import-input");
      if (input) { input.value = ""; input.click(); }
    });
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.className = "ra-import-input";
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) doImport(fileInput.files[0]);
    });
    backupRow.controls.appendChild(expBtn);
    backupRow.controls.appendChild(impBtn);
    backupRow.controls.appendChild(fileInput);

    // Insert right after the theme row (i.e. above the copyright row).
    var parent = themeRow.parentNode;
    parent.insertBefore(sortRow.row, themeRow.nextSibling);
    parent.insertBefore(sizeRow, sortRow.row.nextSibling);
    parent.insertBefore(colorRow, sizeRow.nextSibling);
    if (manualRow) parent.insertBefore(manualRow.row, colorRow.nextSibling);
    parent.insertBefore(backupRow.row,
      manualRow ? manualRow.row.nextSibling : colorRow.nextSibling);

    fixFooterHeight();
    if (!resizeBound) {
      resizeBound = true;
      window.addEventListener("resize", fixFooterHeight);
    }
  }
  var resizeBound = false;

  /* ---------- edit mode (drag to reorder, hide/restore) --------------- */

  var dragState = null;   // active press-and-hold gesture
  var scrollBlocker = null;

  function blockScroll(on) {
    if (on && !scrollBlocker) {
      scrollBlocker = function (ev) { ev.preventDefault(); };
      document.addEventListener("touchmove", scrollBlocker, { passive: false });
    } else if (!on && scrollBlocker) {
      document.removeEventListener("touchmove", scrollBlocker);
      scrollBlocker = null;
    }
  }

  function positionGhostAt(x, y) {
    if (!dragState || !dragState.ghost) return;
    var w = (dragState.ghost.offsetWidth / 2) || 24;
    var h = (dragState.ghost.offsetHeight / 2) || 24;
    dragState.ghost.style.left = (x - w) + "px";
    dragState.ghost.style.top = (y - h) + "px";
  }

  function startDrag() {
    if (!dragState) return;
    dragState.active = true;
    var tile = dragState.tile, grid = dragState.grid;
    var ghost = tile.cloneNode(true);
    ghost.classList.add("ra-ghost");
    try { ghost.style.width = tile.offsetWidth + "px"; } catch (e) {}
    document.body.appendChild(ghost);
    dragState.ghost = ghost;
    // Live drop preview: the badge leaves the grid and a dashed slot shows
    // where it will land — the slot follows the pointer between tiles, so
    // there's no guesswork about where a drop will place it.
    var slot = document.createElement("div");
    slot.className = "ra-drop-slot";
    grid.insertBefore(slot, tile);
    if (tile.parentNode) tile.parentNode.removeChild(tile);
    dragState.slot = slot;
    // Cache the visible tiles' geometry so drop targeting is stable: the
    // slot's presence shifts tiles around, which would otherwise feed back
    // into the targeting and make the preview erratic.
    dragState.rects = [];
    var kids = grid.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el === slot) continue;
      if (el.classList && el.classList.contains("ra-hidden")) continue;
      var r = null;
      try { r = el.getBoundingClientRect(); } catch (e) {}
      if (r) dragState.rects.push({ el: el, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    }
    blockScroll(true);
    // Appear at the pointer's current position (the badge "teleports"
    // under the pointer even if it moved away during the hold).
    positionGhostAt(dragState.lastX, dragState.lastY);
    updateDropSlot(dragState.lastX, dragState.lastY);
  }

  // Moves the drop-preview slot to the tile nearest the pointer. Targeting
  // uses the geometry cached at drag start (stable — no feedback loop) and
  // the nearest tile by center distance, which behaves intuitively across
  // wrapped grid rows.
  function updateDropSlot(x, y) {
    var grid = dragState.grid, slot = dragState.slot;
    if (!grid || !slot || slot.parentNode !== grid) return;
    var rects = dragState.rects || [];
    var best = null, bestD = Infinity;
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].el.parentNode !== grid) continue;
      var dx = x - rects[i].cx, dy = y - rects[i].cy;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = rects[i]; }
    }
    if (!best) return;
    var after = x > best.cx;
    var ref = after ? best.el.nextSibling : best.el;
    while (ref && ref !== slot && ref.classList && ref.classList.contains("ra-hidden")) {
      ref = ref.nextSibling;
    }
    if (ref && ref !== slot) grid.insertBefore(slot, ref);
    else if (!ref) {
      var fh = grid.querySelector(".ra-hidden");
      if (fh) grid.insertBefore(slot, fh); else grid.appendChild(slot);
    }
  }

  // Drops the badge at the preview slot's position.
  function finishDrop() {
    var grid = dragState.grid, tile = dragState.tile, slot = dragState.slot;
    if (!grid || !tile) return;
    if (slot && slot.parentNode === grid) {
      grid.insertBefore(tile, slot);
      grid.removeChild(slot);
      dragState.slot = null;
    } else {
      grid.appendChild(tile);
    }
  }

  function cleanupDrag() {
    if (dragState) {
      if (dragState.ghost && dragState.ghost.parentNode) {
        dragState.ghost.parentNode.removeChild(dragState.ghost);
      }
      if (dragState.slot && dragState.slot.parentNode) {
        dragState.slot.parentNode.removeChild(dragState.slot);
      }
    }
    dragState = null;
    blockScroll(false);
  }

  function endGesture() {
    if (!dragState) return;
    if (dragState.holdTimer) { clearTimeout(dragState.holdTimer); dragState.holdTimer = null; }
    if (dragState.active) finishDrop();
    cleanupDrag();
  }

  function setupGlobalDragListeners() {
    document.addEventListener("pointermove", function (e) {
      if (!dragState) return;
      dragState.lastX = (e.clientX || 0);
      dragState.lastY = (e.clientY || 0);
      if (!dragState.active) {
        // Touch: moving before the hold fires means a scroll — cancel.
        // Mouse: the hold survives movement anywhere on the page; the badge
        // teleports under the pointer once the hold time elapses.
        if (dragState.pointerType === "touch") {
          var dx = dragState.lastX - dragState.startX;
          var dy = dragState.lastY - dragState.startY;
          if (Math.sqrt(dx * dx + dy * dy) > 12) endGesture();
        }
        return;
      }
      e.preventDefault();
      positionGhostAt(dragState.lastX, dragState.lastY);
      updateDropSlot(dragState.lastX, dragState.lastY);
    });
    document.addEventListener("pointerup", function () { if (dragState) endGesture(); });
    document.addEventListener("pointercancel", function () { if (dragState) endGesture(); });
  }

  function attachTileDrag(tile, grid) {
    tile.addEventListener("pointerdown", function (e) {
      if (!grid.classList.contains("ra-editing")) return;
      if (tile.classList.contains("ra-hidden")) return; // hidden badges don't drag
      if (e.button !== undefined && e.button !== 0) return;
      if (dragState) return;
      // Don't hijack the ✕ / ＋ buttons.
      var t = e.target;
      while (t && t !== tile) {
        if (t.classList && t.classList.contains("ra-tile-btn")) return;
        t = t.parentNode;
      }
      dragState = {
        tile: tile, grid: grid, ghost: null, active: false,
        startX: (e.clientX || 0), startY: (e.clientY || 0),
        lastX: (e.clientX || 0), lastY: (e.clientY || 0),
        pointerType: e.pointerType || "",
        holdTimer: setTimeout(startDrag, HOLD_MS)
      };
    });
  }

  function attachTileButton(tile, grid) {
    if (tile.querySelector(".ra-tile-btn")) return;
    var hidden = tile.classList.contains("ra-hidden");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ra-tile-btn " + (hidden ? "ra-plus" : "ra-x");
    btn.textContent = hidden ? "＋" : "✕";
    btn.title = hidden ? "Show this badge again" : "Hide this badge";
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleTileHidden(tile, grid);
    });
    tile.appendChild(btn);
  }

  function toggleTileHidden(tile, grid) {
    var btn = tile.querySelector(".ra-tile-btn");
    if (!btn) return;
    if (tile.classList.contains("ra-hidden")) {
      tile.classList.remove("ra-hidden");
      btn.className = "ra-tile-btn ra-x";
      btn.textContent = "✕";
      btn.title = "Hide this badge";
      var firstHidden = grid.querySelector(".ra-hidden");
      if (firstHidden) grid.insertBefore(tile, firstHidden);
      else grid.appendChild(tile);
    } else {
      tile.classList.add("ra-hidden");
      btn.className = "ra-tile-btn ra-plus";
      btn.textContent = "＋";
      btn.title = "Show this badge again";
      grid.appendChild(tile); // hidden badges sit at the end
    }
  }

  function enterEditMode(grid, hiddenGames, username) {
    grid.classList.add("ra-editing");
    // Reveal hidden badges at the end (half-transparent, restorable).
    hiddenGames.forEach(function (g) {
      var t = makeBeatenTile(g, username);
      t.classList.add("ra-hidden");
      grid.appendChild(t);
    });
    var tiles = grid.querySelectorAll("[data-beaten]");
    for (var i = 0; i < tiles.length; i++) {
      attachTileButton(tiles[i], grid);
      attachTileDrag(tiles[i], grid);
    }
  }

  function toggleEditMode() {
    var grid = document.querySelector("#gameawards .ra-beaten-section .ra-beaten-grid");
    var awards = document.getElementById("gameawards");
    if (!grid || !awards) return;

    if (grid.classList.contains("ra-editing")) {
      // FINISH — persist the arrangement shown in the grid.
      var order = [], hidden = [];
      var tiles = grid.querySelectorAll("[data-beaten]");
      for (var i = 0; i < tiles.length; i++) {
        var id = tiles[i].getAttribute("data-gameid");
        if (tiles[i].classList.contains("ra-hidden")) hidden.push(id);
        else order.push(id);
      }
      grid.classList.remove("ra-editing"); // exit edit mode (unblocks refresh)
      setManualData(getUsername(), { order: order, hidden: hidden });
      refreshBeatenSection(); // re-renders in normal (saved) view
    } else {
      var ctx = buildContext();
      var beaten = getBeatenGames(computeMasteredIds(awards));
      var split = applyManualOrder(beaten, ctx.manual || { order: [], hidden: [] });
      enterEditMode(grid, split.hiddenGames, ctx.username);
      updateFooterEditButton();
      // Entering edit mode is usually triggered from the footer or the
      // toolbar popup — both far below the badges. Bring the beaten section
      // (its counters carry the "Finish Editing" button) into view so
      // editing can start right away.
      var sec = null;
      try { sec = grid.closest(".ra-beaten-section"); } catch (e) {}
      if (!sec) sec = document.querySelector("#gameawards .ra-beaten-section");
      if (sec) {
        try { sec.scrollIntoView({ behavior: "smooth", block: "start" }); }
        catch (e) { try { sec.scrollIntoView(); } catch (e2) {} }
      }
    }
  }

  /* ---------- beaten section rendering -------------------------------- */

  function buildContext() {
    var username = getUsername();
    var viewer = getViewerUsername();
    var active = manualIsActive(username, viewer);
    return {
      username: username,
      viewer: viewer,
      manualActive: active,
      manual: active ? (getManualData(username) || { order: [], hidden: [] }) : null
    };
  }

  function buildBeatenSection(beaten, gridClass, withDivider, totals, ctx) {
    var section = document.createElement("div");
    section.className = "ra-beaten-section";

    if (withDivider) {
      var divider = document.createElement("div");
      divider.className = "ra-divider";
      section.appendChild(divider);
    }

    var visible = beaten;
    if (ctx.manualActive && ctx.manual) {
      visible = applyManualOrder(beaten, ctx.manual).visible;
    }

    var hcF = 0, scF = 0, hcV = 0, scV = 0;
    beaten.forEach(function (g) { if (g.type === "hc") hcF++; else scF++; });
    visible.forEach(function (g) { if (g.type === "hc") hcV++; else scV++; });
    var hcTotal = totals && typeof totals.hc === "number" ? totals.hc : hcF;
    var scTotal = totals && typeof totals.sc === "number" ? totals.sc : scF;

    var bLabel = buildGroupLabel("Beaten", false);
    var hcDisp = Math.max(hcTotal, hcF);
    if (hcDisp > 0) {
      var hcHid = Math.max(0, hcDisp - hcV);
      bLabel.appendChild(makeCrownCounter("silver", hcDisp,
        hcDisp + " games beaten" + (hcHid > 0 ? " (" + hcHid + " hidden)" : "")));
    }
    var scDisp = Math.max(scTotal, scF);
    if (scDisp > 0) {
      var scHid = Math.max(0, scDisp - scV);
      bLabel.appendChild(makeMedalCounter(scDisp,
        scDisp + " games beaten (casual)" + (scHid > 0 ? " (" + scHid + " hidden)" : "")));
    }

    section.appendChild(bLabel);

    var bGrid = document.createElement("div");
    bGrid.className = gridClass + " ra-beaten-grid";
    visible.forEach(function (g) { bGrid.appendChild(makeBeatenTile(g, ctx.username)); });
    section.appendChild(bGrid);

    if (visible.length >= 2 && !ctx.manualActive) {
      sortBeatenTiles(bGrid, getSortPref());
    }

    return section;
  }

  // (Re)builds the Beaten section inside `awards`. Safe to call repeatedly.
  function renderBeatenSection(awards, beaten, gridClass, withDivider, totals, ctx) {
    var old = awards.querySelector(".ra-beaten-section");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var section = buildBeatenSection(beaten, gridClass, withDivider, totals, ctx);
    if (withDivider) {
      var mGrid = awards.querySelector(".grid");
      if (mGrid && mGrid.parentNode) mGrid.parentNode.insertBefore(section, mGrid.nextSibling);
      else awards.appendChild(section);
    } else {
      awards.appendChild(section);
    }
    return section;
  }

  // Re-renders the Beaten section (e.g. after toggling Manual Order, or a
  // storage change from another tab). Never clobbers an active edit mode.
  function refreshBeatenSection() {
    if (document.querySelector(".ra-beaten-grid.ra-editing")) return;
    var awards = document.getElementById("gameawards");
    if (!awards || !awards.querySelector(".ra-beaten-section")) return;
    var mGrid = awards.querySelector(".grid");
    var ctx = buildContext();
    var beaten = getBeatenGames(computeMasteredIds(awards));
    var totals = getBeatenTotals();
    renderBeatenSection(awards, beaten, mGrid ? mGrid.className : GRID_CLASSES, true, totals, ctx);
    updateFooterEditButton();
  }

  /* ---------- main apply routine -------------------------------------- */

  function apply() {
    var awards = document.getElementById("gameawards");
    if (awards && awards.dataset.raApplied === "v2" && awards.querySelector(".ra-grouplabel")) {
      return true;
    }

    var ctx = buildContext();
    var beatenTotals = getBeatenTotals();
    var hasTotal = !!(beatenTotals && (beatenTotals.hc > 0 || beatenTotals.sc > 0));
    var created = false;

    if (awards) {
      var grid = awards.querySelector(".grid");
      if (!grid) return false;

      var counts = readMasteryCounts(awards);

      var oldCounters = awards.querySelectorAll("h3 .cursor-help");
      for (var i = 0; i < oldCounters.length; i++) oldCounters[i].remove();

      if (!awards.querySelector(".ra-grouplabel")) {
        var mLabel = buildGroupLabel("Mastered", true);
        if (counts.hc > 0)
          mLabel.appendChild(makeCrownCounter("gold", counts.hc, counts.hcTitle || (counts.hc + " games mastered")));
        if (counts.sc > 0)
          mLabel.appendChild(makeMedalCounter(counts.sc, counts.scTitle || (counts.sc + " games completed")));
        awards.insertBefore(mLabel, grid);
      }

      var beaten = getBeatenGames(computeMasteredIds(awards));
      if (beaten.length > 0 || hasTotal) {
        renderBeatenSection(awards, beaten, grid.className, true, beatenTotals, ctx);
      }

      awards.dataset.raApplied = "v2";
    } else {
      var beaten0 = getBeatenGames(Object.create(null));
      if (beaten0.length === 0 && !hasTotal) return true;
      var completed = document.getElementById("completedgames");
      if (!completed || !completed.parentNode) return false;

      awards = document.createElement("div");
      awards.id = "gameawards";
      awards.appendChild(buildTitle());
      renderBeatenSection(awards, beaten0, GRID_CLASSES, false, beatenTotals, ctx);
      completed.parentNode.insertBefore(awards, completed);
      awards.dataset.raApplied = "v2";
      created = true;
    }

    updateFooterEditButton();

    console.info(
      "[RABG] " + "Beaten section ready" +
      (beatenTotals ? " (Progression Status: " + beatenTotals.hc + " HC, " + beatenTotals.sc + " SC)" : "") +
      (ctx.manualActive ? " — manual order active" : "") +
      (created ? " — created the Game Awards box." : ".")
    );
    return true;
  }

  /* ---------- site theme capture (used by the popup) ------------------- */

  // Resolve RA's effective color scheme. RA renders it as an attribute on
  // <body> (NOT <html>): data-scheme="" means Dark, "black" = Black,
  // "light" = Light, "system" = follow the OS (resolved here via matchMedia
  // — RA's own CSS does the same with a media query). Falls back to <html>
  // and finally to the OS preference, then Dark.
  function resolveScheme() {
    var v = "";
    try {
      if (document.body) v = (document.body.getAttribute("data-scheme") || "").toLowerCase();
    } catch (e) {}
    if (!v) {
      try {
        v = (document.documentElement.getAttribute("data-scheme") || "").toLowerCase();
      } catch (e) {}
    }
    if (v === "black") return "black";
    if (v === "light") return "light";
    if (v === "system") {
      try {
        if (window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
      } catch (e) {}
    }
    return "dark";
  }

  // The popup can't read the site's CSS (different document), so we capture
  // the live RA colors here — including the *rendered* button colors via a
  // hidden probe element — and store them for the popup to apply.
  function captureSiteTheme() {
    try {
      var probe = document.createElement("span");
      probe.className = "btn-base btn-base--default btn-base--size-sm";
      probe.style.display = "none";
      // Force a concrete border so the computed border-color resolves.
      probe.style.borderWidth = "1px";
      probe.style.borderStyle = "solid";
      document.body.appendChild(probe);
      var cs = getComputedStyle(probe);
      // CRITICAL: read the theme variables from <body>'s computed style.
      // RA defines the dark palette on :root, but the Black/Light scheme
      // values and the color-theme overrides (e.g. the default theme's
      // blue text / gold links) live in [data-scheme=…] / [data-theme=…]
      // rules attached to <body> — they never inherit back up to <html>.
      // Reading from documentElement always yielded the dark :root values.
      var bcs = getComputedStyle(document.body);
      var scheme = resolveScheme();
      var light = scheme === "light";
      var theme = {
        scheme: scheme,
        menu: bcs.getPropertyValue("--menu-link-color").trim(),
        btnText: (cs.color || "").trim(),
        btnBg: (cs.backgroundColor || "").trim(),
        btnBorder: (cs.borderTopColor || "").trim(),
        btnHoverText: bcs.getPropertyValue("--link-hover-color").trim(),
        btnHoverBorder: bcs.getPropertyValue("--menu-link-color").trim(),
        // RA's light-scheme buttons (btn-base) hover on neutral-100, not
        // embed-highlight (that's the dark-scheme / classic .btn recipe).
        btnHoverBg: light
          ? (bcs.getPropertyValue("--color-neutral-100").trim() || "#f5f5f5")
          : bcs.getPropertyValue("--embed-highlight-color").trim(),
        selectBg: bcs.getPropertyValue("--embed-color").trim(),
        switchOn: bcs.getPropertyValue("--text-color").trim(),
        switchOff: light
          ? (bcs.getPropertyValue("--color-neutral-200").trim() || "#e5e5e5")
          : (bcs.getPropertyValue("--color-neutral-700").trim() || "#3f3f46"),
        knob: light ? "#ffffff"
          : (bcs.getPropertyValue("--color-neutral-50").trim() || "#fafafa"),
        bg: bcs.getPropertyValue("--bg-color").trim(),
        box: bcs.getPropertyValue("--box-bg-color").trim(),
        highlight: bcs.getPropertyValue("--embed-highlight-color").trim(),
        text: bcs.getPropertyValue("--text-color").trim(),
        heading: bcs.getPropertyValue("--heading-color").trim(),
        muted: bcs.getPropertyValue("--text-color-muted").trim()
      };
      if (probe.parentNode) probe.parentNode.removeChild(probe);
      if (theme.btnBg === "rgba(0, 0, 0, 0)" || theme.btnBg === "transparent") theme.btnBg = "";
      // Only write when something actually changed (storage.onChanged
      // listeners in the popup re-theme live; avoid needless churn).
      if (STORE["rabg-scheme"] !== theme.scheme) {
        storeSet("rabg-scheme", theme.scheme); // standalone, simple key
      }
      var cur = STORE["rabg-site-theme"];
      if (JSON.stringify(cur) !== JSON.stringify(theme)) {
        storeSet("rabg-site-theme", theme);
      }
    } catch (e) {}
  }

  // Re-capture the theme when the user changes it. RA swaps data-scheme /
  // data-theme on <body> without reloading (its footer Theme/Scheme selects
  // update the attribute live), so we watch <body> — plus the selects
  // themselves as an early signal — and the OS scheme for "system" mode.
  var themeObserver = null;
  function startThemeObserver() {
    if (themeObserver) return;
    var deb = null;
    function scheduleCapture() {
      if (deb) return;
      deb = setTimeout(function () { deb = null; captureSiteTheme(); }, 250);
    }
    themeObserver = new MutationObserver(scheduleCapture);
    try {
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-scheme", "class"]
      });
    } catch (e) {}
    try {
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ["data-theme", "data-scheme", "class", "style"]
        });
      }
    } catch (e) {}
    try {
      var sels = document.querySelectorAll(
        "select[data-choose-theme], select[data-choose-scheme]");
      for (var i = 0; i < sels.length; i++) {
        sels[i].addEventListener("change", scheduleCapture);
      }
    } catch (e) {}
    try {
      if (window.matchMedia) {
        var mq = window.matchMedia("(prefers-color-scheme: light)");
        var onChange = function () { scheduleCapture(); };
        if (mq.addEventListener) mq.addEventListener("change", onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
    } catch (e) {}
    // Some RA pages apply their theme shortly after DOMContentLoaded —
    // capture once more after things settle (a no-op if nothing changed).
    setTimeout(function () { captureSiteTheme(); }, 1500);
  }

  /* ---------- popup messaging (state query + edit toggle) -------------- */

  // Lets the toolbar popup ask about the current page and toggle edit mode.
  // Registered after prefs load so STORE is ready.
  function startMessageListener() {
    var rt = runtime();
    if (!rt || !rt.onMessage || !rt.onMessage.addListener) return;
    rt.onMessage.addListener(function (msg, sender, respond) {
      if (!msg || typeof msg !== "object") return;
      var ctx = buildContext();
      var ownProfile = !!(ctx.viewer && ctx.username && ctx.viewer === ctx.username) &&
        !!document.querySelector("#gameawards .ra-beaten-section");
      if (msg.type === "rabg-get-state") {
        // `ownProfile` is stable regardless of the Manual Order toggle, so
        // the popup can combine it with its own (instant) checkbox state —
        // no race with the storage change still propagating.
        respond({
          ok: true,
          ownProfile: ownProfile,
          manualActive: ctx.manualActive && ownProfile,
          editing: !!document.querySelector(".ra-beaten-grid.ra-editing")
        });
      } else if (msg.type === "rabg-open-import") {
        // Popups get destroyed by the native file dialog, and programmatic
        // file-input clicks need a real in-page gesture — so the popup asks
        // us to show a small in-page prompt; its click opens the picker via
        // the proven footer-import path.
        highlightFooterImport();
        respond({ ok: true });
      } else if (msg.type === "rabg-toggle-edit") {
        if (ctx.manualActive && ownProfile) {
          toggleEditMode();
        }
        respond({
          ok: true,
          ownProfile: ownProfile,
          editing: !!document.querySelector(".ra-beaten-grid.ra-editing")
        });
      }
    });
  }

  /* ---------- boot: load prefs → footer → apply → observe ------------- */

  var retryTimer = null;
  function scheduleRetry() {
    if (retryTimer) return;
    var tries = 0;
    retryTimer = setInterval(function () {
      if (apply() || ++tries > 24) clearInterval(retryTimer);
    }, 500);
  }

  var observer = null, debounce = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function () {
      if (debounce) return;
      debounce = setTimeout(function () { debounce = null; injectFooterSettings(); fixFooterHeight(); apply(); }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function run() {
    injectFooterSettings();
    captureSiteTheme();
    startThemeObserver();
    var ok = apply();
    updateFooterEditButton(); // footer button exists (disabled) even off-profile
    if (ok) startObserver();
    else { scheduleRetry(); startObserver(); }
  }

  function init() {
    var rt = runtime();
    if (rt && rt.getURL) {
      crownUrls.gold = rt.getURL("icons/gold.svg");
      crownUrls.silver = rt.getURL("icons/silver.svg");
    }
    setupGlobalDragListeners();
    loadAllPrefs(function () {
      applyBeatenStyles();
      startStorageListener();
      startMessageListener();
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
      else run();
    });
  }

  init();
})();
