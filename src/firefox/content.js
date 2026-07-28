/*
 * RA: Beaten Games in Game Awards
 * ------------------------------------------------------------------
 * Reorganizes the "Game Awards" box on a RetroAchievements profile into
 * two labeled groups (Mastered / Beaten), adds beaten games, and lets the
 * user choose how beaten tiles are sorted (persisted via localStorage).
 *
 *   Mastered   👑 (hardcore mastered)   🎖 (softcore completed)
 *   ─────────── divider ───────────
 *   Beaten     silver-crown (hardcore)   🎖 (softcore)   [sort selector]
 */
(function () {
  "use strict";

  var crownUrls = { gold: "", silver: "" };
  var SORT_KEY = "ra-beaten-sort-v1";
  var GRID_CLASSES =
    "component w-full place-content-center bg-embed gap-2 grid " +
    "grid-cols-[repeat(auto-fill,minmax(52px,52px))] xl:rounded xl:py-2";

  /* ---------- helpers ------------------------------------------------ */

  function runtime() {
    if (typeof browser !== "undefined" && browser.runtime) return browser.runtime;
    if (typeof chrome !== "undefined" && chrome.runtime) return chrome.runtime;
    return null;
  }

  function getUsername() {
    var parts = location.pathname.split("/").filter(Boolean);
    return parts[0] === "user" && parts[1] ? parts[1] : "";
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

  /* ---------- data --------------------------------------------------- */

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

  /* ---------- DOM builders ------------------------------------------ */

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

  /* ---------- beaten sorting ---------------------------------------- */

  var SORT_OPTIONS = [
    ["pct-desc", "Percentage (highest)"],
    ["pct-asc", "Percentage (lowest)"],
    ["title-asc", "Game Title (A-Z)"],
    ["title-desc", "Game Title (Z-A)"]
  ];

  function getSortPref() {
    try { return localStorage.getItem(SORT_KEY) || "pct-desc"; } catch (e) { return "pct-desc"; }
  }
  function setSortPref(v) {
    try { localStorage.setItem(SORT_KEY, v); } catch (e) {}
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

  // Injects the sort selector into the page footer, directly under the "Theme"
  // row (and above the copyright). It mirrors the theme row's markup and
  // clones the theme <select> so its styling/height is identical. Runs on every
  // RA page that has the footer. Changing it saves the preference and re-sorts
  // beaten tiles on the current page (if any).
  function injectFooterSort() {
    if (document.querySelector(".ra-footer-sort")) return;
    var themeSelect = document.querySelector("[data-choose-theme]");
    if (!themeSelect) return;
    var themeRow = themeSelect.closest(".flex.mb-3.items-center") ||
                   themeSelect.closest(".flex.items-center");
    if (!themeRow || !themeRow.parentNode) return;

    var row = document.createElement("div");
    row.className = "flex mb-3 items-center ra-footer-sort";

    var label = document.createElement("div");
    label.textContent = "Beaten Sort";

    var controls = document.createElement("div");
    controls.className = "flex align-center ml-2 gap-2";

    var sr = document.createElement("label");
    sr.className = "sr-only";
    sr.textContent = "Beaten sort order";

    // A plain <select> picks up RA's base `select{}` styling (border, padding,
    // font) — the same look and height as the footer's other selects.
    var sel = document.createElement("select");
    sel.className = "ra-footer-sort-select";
    SORT_OPTIONS.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0];
      op.textContent = o[1];
      sel.appendChild(op);
    });
    var saved = getSortPref();
    var valid = false;
    for (var i = 0; i < SORT_OPTIONS.length; i++) if (SORT_OPTIONS[i][0] === saved) valid = true;
    sel.value = valid ? saved : "pct-desc";
    sel.addEventListener("change", function () {
      setSortPref(sel.value);
      var grid = document.querySelector("#gameawards .ra-beaten-section .grid");
      if (grid) sortBeatenTiles(grid, sel.value);
    });

    controls.appendChild(sr);
    controls.appendChild(sel);
    row.appendChild(label);
    row.appendChild(controls);

    // Insert right after the theme row (i.e. above the copyright row).
    themeRow.parentNode.insertBefore(row, themeRow.nextSibling);
  }

  /* ---------- beaten section ---------------------------------------- */

  function beatenHover(display, total, fetched, suffix) {
    var hidden = total > fetched ? total - fetched : 0;
    return display + " games beaten" + suffix + (hidden > 0 ? " (" + hidden + " hidden)" : "");
  }

  function buildBeatenSection(beaten, username, gridClass, withDivider, totals) {
    var section = document.createElement("div");
    section.className = "ra-beaten-section";

    if (withDivider) {
      var divider = document.createElement("div");
      divider.className = "ra-divider";
      section.appendChild(divider);
    }

    var hcFetched = 0, scFetched = 0;
    beaten.forEach(function (g) { if (g.type === "hc") hcFetched++; else scFetched++; });
    var hcTotal = totals && typeof totals.hc === "number" ? totals.hc : hcFetched;
    var scTotal = totals && typeof totals.sc === "number" ? totals.sc : scFetched;

    var bLabel = buildGroupLabel("Beaten", false);
    var hcDisp = Math.max(hcTotal, hcFetched);
    if (hcDisp > 0)
      bLabel.appendChild(makeCrownCounter("silver", hcDisp, beatenHover(hcDisp, hcTotal, hcFetched, "")));
    var scDisp = Math.max(scTotal, scFetched);
    if (scDisp > 0)
      bLabel.appendChild(makeMedalCounter(scDisp, beatenHover(scDisp, scTotal, scFetched, " (casual)")));
    section.appendChild(bLabel);

    var bGrid = document.createElement("div");
    bGrid.className = gridClass;
    beaten.forEach(function (g) { bGrid.appendChild(makeBeatenTile(g, username)); });
    section.appendChild(bGrid);

    if (beaten.length >= 2) sortBeatenTiles(bGrid, getSortPref());

    return section;
  }

  /* ---------- main apply routine ------------------------------------ */

  function apply() {
    var awards = document.getElementById("gameawards");
    if (awards && awards.dataset.raApplied === "v2" && awards.querySelector(".ra-grouplabel")) {
      return true;
    }

    var masteredIds = Object.create(null);
    if (awards) {
      var mtiles = awards.querySelectorAll("[data-gameid]");
      for (var k = 0; k < mtiles.length; k++) {
        if (mtiles[k].getAttribute("data-beaten") !== "true") {
          masteredIds[mtiles[k].getAttribute("data-gameid")] = true;
        }
      }
    }

    var beaten = getBeatenGames(masteredIds);
    var beatenTotals = getBeatenTotals();
    var hasTotal = !!(beatenTotals && (beatenTotals.hc > 0 || beatenTotals.sc > 0));
    var username = getUsername();
    var created = false;

    if (awards) {
      var grid = awards.querySelector(".grid");
      if (!grid) return false;

      var counts = readMasteryCounts(awards);

      var oldCounters = awards.querySelectorAll("h3 .cursor-help");
      for (var i = 0; i < oldCounters.length; i++) oldCounters[i].remove();

      var mLabel = buildGroupLabel("Mastered", true);
      if (counts.hc > 0)
        mLabel.appendChild(makeCrownCounter("gold", counts.hc, counts.hcTitle || (counts.hc + " games mastered")));
      if (counts.sc > 0)
        mLabel.appendChild(makeMedalCounter(counts.sc, counts.scTitle || (counts.sc + " games completed")));
      awards.insertBefore(mLabel, grid);

      if (beaten.length > 0 || hasTotal) {
        var section = buildBeatenSection(beaten, username, grid.className, true, beatenTotals);
        grid.parentNode.insertBefore(section, grid.nextSibling);
      }

      awards.dataset.raApplied = "v2";
    } else {
      if (beaten.length === 0 && !hasTotal) return true;
      var completed = document.getElementById("completedgames");
      if (!completed || !completed.parentNode) return false;

      awards = document.createElement("div");
      awards.id = "gameawards";
      awards.appendChild(buildTitle());
      awards.appendChild(buildBeatenSection(beaten, username, GRID_CLASSES, false, beatenTotals));

      completed.parentNode.insertBefore(awards, completed);
      awards.dataset.raApplied = "v2";
      created = true;
    }

    console.info(
      "[RA: Beaten in Game Awards] " + beaten.length + " beaten tile(s) shown" +
      (beatenTotals ? " (Progression Status: " + beatenTotals.hc + " HC, " + beatenTotals.sc + " SC)" : "") +
      (created ? " — created the Game Awards box." : ".")
    );
    return true;
  }

  /* ---------- boot: retry + observe ---------------------------------- */

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
      debounce = setTimeout(function () { debounce = null; injectFooterSort(); apply(); }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function run() {
    injectFooterSort();
    if (apply()) startObserver();
    else { scheduleRetry(); startObserver(); }
  }

  function init() {
    var rt = runtime();
    if (rt && rt.getURL) {
      crownUrls.gold = rt.getURL("icons/gold.svg");
      crownUrls.silver = rt.getURL("icons/silver.svg");
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
    else run();
  }

  init();
})();
