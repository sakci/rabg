/*
 * RABG: Add Beaten Game Badges to RetroAchievements
 * ------------------------------------------------------------------
 * On a RetroAchievements user profile page, this script:
 *   1. Reads the "Completion Progress" list for every game marked
 *      as "beaten" (data-award="beaten-hardcore" / "beaten").
 *   2. Sorts them by completion percentage (highest first).
 *   3. Adds them to the "Game Awards" grid with a SILVER frame.
 *   4. Updates the header counter: swaps the 👑 emoji for gold.svg
 *      and adds a second counter (silver.svg) for beaten games.
 *
 * If the page renders late or is re-rendered by Alpine.js,
 * a MutationObserver re-applies the changes.
 */
(function () {
  "use strict";

  var BEATEN_ATTR = "beaten-hardcore"; // primary award value on RA
  var crownUrls = { gold: "", silver: "" };

  /* ---------- helpers ------------------------------------------------ */

  function runtime() {
    if (typeof browser !== "undefined" && browser.runtime) return browser.runtime;
    if (typeof chrome !== "undefined" && chrome.runtime) return chrome.runtime;
    return null;
  }

  function getUsername() {
    // URL looks like /user/tele  ->  "tele"
    var parts = location.pathname.split("/").filter(Boolean);
    return parts[0] === "user" && parts[1] ? parts[1] : "";
  }

  // Completion as a 0..1 fraction.
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
      if (m) {
        var n = parseFloat(m[1]), d = parseFloat(m[2]);
        if (d > 0) return n / d;
      }
    }
    var txt = row.textContent.match(/([\d.]+)\s*of\s*([\d.]+)/);
    if (txt) {
      var nn = parseFloat(txt[1]), dd = parseFloat(txt[2]);
      if (dd > 0) return nn / dd;
    }
    return 0;
  }

  // Collect unique beaten games from the Completion Progress section.
  function getBeatenGames() {
    var scope =
      document.querySelector("#completion-progress-all") ||
      document.querySelector("#usercompletedgamescomponent") ||
      document;
    var rows = scope.querySelectorAll("tr");
    var map = Object.create(null);
    var list = [];

    rows.forEach(function (tr) {
      var awardEl = tr.querySelector("[data-award]");
      if (!awardEl) return;
      var award = awardEl.getAttribute("data-award");
      if (award !== BEATEN_ATTR && award !== "beaten") return;

      var link = tr.querySelector('a[href*="/game/"]');
      var img = tr.querySelector("img");
      if (!link || !img) return;

      var m = link.getAttribute("href").match(/\/game\/(\d+)/);
      if (!m) return;

      var gameId = m[1];
      var pct = completionOf(tr);

      // De-duplicate (the same game appears in multiple toggle views).
      if (map[gameId]) {
        if (pct > map[gameId].pct) map[gameId].pct = pct;
        return;
      }
      map[gameId] = {
        gameId: gameId,
        imgSrc: img.getAttribute("src"),
        pct: pct
      };
      list.push(map[gameId]);
    });

    list.sort(function (a, b) { return b.pct - a.pct; }); // highest first
    return list;
  }

  /* ---------- DOM builders ------------------------------------------ */

  function makeBeatenTile(game, username) {
    var wrap = document.createElement("div");
    wrap.setAttribute("data-gameid", game.gameId);
    wrap.setAttribute("data-beaten", "true");
    wrap.setAttribute("data-pct", game.pct.toFixed(4));

    var span = document.createElement("span");
    span.className = "inline";
    span.setAttribute(
      "x-data",
      "tooltipComponent($el, { dynamicType: 'game', dynamicId: '" +
        game.gameId + "'" + (username ? ", dynamicContext: '" + username + "'" : "") + " })"
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
    img.className = "silverimage";

    a.appendChild(img);
    span.appendChild(a);
    wrap.appendChild(span);
    return wrap;
  }

  function crownImg(which) {
    var img = document.createElement("img");
    img.className = "ra-crown-icon";
    img.src = crownUrls[which];
    img.alt = "";
    return img;
  }

  function makeCounter(which, count, title) {
    var box = document.createElement("div");
    box.className = "cursor-help flex gap-x-1 text-sm items-center";
    box.setAttribute("title", title);

    var iconHolder = document.createElement("div");
    iconHolder.className = "flex items-center";
    iconHolder.appendChild(crownImg(which));

    var num = document.createElement("div");
    num.className = "numitems";
    num.textContent = String(count);

    box.appendChild(iconHolder);
    box.appendChild(num);
    return box;
  }

  /* ---------- main apply routine ------------------------------------ */

  function apply() {
    var awards = document.getElementById("gameawards");
    if (!awards) return false;

    var grid = awards.querySelector(".grid");
    if (!grid) return false;

    // Already injected? (avoids duplicates on re-render)
    if (grid.querySelector('[data-beaten="true"]') &&
        awards.querySelector(".ra-beaten-counter")) {
      return true;
    }

    var games = getBeatenGames();
    var username = getUsername();

    // 1) Append beaten tiles (sorted), only if not already present.
    if (!grid.querySelector('[data-beaten="true"]')) {
      var tiles = games.map(function (g) { return makeBeatenTile(g, username); });
      tiles.forEach(function (t) { grid.appendChild(t); });
      // Each tile carries the same x-data attributes as RA's mastered
      // badges, so the site's own Alpine.js detects them (via its mutation
      // observer) and binds RetroAchievements' native hover tooltips —
      // nothing extra to do on our side.
    }

    // 2) Update the header counters (only once).
    if (!awards.querySelector(".ra-beaten-counter")) {
      var h3 = awards.querySelector("h3");
      if (h3) {
        var existing = h3.querySelector(".cursor-help"); // mastered counter

        // Replace the 👑 emoji with the gold crown image.
        if (existing) {
          var holder = existing.querySelector(".text-2xs");
          if (holder) {
            holder.textContent = "";
            holder.classList.add("flex", "items-center");
            holder.appendChild(crownImg("gold"));
          }
        }

        // Group both counters on the right side of the header.
        var right = document.createElement("div");
        right.className = "flex items-center gap-x-3";

        if (existing) {
          right.appendChild(existing);
        } else {
          // Fallback: build a mastered counter from existing gold tiles.
          var masteredCount = grid.querySelectorAll("img.goldimage").length;
          right.appendChild(makeCounter("gold", masteredCount, masteredCount + " games mastered"));
        }

        var beatenCounter = makeCounter("silver", games.length, games.length + " games beaten");
        beatenCounter.classList.add("ra-beaten-counter");
        right.appendChild(beatenCounter);

        h3.appendChild(right);
      }
    }

    console.info(
      "[RA: Beaten in Game Awards] Added " + games.length +
      " beaten game(s) to the Game Awards section."
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

  var observer = null;
  var debounce = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function () {
      if (debounce) return;
      debounce = setTimeout(function () {
        debounce = null;
        apply();
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function run() {
    if (apply()) {
      startObserver(); // keep changes alive across RA's re-renders
    } else {
      scheduleRetry();
      startObserver();
    }
  }

  function init() {
    var rt = runtime();
    if (rt && rt.getURL) {
      crownUrls.gold = rt.getURL("icons/gold.svg");
      crownUrls.silver = rt.getURL("icons/silver.svg");
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run);
    } else {
      run();
    }
  }

  init();
})();
