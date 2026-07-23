// X Verim content script — runs in the x.com page at document_idle.
// Modules (in order):
//   1. Focus model         — pick the timeline article closest to viewport center
//   2. Keyboard shortcuts  — j/k/l/f/s/a/r/v, read from config.SHORTCUTS
//   3. Insert draft        — execCommand + InputEvent fallback into the composer
//   4. Niche filter        — MutationObserver + rAF sweep, dim/hide/highlight
//   5. Floating panel      — filter toggle + counters, draggable
//   6. Analyze popover     — small dark card with take / why / reply angles
//   7. Guardrail banner    — non-blocking warning when pace exceeds the limit
//
// HARD RULE: never auto-click submit (tweetButton / tweetButtonInline).
// HARD RULE: only use data-testid / role / aria-label selectors (lib/x-dom.js).
(function () {
  "use strict";
  if (window.__XVERIM_LOADED__) return;
  window.__XVERIM_LOADED__ = true;

  var C = window.XVERIM_CONFIG || {};
  var D = window.XVerimDom || {};
  var SC = C.SHORTCUTS || {};
  var FILTER = C.FILTER || { enabled: true };
  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // ============== State ==============
  var state = {
    articles: [],
    focusedTweet: null,
    rafId: null,
    guardrailBannerEl: null,
    panelEl: null,
    panelPos: null,
    popoverEl: null,
    focusBadgeEl: null
  };

  // ============== Focus model ==============
  function findAllArticles() {
    return Array.prototype.slice.call(document.querySelectorAll(D.SELECTORS.tweet));
  }

  function pickFocused(articles) {
    if (!articles || !articles.length) return null;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var cy = window.scrollY + vh / 2;
    var best = null, bestDist = Infinity;
    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      var r = a.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue;  // off-screen
      var absTop = window.scrollY + r.top;
      var absMid = absTop + r.height / 2;
      var dist = Math.abs(absMid - cy);
      if (dist < bestDist) { bestDist = dist; best = a; }
    }
    return best;
  }

  function applyFocus() {
    var next = pickFocused(state.articles);
    if (next !== state.focusedTweet) {
      if (state.focusedTweet) state.focusedTweet.classList.remove("xverim-focused");
      state.focusedTweet = next;
      if (state.focusedTweet) state.focusedTweet.classList.add("xverim-focused");
    }
    // Reposition every tick (not just on change) since scrolling moves the
    // focused tweet on screen even when it stays the same element.
    updateFocusBadge();
  }

  // A floating tag next to the focused tweet — the outline alone was easy to
  // miss; this spells out that shortcuts (l/f/s/r/a) act on this tweet.
  function ensureFocusBadge() {
    if (state.focusBadgeEl) return state.focusBadgeEl;
    var el = document.createElement("div");
    el.className = "xverim-focus-badge";
    el.textContent = "● Active — shortcuts apply here";
    el.setAttribute("aria-hidden", "true");
    (document.body || document.documentElement).appendChild(el);
    state.focusBadgeEl = el;
    return el;
  }
  function updateFocusBadge() {
    var article = state.focusedTweet;
    if (!article || !article.isConnected) {
      if (state.focusBadgeEl) state.focusBadgeEl.style.display = "none";
      return;
    }
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var r = article.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh) {
      if (state.focusBadgeEl) state.focusBadgeEl.style.display = "none";
      return;
    }
    var el = ensureFocusBadge();
    el.style.display = "block";
    var top = Math.max(4, r.top - 20);
    var maxLeft = Math.max(4, vw - el.offsetWidth - 8);
    var left = Math.min(Math.max(4, r.left + 12), maxLeft);
    el.style.top = top + "px";
    el.style.left = left + "px";
  }

  function scheduleFocus() {
    if (state.rafId != null) return;
    state.rafId = window.requestAnimationFrame(function () {
      state.rafId = null;
      state.articles = findAllArticles();
      applyFocus();
    });
  }

  function startFocusObserver() {
    state.articles = findAllArticles();
    applyFocus();
    window.addEventListener("scroll", scheduleFocus, { passive: true });
    window.addEventListener("resize", scheduleFocus);
    // New tweets come and go; sweep the article list each mutation batch.
    try {
      var mo = new MutationObserver(scheduleFocus);
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  // ============== Insert draft ==============
  // execCommand("insertText") is deprecated but still works on contenteditable
  // in Chrome; the InputEvent fallback covers cases where it returns false.
  function insertDraft(text) {
    var el = D.getComposer ? D.getComposer() : document.querySelector(D.SELECTORS.composer);
    if (!el) return false;
    try { el.focus(); } catch (_) {}
    var ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (_) { ok = false; }
    if (!ok) {
      // X's editor handles paste events even when synthetic input events are ignored.
      try {
        var dt = new DataTransfer();
        dt.setData("text/plain", text);
        var evt = new ClipboardEvent("paste", {
          clipboardData: dt, bubbles: true, cancelable: true
        });
        // WebKit drops clipboardData passed to the constructor. Dispatching a
        // payload-less paste would let X cancel it and insert nothing, so we'd
        // wrongly count it as done and skip the InputEvent fallback below.
        if (evt.clipboardData === dt) ok = !el.dispatchEvent(evt);
      } catch (_) { ok = false; }
    }
    if (!ok) {
      try {
        el.dispatchEvent(new InputEvent("beforeinput", {
          inputType: "insertText", data: text, bubbles: true, cancelable: true
        }));
        el.dispatchEvent(new InputEvent("input", {
          inputType: "insertText", data: text, bubbles: true
        }));
        ok = true;
      } catch (e) {
        try { console.warn("[xverim] insertDraft fallback failed:", e); } catch (_) {}
      }
    }
    return ok;
  }

  // Wait for the composer to mount. Spec: rAF for the first 10 ticks, then
  // fall back to setTimeout polling. Total budget: maxMs.
  function waitForComposer(maxMs, intervalMs) {
    intervalMs = intervalMs || 150;
    maxMs = maxMs || 5000;
    return new Promise(function (resolve) {
      var start = Date.now();
      var rafTicks = 0;
      function check() {
        var el = D.getComposer ? D.getComposer() : document.querySelector(D.SELECTORS.composer);
        if (el) return resolve(el);
        rafTicks++;
        if (rafTicks <= 10 && Date.now() - start < maxMs) {
          window.requestAnimationFrame(check);
        } else if (Date.now() - start < maxMs) {
          setTimeout(check, intervalMs);
        } else {
          resolve(null);
        }
      }
      check();
    });
  }

  // ============== Open composer with text (from popup) ==============
  async function openComposerWithText(text) {
    var composer = D.getComposer ? D.getComposer() : null;
    if (!composer) {
      var btn = D.getNewTweetButton ? D.getNewTweetButton() : document.querySelector(D.SELECTORS.newTweetButton);
      if (btn) {
        try { btn.click(); } catch (_) {}
      }
      composer = await waitForComposer(5000, 100);
    }
    if (!composer) {
      try { console.warn("[xverim] composer not found after waiting"); } catch (_) {}
      return false;
    }
    return insertDraft(text);
  }

  // ============== Filter ==============
  // Turkish-aware lowercasing: plain toLowerCase() turns "İ" into "i̇"
  // (i + combining dot), so "içtihat" would never match "İçtihat".
  function trLower(s) {
    try { return String(s == null ? "" : s).toLocaleLowerCase("tr-TR"); }
    catch (_) { return String(s == null ? "" : s).toLowerCase(); }
  }
  function tweetTextAndHandle(article) {
    return {
      text: trLower(D.getTweetText(article) || ""),
      // Handles are ASCII — locale-aware lowering would turn "I" into "ı".
      handle: (D.getAuthorHandle(article) || "").toLowerCase()
    };
  }
  function applyFilter(article) {
    if (!article) return;
    if (!FILTER.enabled) {
      article.classList.remove("xverim-dim", "xverim-hide", "xverim-highlight");
      return;
    }
    var info = tweetTextAndHandle(article);
    var hide = false, dim = false, highlight = false;
    if (FILTER.mutedAuthors && FILTER.mutedAuthors.length) {
      var muted = FILTER.mutedAuthors.map(function (s) { return String(s || "").toLowerCase().replace(/^@/, ""); });
      if (muted.indexOf(info.handle) >= 0) hide = true;
    }
    if (!hide && FILTER.keywordsExclude && FILTER.keywordsExclude.length) {
      for (var i = 0; i < FILTER.keywordsExclude.length; i++) {
        var kx = trLower(FILTER.keywordsExclude[i] || "");
        if (kx && info.text.indexOf(kx) >= 0) {
          // hideMode === "hide" → full remove; otherwise just dim.
          if (FILTER.hideMode === "hide") hide = true;
          else dim = true;
          break;
        }
      }
    }
    if (FILTER.keywordsInclude && FILTER.keywordsInclude.length) {
      for (var j = 0; j < FILTER.keywordsInclude.length; j++) {
        var ki = trLower(FILTER.keywordsInclude[j] || "");
        if (ki && info.text.indexOf(ki) >= 0) { highlight = true; break; }
      }
    }
    if (!highlight) {
      var minLikes = Number(FILTER.highlightMinLikes) || 0;
      if (minLikes > 0) {
        var counts = D.getCountsFromGroup(article) || {};
        if ((counts.likes || 0) >= minLikes) highlight = true;
      }
    }
    article.classList.toggle("xverim-dim", dim && !hide);
    article.classList.toggle("xverim-hide", hide);
    article.classList.toggle("xverim-highlight", highlight && !hide);
  }

  var filterRaf = null;
  function scheduleFilterSweep() {
    if (filterRaf != null) return;
    filterRaf = window.requestAnimationFrame(function () {
      filterRaf = null;
      var arts = findAllArticles();
      state.articles = arts;
      for (var i = 0; i < arts.length; i++) applyFilter(arts[i]);
    });
  }
  function startFilterObserver() {
    var target = document.querySelector(D.SELECTORS.primaryColumn) || document.body;
    try {
      var mo = new MutationObserver(scheduleFilterSweep);
      mo.observe(target, { childList: true, subtree: true });
    } catch (_) {}
    scheduleFilterSweep();
  }

  // ============== Shortcuts ==============
  function isTyping(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return false;
  }
  function isTypingTarget(t) {
    return t && t.nodeType === 1 && isTyping(t);
  }

  function scrollArticleIntoView(article) {
    if (!article) return;
    try {
      article.scrollIntoView({
        block: "center",
        behavior: REDUCED_MOTION ? "auto" : "smooth"
      });
    } catch (_) {
      try { article.scrollIntoView(); } catch (__) {}
    }
  }

  function moveFocus(delta) {
    var list = findAllArticles();
    if (!list.length) return;
    var cur = state.focusedTweet;
    var idx = cur ? list.indexOf(cur) : -1;
    if (idx < 0) idx = delta > 0 ? -1 : list.length;
    var next = Math.max(0, Math.min(list.length - 1, idx + delta));
    state.articles = list;
    if (state.focusedTweet) state.focusedTweet.classList.remove("xverim-focused");
    state.focusedTweet = list[next];
    if (state.focusedTweet) {
      state.focusedTweet.classList.add("xverim-focused");
      scrollArticleIntoView(state.focusedTweet);
    }
    updateFocusBadge();
  }

  function logGuardrail(kind) {
    try { chrome.runtime.sendMessage({ type: "GUARDRAIL_LOG", kind: kind }); } catch (_) {}
  }

  function handleShortcut(action, focused) {
    switch (action) {
      case "focusNext": return moveFocus(1);
      case "focusPrev": return moveFocus(-1);
      case "like": {
        if (!focused) return;
        var btn = D.getLikeButton(focused);
        if (btn) {
          // getLikeButton also returns the "unlike" button; only count real likes.
          var isLike = btn.getAttribute("data-testid") === "like";
          btn.click();
          if (isLike) logGuardrail("like");
        }
        return;
      }
      case "followAuthor": {
        if (!focused) return;
        var fb = D.getFollowButton(focused);
        if (fb) { fb.click(); logGuardrail("follow"); }
        return;
      }
      case "bookmark": {
        if (!focused) return;
        var bb = D.getBookmarkButton(focused);
        if (bb) bb.click();
        return;
      }
      case "replyWithDraft": {
        if (!focused) return;
        var rb = D.getReplyButton(focused);
        if (rb) rb.click();
        var tweet = {
          text: D.getTweetText(focused),
          authorHandle: D.getAuthorHandle(focused)
        };
        waitForComposer(2500, 250).then(function (composer) {
          if (!composer) { try { console.warn("[xverim] reply composer not found"); } catch (_) {} return; }
          try {
            chrome.runtime.sendMessage({ type: "AI_DRAFT", payload: tweet }, function (resp) {
              var err = chrome.runtime.lastError;
              if (!err && resp && resp.ok) insertDraft(resp.data);
              else try { console.warn("[xverim] AI_DRAFT failed:", (err && err.message) || (resp && resp.error)); } catch (_) {}
            });
          } catch (_) {}
        });
        return;
      }
      case "analyze": {
        if (!focused) return;
        var payload = {
          text: D.getTweetText(focused),
          authorHandle: D.getAuthorHandle(focused),
          counts: D.getCountsFromGroup(focused)
        };
        // Immediate feedback while the API call is in flight.
        showAnalyzePopover(focused, { take: "Analyzing…", whyPerforming: "", replyAngles: [] });
        try {
          chrome.runtime.sendMessage({ type: "AI_ANALYZE", payload: payload }, function (resp) {
            var err = chrome.runtime.lastError;
            if (!err && resp && resp.ok) showAnalyzePopover(focused, resp.data);
            else showAnalyzePopover(focused, {
              take: "Error",
              whyPerforming: String((err && err.message) || (resp && resp.error) || "unknown"),
              replyAngles: []
            });
          });
        } catch (_) {}
        return;
      }
      case "togglePanel": return togglePanel();
    }
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTyping(document.activeElement)) return;
    var k = (e.key || "").toLowerCase();
    if (!k) return;
    var actions = ["like","followAuthor","replyWithDraft","analyze","bookmark","focusNext","focusPrev","togglePanel"];
    var map = {};
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      var v = (SC[a] || "").toLowerCase();
      if (v) map[v] = a;
    }
    var action = map[k];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    handleShortcut(action, state.focusedTweet);
  }

  // ============== Floating panel ==============
  function applyPanelPos() {
    if (!state.panelEl) return;
    var p = state.panelPos;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      state.panelEl.style.left = p.x + "px";
      state.panelEl.style.top = p.y + "px";
      state.panelEl.style.right = "auto";
    } else {
      state.panelEl.style.right = "24px";
      state.panelEl.style.top = "80px";
      state.panelEl.style.left = "auto";
    }
  }
  function savePanelPos() {
    if (!state.panelEl) return;
    var r = state.panelEl.getBoundingClientRect();
    state.panelPos = { x: r.left, y: r.top };
    try { chrome.storage.local.set({ xverim_panel_pos: state.panelPos }); } catch (_) {}
  }
  function loadPanelPos() {
    try {
      chrome.storage.local.get(["xverim_panel_pos"], function (d) {
        if (d && d.xverim_panel_pos) { state.panelPos = d.xverim_panel_pos; applyPanelPos(); }
      });
    } catch (_) {}
  }

  function buildPanel() {
    var root = document.createElement("div");
    // Built hidden; togglePanel() decides visibility (building it pre-opened
    // made the first keypress toggle it straight back off).
    root.className = "xverim-panel";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "X Verim panel");
    root.innerHTML = ''
      + '<div class="xverim-panel-header">'
      +   '<span class="xverim-panel-title">X Verim</span>'
      +   '<button class="xverim-icon-btn" data-act="close" aria-label="Close panel">'
      +     '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
      +       '<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
      +     '</svg>'
      +   '</button>'
      + '</div>'
      + '<div class="xverim-panel-section">'
      +   '<label class="xverim-toggle">'
      +     '<input type="checkbox" data-bind="filter-enabled" />'
      +     '<span>Niche filter</span>'
      +   '</label>'
      + '</div>'
      + '<div class="xverim-panel-section xverim-counters">'
      +   '<span class="xverim-counter"><b data-bind="likes">0</b> likes / hr</span>'
      +   '<span class="xverim-counter"><b data-bind="follows">0</b> follows / hr</span>'
      + '</div>';

    // Drag from the header.
    var header = root.querySelector(".xverim-panel-header");
    header.addEventListener("mousedown", function (e) {
      if (e.target.closest("button")) return;
      var r = root.getBoundingClientRect();
      var dx = e.clientX - r.left;
      var dy = e.clientY - r.top;
      function onMove(ev) {
        var x = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - dx));
        var y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
        root.style.left = x + "px";
        root.style.top = y + "px";
        root.style.right = "auto";
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        savePanelPos();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
    root.querySelector("[data-act='close']").addEventListener("click", function () { togglePanel(false); });

    var filterInput = root.querySelector("[data-bind='filter-enabled']");
    filterInput.checked = !!FILTER.enabled;
    filterInput.addEventListener("change", function () {
      FILTER.enabled = filterInput.checked;
      try { chrome.storage.local.set({ xverim_filter_enabled: FILTER.enabled }); } catch (_) {}
      scheduleFilterSweep();
    });

    state.panelEl = root;
    applyPanelPos();
    refreshPanelData();
    (document.body || document.documentElement).appendChild(root);
  }

  // Persona is deliberately not surfaced anywhere in the UI — it only ever
  // travels from config.js into the system prompt.
  function refreshPanelData() {
    if (!state.panelEl) return;
    try {
      chrome.runtime.sendMessage({ type: "GET_COUNTS" }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok || !state.panelEl) return;
        var l = state.panelEl.querySelector("[data-bind='likes']");
        var f = state.panelEl.querySelector("[data-bind='follows']");
        if (l) l.textContent = String(resp.data.likes || 0);
        if (f) f.textContent = String(resp.data.follows || 0);
      });
    } catch (_) {}
  }

  function togglePanel(force) {
    if (!state.panelEl) buildPanel();
    var show = (typeof force === "boolean") ? force : !state.panelEl.classList.contains("xverim-open");
    state.panelEl.classList.toggle("xverim-open", show);
    if (show) refreshPanelData();
  }

  // ============== Clipboard ==============
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) { return false; }
  }
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  var COPY_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    + '<path d="M3.5 10.5V3.5A1 1 0 0 1 4.5 2.5H10.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>'
    + '</svg>';
  var CHECK_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<path d="M3 8.5 L6.5 12 L13 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';

  // getText is a function so callers can defer reading DOM text until click time.
  function bindCopyButton(btn, getText) {
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var text = getText();
      if (!text) return;
      copyToClipboard(text).then(function (ok) {
        btn.classList.toggle("xverim-copy-ok", !!ok);
        btn.innerHTML = ok ? CHECK_ICON : COPY_ICON;
        btn.title = ok ? "Copied" : "Copy failed";
        setTimeout(function () {
          btn.classList.remove("xverim-copy-ok");
          btn.innerHTML = COPY_ICON;
          btn.title = "Copy";
        }, 1200);
      });
    });
  }

  // ============== Analyze popover ==============
  function closePopover() {
    if (state.popoverEl && state.popoverEl.parentNode) {
      state.popoverEl.parentNode.removeChild(state.popoverEl);
    }
    state.popoverEl = null;
  }
  function showAnalyzePopover(article, data) {
    closePopover();
    if (!article) return;
    var r = article.getBoundingClientRect();
    var pop = document.createElement("div");
    pop.className = "xverim-popover";
    pop.setAttribute("role", "dialog");
    // Copy buttons are only useful once there's real content — not during
    // the "Analyzing…" placeholder or an error state.
    var canCopyTake = !!data.take && data.take !== "Analyzing…" && data.take !== "Error";
    pop.innerHTML = ''
      + '<button class="xverim-popover-close" aria-label="Close">'
      +   '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
      +     '<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
      +   '</svg>'
      + '</button>'
      + '<div class="xverim-popover-section">'
      +   '<div class="xverim-popover-label-row">'
      +     '<span class="xverim-popover-label">Take</span>'
      +     (canCopyTake ? '<button type="button" class="xverim-copy-btn" data-copy="take" aria-label="Copy take" title="Copy">' + COPY_ICON + '</button>' : '')
      +   '</div>'
      +   '<div class="xverim-popover-body" data-bind="take"></div>'
      + '</div>'
      + '<div class="xverim-popover-section">'
      +   '<div class="xverim-popover-label">Why performing</div>'
      +   '<div class="xverim-popover-body" data-bind="why"></div>'
      + '</div>'
      + '<div class="xverim-popover-section">'
      +   '<div class="xverim-popover-label">Reply drafts</div>'
      +   '<ul class="xverim-popover-list" data-bind="angles"></ul>'
      + '</div>';
    pop.querySelector(".xverim-popover-close").addEventListener("click", closePopover);
    var takeText = data.take || "—";
    pop.querySelector("[data-bind='take']").textContent = takeText;
    pop.querySelector("[data-bind='why']").textContent = data.whyPerforming || "—";
    if (canCopyTake) {
      bindCopyButton(pop.querySelector("[data-copy='take']"), function () { return takeText; });
    }
    var ul = pop.querySelector("[data-bind='angles']");
    (data.replyAngles || []).forEach(function (a) {
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.className = "xverim-popover-angle-text";
      span.textContent = a;
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "xverim-copy-btn";
      copyBtn.setAttribute("aria-label", "Copy reply draft");
      copyBtn.title = "Copy";
      copyBtn.innerHTML = COPY_ICON;
      bindCopyButton(copyBtn, function () { return a; });
      li.appendChild(span);
      li.appendChild(copyBtn);
      ul.appendChild(li);
    });
    (document.body || document.documentElement).appendChild(pop);
    // Position next to the article, clamped to viewport.
    var pw = 320;
    var ph = pop.offsetHeight || 200;
    var left = window.scrollX + r.right + 8;
    var top = window.scrollY + r.top;
    if (left + pw > window.scrollX + window.innerWidth - 8) left = window.scrollX + r.left - pw - 8;
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    if (top + ph > window.scrollY + window.innerHeight - 8) top = window.scrollY + window.innerHeight - ph - 8;
    if (top < window.scrollY + 8) top = window.scrollY + 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    state.popoverEl = pop;
  }
  // Click outside / Esc dismisses the popover.
  document.addEventListener("mousedown", function (e) {
    if (state.popoverEl && !state.popoverEl.contains(e.target)) closePopover();
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closePopover(); }
  });

  // ============== Guardrail banner ==============
  function showBanner(kind) {
    if (state.guardrailBannerEl && state.guardrailBannerEl.parentNode) {
      state.guardrailBannerEl.parentNode.removeChild(state.guardrailBannerEl);
    }
    var limits = C.GUARDRAILS || {};
    var limit = kind === "like" ? limits.warnLikesPerHour
              : kind === "follow" ? limits.warnFollowsPerHour
              : null;
    var el = document.createElement("div");
    el.className = "xverim-banner";
    el.setAttribute("role", "status");
    var label = (kind === "like") ? "likes" : (kind === "follow") ? "follows" : "actions";
    el.innerHTML = ''
      + '<span class="xverim-banner-text">'
      +   '<svg class="xverim-banner-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
      +     '<path d="M8 1.5 L15 14 L1 14 Z" fill="currentColor"/>'
      +     '<text x="8" y="12" text-anchor="middle" font-size="9" font-weight="700" fill="#1d9bf0">!</text>'
      +   '</svg>'
      +   'Pace check: ' + label + ' &gt; ' + (limit == null ? "?" : limit) + '/hr. Slow down — this is your account.'
      + '</span>'
      + '<button class="xverim-banner-close" aria-label="Dismiss">'
      +   '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
      +     '<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
      +   '</svg>'
      + '</button>';
    el.querySelector(".xverim-banner-close").addEventListener("click", function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (state.guardrailBannerEl === el) state.guardrailBannerEl = null;
    });
    (document.body || document.documentElement).appendChild(el);
    state.guardrailBannerEl = el;
    setTimeout(function () {
      if (state.guardrailBannerEl === el && el.parentNode) {
        el.parentNode.removeChild(el);
        state.guardrailBannerEl = null;
      }
    }, 8000);
  }

  // ============== Message router (from background / popup) ==============
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "GUARDRAIL_WARN") showBanner(msg.kind);
    if (msg.type === "OPEN_COMPOSER_WITH_TEXT") {
      openComposerWithText(msg.text).then(function (ok) { sendResponse({ ok: !!ok }); });
      return true;
    }
  });

  // ============== Init ==============
  function init() {
    if (!D || !D.SELECTORS) {
      try { console.warn("[xverim] x-dom not loaded; aborting init"); } catch (_) {}
      return;
    }
    startFocusObserver();
    startFilterObserver();
    document.addEventListener("keydown", onKeyDown, true);
    loadPanelPos();
    // Sync filter toggle from storage (popup can change it cross-tab).
    try {
      chrome.storage.local.get(["xverim_filter_enabled"], function (d) {
        if (d && typeof d.xverim_filter_enabled === "boolean") {
          FILTER.enabled = d.xverim_filter_enabled;
          scheduleFilterSweep();
        }
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local" || !changes.xverim_filter_enabled) return;
        FILTER.enabled = !!changes.xverim_filter_enabled.newValue;
        scheduleFilterSweep();
        // Live-update the panel checkbox if it exists.
        if (state.panelEl) {
          var cb = state.panelEl.querySelector("[data-bind='filter-enabled']");
          if (cb) cb.checked = FILTER.enabled;
        }
      });
    } catch (_) {}
    // Tiny debug handle (intentionally minimal — no panel-state leakage).
    window.__xverim = {
      state: state, C: C, D: D,
      insertDraft: insertDraft,
      openComposerWithText: openComposerWithText,
      togglePanel: togglePanel,
      applyFilter: applyFilter
    };
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
