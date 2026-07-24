// X Verim content script — runs in the x.com page at document_idle.
// Modules (in order):
//   1. Focus model         — pick the timeline article closest to viewport center
//   2. Keyboard shortcuts  — j/k/l/f/s/a/r/v, read from config.SHORTCUTS
//   3. Insert draft        — page-world Draft.js paste bridge (no native DOM writes)
//   4. Niche filter        — MutationObserver + rAF sweep, dim/hide/highlight
//   5. Floating panel      — filter toggle + counters, draggable
//   6. Analyze popover     — small dark card: translation + reply drafts (a)
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

  // config.js stays authoritative. These only fill in actions it never mentions,
  // so a key deliberately set to "" is still disabled — and a config written
  // before an action existed doesn't silently lose that action.
  var DEFAULT_SHORTCUTS = {
    focusNext: "j", focusPrev: "k", like: "l", bookmark: "s",
    followAuthor: "f", replyWithDraft: "r", analyze: "a", togglePanel: "v"
  };
  for (var dsk in DEFAULT_SHORTCUTS) {
    if (!Object.prototype.hasOwnProperty.call(SC, dsk)) SC[dsk] = DEFAULT_SHORTCUTS[dsk];
  }
  // Order here is the order of the panel's cheat sheet.
  var ACTION_ORDER = ["focusNext", "focusPrev", "like", "bookmark", "followAuthor", "replyWithDraft", "analyze", "togglePanel"];
  var ACTION_LABELS = {
    focusNext: "Sonraki tweet",
    focusPrev: "Önceki tweet",
    like: "Beğen",
    bookmark: "Yer işareti",
    followAuthor: "Yazarı takip et",
    replyWithDraft: "Yanıt kutusuna taslak",
    analyze: "Yanıt taslakları",
    togglePanel: "Paneli aç / kapat"
  };
  // Actions that do nothing without a tweet under the cursor.
  var NEEDS_TWEET = {
    like: true, bookmark: true, followAuthor: true, replyWithDraft: true, analyze: true
  };

  // ============== State ==============
  var state = {
    articles: [],
    focusedTweet: null,
    rafId: null,
    guardrailBannerEl: null,
    panelEl: null,
    panelPos: null,
    popoverEl: null,
    popoverArticle: null,
    focusBadgeEl: null,
    // After j/k jumps we lock the auto-pick briefly so the highlight lands on
    // the chosen tweet instead of flickering to whatever the smooth-scroll
    // passes over on the way there.
    focusLockUntil: 0,
    // Drafts currently on screen, fed back to the model on ↻ so a re-run
    // produces new angles instead of the same three sentences reworded.
    popoverDrafts: [],
    toastHost: null
  };

  // ============== Toast ==============
  // Short-lived line in the bottom-right corner. Every path that used to fail
  // into console.warn now says something the human can actually see.
  function ensureToastHost() {
    if (state.toastHost && state.toastHost.isConnected) return state.toastHost;
    var host = document.createElement("div");
    host.className = "xverim-toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    (document.body || document.documentElement).appendChild(host);
    state.toastHost = host;
    return host;
  }
  // duration 0 keeps it up until update()/dismiss() — used for "working…" lines.
  function showToast(message, opts) {
    var o = opts || {};
    var el = document.createElement("div");
    el.className = "xverim-toast" + (o.kind ? " xverim-toast-" + o.kind : "");
    el.textContent = message;
    ensureToastHost().appendChild(el);

    var timer = null;
    function dismiss() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!el.parentNode) return;
      el.classList.add("xverim-toast-out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 180);
    }
    function schedule(ms) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (ms > 0) timer = setTimeout(dismiss, ms);
    }
    schedule(o.duration == null ? 2600 : o.duration);
    return {
      update: function (text, opts2) {
        var o2 = opts2 || {};
        el.textContent = text;
        el.className = "xverim-toast" + (o2.kind ? " xverim-toast-" + o2.kind : "");
        schedule(o2.duration == null ? 2600 : o2.duration);
      },
      dismiss: dismiss
    };
  }

  // ============== Focus model ==============
  function findAllArticles() {
    return Array.prototype.slice.call(document.querySelectorAll(D.SELECTORS.tweet));
  }

  // A tweet the filter removed still matches the selector, and a display:none
  // element reports a 0×0 rect at the top of the page — which scored *better*
  // than the tweet you were actually reading. Focus only ever considers the
  // articles you can see.
  function isFocusable(article) {
    if (!article || !article.isConnected) return false;
    if (article.classList.contains("xverim-hide")) return false;
    var r = article.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function findFocusableArticles() {
    return findAllArticles().filter(isFocusable);
  }

  // The active tweet is the one crossing a "reading line" a little above the
  // viewport's middle — that reads as the tweet you're actually looking at,
  // and it stays right even for a tweet taller than the viewport (whose real
  // midpoint would be off-screen). `current` adds hysteresis: while the tweet
  // that's already active still crosses the line, we keep it, so small scrolls
  // don't make the highlight jitter between neighbours.
  function focusLineDist(a, vh, line) {
    var r = a.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) return Infinity;        // off-screen
    if (r.top <= line && r.bottom >= line) return 0;        // crosses the line
    return r.top > line ? r.top - line : line - r.bottom;   // nearest edge
  }
  function pickFocused(articles, current) {
    if (!articles || !articles.length) return null;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var line = vh * 0.38;
    // Keep the active tweet while it still crosses the line, or stays within a
    // small band around it. That kills the flip-flop when two neighbours sit on
    // the boundary, and keeps j/k's pick even when a short tweet centred by the
    // jump doesn't quite reach the line.
    if (current && isFocusable(current) && focusLineDist(current, vh, line) <= vh * 0.12) {
      return current;
    }
    var best = null, bestDist = Infinity;
    for (var i = 0; i < articles.length; i++) {
      if (!isFocusable(articles[i])) continue;
      var dist = focusLineDist(articles[i], vh, line);
      if (dist < bestDist) { bestDist = dist; best = articles[i]; }
    }
    return bestDist === Infinity ? null : best;
  }

  function applyFocus() {
    // During a post-j/k lock, keep the chosen tweet; just keep the badge glued
    // to it as the smooth scroll settles.
    if (state.focusLockUntil && Date.now() < state.focusLockUntil) {
      updateFocusBadge();
      return;
    }
    var next = pickFocused(state.articles, state.focusedTweet);
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
    // The hint is what makes the badge teach the extension instead of just
    // marking a tweet — and it follows the configured key, not a hardcoded "a".
    var analyzeKey = String(SC.analyze || "").toUpperCase();
    el.textContent = analyzeKey ? ("● Aktif tweet · " + analyzeKey + " taslak") : "● Aktif tweet";
    el.setAttribute("aria-hidden", "true");
    (document.body || document.documentElement).appendChild(el);
    state.focusBadgeEl = el;
    return el;
  }
  // A *visible* X dialog (reply / compose / media viewer) — deliberately not
  // our own panel/popover, which also carry role="dialog" and would otherwise
  // keep the badge hidden for good once opened.
  function xDialogOpen() {
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      var d = dialogs[i];
      if (d.classList.contains("xverim-panel") || d.classList.contains("xverim-popover")) continue;
      if (d.getClientRects && d.getClientRects().length) return true;  // rendered
    }
    return false;
  }
  // Roughly clears X's sticky top bar so the badge is never hidden behind it.
  var HEADER_SAFE = 56;
  function updateFocusBadge() {
    var article = state.focusedTweet;
    // Hide it entirely while a modal is open (reply / compose): the timeline is
    // behind the overlay, and a floating badge over the dialog just looks broken.
    if (xDialogOpen() || !article || !article.isConnected) {
      if (state.focusBadgeEl) state.focusBadgeEl.style.display = "none";
      return;
    }
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var r = article.getBoundingClientRect();
    if (r.bottom <= HEADER_SAFE || r.top >= vh) {
      if (state.focusBadgeEl) state.focusBadgeEl.style.display = "none";
      return;
    }
    var el = ensureFocusBadge();
    el.style.display = "block";
    // Sit just above the tweet, but drop just inside it (and below the header)
    // when the top edge is scrolled off — so it stays pinned to the active card.
    var top = r.top - 22;
    if (top < HEADER_SAFE) top = Math.min(r.bottom - 24, Math.max(HEADER_SAFE, r.top + 6));
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
  // Put text into X's draft.js composer WITHOUT leaving a "phantom" copy.
  //
  // draft.js renders the editor from an internal model into React-managed
  // <span data-text="true"> nodes. The old path — execCommand("insertText") —
  // makes the *browser* mutate the DOM natively; draft.js then also writes the
  // same text into its model and re-renders its own span. React can't reclaim
  // the stray native node it never created, so the text shows up twice (one
  // dead, one live) and every later keystroke corrupts the now-desynced model.
  //
  // Safari/WebKit does not reliably deliver synthetic clipboard/input events
  // from an isolated extension world to X's React tree. The web-accessible
  // draft-bridge.js runs in the page world and calls DraftEditor.onPaste with a
  // clipboard-shaped event. Draft.js then updates EditorState itself; WebKit
  // never receives an instruction to insert a native text node.
  var DRAFT_BRIDGE_REQUEST = "xverim:draft-insert-request";
  var DRAFT_BRIDGE_RESPONSE = "xverim:draft-insert-response";
  var DRAFT_BRIDGE_READY = "xverim:draft-bridge-ready";
  var draftBridgeState = { loading: false, ready: false, callbacks: [], nextId: 1, pending: {} };
  function composerText(el) {
    return (el && el.textContent ? el.textContent : "").replace(/\u00A0/g, " ");
  }
  function composerHasText(el, text) {
    return composerText(el).trim() === String(text).trim();
  }
  function composerIndex(el) {
    var all;
    try { all = Array.prototype.slice.call(document.querySelectorAll(D.SELECTORS.composer)); } catch (_) { all = []; }
    return all.indexOf(el);
  }
  function injectPageScript(path, done) {
    var script = document.createElement("script");
    script.src = chrome.runtime.getURL(path);
    script.async = false;
    script.onload = function () { script.remove(); done(true); };
    script.onerror = function () { script.remove(); done(false); };
    (document.head || document.documentElement).appendChild(script);
  }
  function flushBridgeCallbacks(ok) {
    var callbacks = draftBridgeState.callbacks.splice(0);
    for (var i = 0; i < callbacks.length; i++) callbacks[i](ok);
  }
  function ensureDraftBridge(done) {
    if (draftBridgeState.ready) { done(true); return; }
    draftBridgeState.callbacks.push(done);
    if (draftBridgeState.loading) return;
    draftBridgeState.loading = true;
    // x-dom stays the selector source of truth in both extension worlds.
    injectPageScript("lib/x-dom.js", function (domLoaded) {
      if (!domLoaded) { draftBridgeState.loading = false; flushBridgeCallbacks(false); return; }
      injectPageScript("content/draft-bridge.js", function (bridgeLoaded) {
        if (!bridgeLoaded) { draftBridgeState.loading = false; flushBridgeCallbacks(false); return; }
        // The bridge emits READY during evaluation. If a fast browser emitted
        // it before onload, its listener has already set `ready` below.
        setTimeout(function () {
          draftBridgeState.loading = false;
          flushBridgeCallbacks(draftBridgeState.ready);
        }, 0);
      });
    });
  }
  document.addEventListener(DRAFT_BRIDGE_READY, function () { draftBridgeState.ready = true; }, false);
  document.addEventListener(DRAFT_BRIDGE_RESPONSE, function (event) {
    var message;
    try { message = JSON.parse(event.detail || "{}"); } catch (_) { return; }
    var pending = message && draftBridgeState.pending[message.id];
    if (!pending) return;
    delete draftBridgeState.pending[message.id];
    pending(!!(message.payload && message.payload.ok));
  }, false);
  function insertDraft(text, el, options) {
    el = el || (D.getComposer ? D.getComposer() : document.querySelector(D.SELECTORS.composer));
    if (!el || !text) return Promise.resolve(false);
    try { el.focus(); } catch (_) {}
    return new Promise(function (resolve) {
      ensureDraftBridge(function (ready) {
        if (!ready) { try { console.warn("[xverim] Draft.js page bridge unavailable; draft not inserted"); } catch (_) {} resolve(false); return; }
        var id = "xverim-draft-" + (draftBridgeState.nextId++);
        var timeout = setTimeout(function () {
          if (!draftBridgeState.pending[id]) return;
          delete draftBridgeState.pending[id];
          resolve(false);
        }, 1500);
        draftBridgeState.pending[id] = function (ok) {
          clearTimeout(timeout);
          resolve(ok && composerHasText(el, text));
        };
        try {
          document.dispatchEvent(new CustomEvent(DRAFT_BRIDGE_REQUEST, {
            detail: JSON.stringify({
              id: id,
              text: String(text),
              composerIndex: composerIndex(el),
              inDialog: !!(el.closest && el.closest('[role="dialog"]')),
              requireComposePost: !!(options && options.requireComposePost)
            })
          }));
        } catch (_) {
          clearTimeout(timeout);
          delete draftBridgeState.pending[id];
          resolve(false);
        }
      });
    });
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
    return insertDraft(text, composer);
  }

  // X opens a reply on /compose/post, inside its real dialog. Do not use an
  // active/new/single-composer fallback here: the homepage's permanent "What is
  // happening?" editor satisfies each of those heuristics at the wrong moment.
  function resolveReplyComposer() {
    if (window.location.pathname !== "/compose/post") return null;
    var all;
    try { all = Array.prototype.slice.call(document.querySelectorAll(D.SELECTORS.composer)); } catch (_) { all = []; }
    if (!all.length) return null;
    for (var i = 0; i < all.length; i++) {
      var dialog = all[i].closest && all[i].closest('[role="dialog"]');
      var inRealDialog = dialog && !(dialog.classList.contains("xverim-panel") || dialog.classList.contains("xverim-popover"))
        && dialog.getClientRects && dialog.getClientRects().length;
      if (inRealDialog && all[i].getClientRects && all[i].getClientRects().length) return all[i];
    }
    return null;
  }
  function waitForReplyComposer(maxMs) {
    return new Promise(function (resolve) {
      var startedAt = Date.now();
      function attempt() {
        var el = resolveReplyComposer();
        if (el) { resolve(el); return; }
        if (Date.now() - startedAt < maxMs) setTimeout(attempt, 100);
        else resolve(null);
      }
      attempt();
    });
  }

  // Open the focused tweet's reply composer and drop a ready draft into it.
  // Same "click reply, never click submit" contract as the r shortcut — the
  // human still presses the button. Used by the Analyze popover's Yanıtla.
  function replyWithText(article, text) {
    if (!article || !text) return;
    var rb = D.getReplyButton ? D.getReplyButton(article) : null;
    if (rb) { try { rb.click(); } catch (_) {} }

    var t = showToast("Yanıt kutusu açılıyor…", { duration: 0 });
    waitForReplyComposer(5000).then(function (el) {
      if (!el) { copyFallback(t, text, "Yanıt kutusu açılmadı"); return; }
      insertDraft(text, el, { requireComposePost: true }).then(function (ok) {
        if (ok) t.update("Taslak hazır — göndermeye sen karar ver.", { kind: "ok" });
        else copyFallback(t, text, "Taslak kutuya eklenemedi");
      });
    });
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
    var list = findFocusableArticles();
    if (!list.length) return;
    var cur = state.focusedTweet;
    var idx = cur ? list.indexOf(cur) : -1;
    if (idx < 0) {
      // The active tweet was filtered out or unmounted — restart from whatever
      // is on the reading line now instead of jumping to the top of the list.
      var near = pickFocused(list, null);
      idx = near ? list.indexOf(near) : (delta > 0 ? -1 : list.length);
    }
    var next = Math.max(0, Math.min(list.length - 1, idx + delta));
    state.articles = list;
    if (state.focusedTweet) state.focusedTweet.classList.remove("xverim-focused");
    state.focusedTweet = list[next];
    if (state.focusedTweet) {
      state.focusedTweet.classList.add("xverim-focused");
      scrollArticleIntoView(state.focusedTweet);
      // Hold this pick through the smooth scroll so applyFocus doesn't retarget
      // to a tweet we're only scrolling past.
      state.focusLockUntil = Date.now() + (REDUCED_MOTION ? 120 : 480);
    }
    updateFocusBadge();
  }

  function logGuardrail(kind) {
    try {
      chrome.runtime.sendMessage({ type: "GUARDRAIL_LOG", kind: kind }, function () {
        void chrome.runtime.lastError;
        // Keep the open panel's meters honest as you act, not only on reopen.
        if (state.panelEl && state.panelEl.classList.contains("xverim-open")) refreshPanelData();
      });
    } catch (_) {}
  }

  function handleShortcut(action, focused) {
    if (NEEDS_TWEET[action] && !focused) {
      var navKeys = [SC.focusNext, SC.focusPrev].filter(Boolean).join(" / ").toUpperCase();
      showToast("Önce bir tweet seç" + (navKeys ? (" — " + navKeys + " ile gezinebilirsin.") : "."), { kind: "warn" });
      return;
    }
    switch (action) {
      case "focusNext": return moveFocus(1);
      case "focusPrev": return moveFocus(-1);
      case "like": {
        var btn = D.getLikeButton(focused);
        if (!btn) { showToast("Beğen düğmesi bulunamadı.", { kind: "warn" }); return; }
        // getLikeButton also returns the "unlike" button; only count real likes.
        var isLike = btn.getAttribute("data-testid") === "like";
        btn.click();
        if (isLike) logGuardrail("like");
        return;
      }
      case "followAuthor": {
        var fb = D.getFollowButton(focused);
        if (!fb) { showToast("Takip düğmesi yok — bu hesabı zaten takip ediyor olabilirsin.", { kind: "warn" }); return; }
        fb.click();
        logGuardrail("follow");
        var handle = D.getAuthorHandle(focused);
        showToast(handle ? ("@" + handle + " takip edildi.") : "Takip edildi.", { kind: "ok", duration: 1800 });
        return;
      }
      case "bookmark": {
        var bb = D.getBookmarkButton(focused);
        if (!bb) { showToast("Yer işareti düğmesi bulunamadı.", { kind: "warn" }); return; }
        bb.click();
        return;
      }
      case "replyWithDraft": {
        var rb = D.getReplyButton(focused);
        if (rb) rb.click();
        var tweet = {
          text: D.getTweetText(focused),
          authorHandle: D.getAuthorHandle(focused)
        };
        var t = showToast("Taslak yazılıyor…", { duration: 0 });
        waitForReplyComposer(5000).then(function (composer) {
          if (!composer) { t.update("Yanıt kutusu açılmadı.", { kind: "error" }); return; }
          try {
            chrome.runtime.sendMessage({ type: "AI_DRAFT", payload: tweet }, function (resp) {
              var err = chrome.runtime.lastError;
              var reason = (err && err.message) || (resp && resp.error);
              // Keep the exact reply composer captured above. It is never
              // replaced by the timeline's persistent "new post" editor.
              if (!err && resp && resp.ok && resp.data && composer.isConnected) {
                insertDraft(resp.data, composer, { requireComposePost: true }).then(function (ok) {
                  if (ok) t.update("Taslak hazır — göndermeye sen karar ver.", { kind: "ok" });
                  else copyFallback(t, resp.data, "Taslak kutuya eklenemedi");
                });
              } else {
                t.update("Taslak alınamadı: " + (reason || "bilinmeyen hata"), { kind: "error", duration: 4200 });
              }
            });
          } catch (e) {
            t.update("Taslak alınamadı: " + String((e && e.message) || e), { kind: "error", duration: 4200 });
          }
        });
        return;
      }
      case "analyze": {
        runAnalyze(focused);
        return;
      }
      case "togglePanel": return togglePanel();
    }
  }

  // When text can't reach the composer, the draft still shouldn't be lost:
  // put it on the clipboard and say so.
  function copyFallback(toast, text, why) {
    copyToClipboard(text).then(function (ok) {
      toast.update(
        ok ? (why + " — panoya kopyalandı, elle yapıştırabilirsin.") : (why + "."),
        { kind: ok ? "warn" : "error", duration: 4200 }
      );
    });
  }

  // Built once: config can't change without a reload anyway.
  var SHORTCUT_MAP = (function () {
    var map = {};
    for (var i = 0; i < ACTION_ORDER.length; i++) {
      var a = ACTION_ORDER[i];
      var v = String(SC[a] || "").toLowerCase();
      if (v) map[v] = a;
    }
    return map;
  })();

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTyping(document.activeElement)) return;
    var k = (e.key || "").toLowerCase();
    if (!k) return;
    // While the drafts card is open, 1…9 drops that draft into the reply box —
    // the whole flow (a, then 2) stays on the home row.
    if (state.popoverEl && state.popoverEl.isConnected && /^[1-9]$/.test(k)) {
      var buttons = state.popoverEl.querySelectorAll(".xverim-reply-btn");
      var pick = buttons[parseInt(k, 10) - 1];
      if (pick) {
        e.preventDefault();
        e.stopPropagation();
        pick.click();
        return;
      }
    }
    var action = SHORTCUT_MAP[k];
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
      // A position saved on a wider window (or a since-resized one) could put
      // the panel entirely off-screen, with no way to drag it back.
      var w = state.panelEl.offsetWidth || 320;
      var h = state.panelEl.offsetHeight || 120;
      var x = Math.max(0, Math.min(window.innerWidth - Math.min(w, 120), p.x));
      var y = Math.max(0, Math.min(window.innerHeight - Math.min(h, 60), p.y));
      state.panelEl.style.left = x + "px";
      state.panelEl.style.top = y + "px";
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

  // One "key → what it does" row per configured shortcut, straight from the
  // live config, so a custom key never disagrees with the cheat sheet.
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function shortcutRowsHtml() {
    var rows = "";
    for (var i = 0; i < ACTION_ORDER.length; i++) {
      var action = ACTION_ORDER[i];
      var key = String(SC[action] || "");
      if (!key) continue;
      // The key comes from config.js — escaped, because this is innerHTML.
      rows += '<div class="xverim-key-row">'
            +   '<kbd class="xverim-kbd">' + escapeHtml(key.toUpperCase()) + '</kbd>'
            +   '<span>' + ACTION_LABELS[action] + '</span>'
            + '</div>';
    }
    rows += '<div class="xverim-key-row">'
          +   '<kbd class="xverim-kbd">1…5</kbd>'
          +   '<span>Açık karttaki taslağı yanıt kutusuna koy</span>'
          + '</div>'
          + '<div class="xverim-key-row">'
          +   '<kbd class="xverim-kbd">Esc</kbd>'
          +   '<span>Kartı / paneli kapat</span>'
          + '</div>';
    return rows;
  }

  function buildPanel() {
    var root = document.createElement("div");
    // Built hidden; togglePanel() decides visibility (building it pre-opened
    // made the first keypress toggle it straight back off).
    root.className = "xverim-panel";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "X Verim paneli");
    root.innerHTML = ''
      + '<div class="xverim-panel-header">'
      +   '<span class="xverim-panel-title">X Verim</span>'
      +   '<button class="xverim-icon-btn" data-act="close" aria-label="Paneli kapat" title="Kapat">'
      +     '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
      +       '<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
      +     '</svg>'
      +   '</button>'
      + '</div>'
      + '<div class="xverim-panel-section">'
      +   '<label class="xverim-toggle">'
      +     '<input type="checkbox" data-bind="filter-enabled" />'
      +     '<span>Niş filtresi</span>'
      +   '</label>'
      + '</div>'
      + '<div class="xverim-panel-section">'
      +   '<div class="xverim-panel-label">Son 60 dakika</div>'
      +   '<div class="xverim-meter-row">'
      +     '<div class="xverim-meter-head"><span>Beğeni</span><span><b data-bind="likes">0</b><span data-bind="likes-limit"></span></span></div>'
      +     '<div class="xverim-meter"><i data-bind="likes-bar"></i></div>'
      +   '</div>'
      +   '<div class="xverim-meter-row">'
      +     '<div class="xverim-meter-head"><span>Takip</span><span><b data-bind="follows">0</b><span data-bind="follows-limit"></span></span></div>'
      +     '<div class="xverim-meter"><i data-bind="follows-bar"></i></div>'
      +   '</div>'
      + '</div>'
      + '<details class="xverim-panel-section xverim-keys">'
      +   '<summary>Kısayollar</summary>'
      +   '<div class="xverim-key-list">' + shortcutRowsHtml() + '</div>'
      + '</details>';

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
  function paintMeter(kind, value, limit) {
    var panel = state.panelEl;
    if (!panel) return;
    var num = panel.querySelector("[data-bind='" + kind + "']");
    var suffix = panel.querySelector("[data-bind='" + kind + "-limit']");
    var bar = panel.querySelector("[data-bind='" + kind + "-bar']");
    if (num) num.textContent = String(value);
    if (suffix) suffix.textContent = limit ? (" / " + limit) : "";
    if (!bar) return;
    var ratio = limit > 0 ? Math.min(1, value / limit) : 0;
    bar.style.width = Math.round(ratio * 100) + "%";
    bar.className = ratio >= 1 ? "xverim-over" : (ratio >= 0.75 ? "xverim-near" : "");
  }
  function refreshPanelData() {
    if (!state.panelEl) return;
    var limits = C.GUARDRAILS || {};
    try {
      chrome.runtime.sendMessage({ type: "GET_COUNTS" }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok || !state.panelEl) return;
        paintMeter("likes", resp.data.likes || 0, Number(limits.warnLikesPerHour) || 0);
        paintMeter("follows", resp.data.follows || 0, Number(limits.warnFollowsPerHour) || 0);
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
  var CLOSE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
    + '</svg>';
  var REFRESH_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
    + '<path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>'
    + '<path d="M13.5 2.6v3h-3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
  var REPLY_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
    + '<path d="M6.5 4 L3 7.5 L6.5 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M3 7.5 H9 A3.5 3.5 0 0 1 12.5 11 V12" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
  var SPARK_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">'
    + '<path d="M8 1.5 L9.4 5.1 L13 6.5 L9.4 7.9 L8 11.5 L6.6 7.9 L3 6.5 L6.6 5.1 Z" fill="currentColor"/>'
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
    state.popoverArticle = null;
    state.popoverDrafts = [];
  }

  // Kick off (or re-run) the AI pass for a tweet and drive the popover through
  // its loading / error / result states. The regenerate button reuses this and
  // passes what's already on screen, so ↻ means "different ones", not "again".
  function runAnalyze(article, options) {
    if (!article) return;
    var regenerate = !!(options && options.regenerate);
    if (!regenerate) state.popoverDrafts = [];
    var payload = {
      text: D.getTweetText(article),
      authorHandle: D.getAuthorHandle(article),
      counts: D.getCountsFromGroup(article),
      previous: state.popoverDrafts.slice(0)
    };
    showAnalyzePopover(article, { status: "loading" });
    try {
      chrome.runtime.sendMessage({ type: "AI_ANALYZE", payload: payload }, function (resp) {
        var err = chrome.runtime.lastError;
        if (!err && resp && resp.ok) {
          var data = resp.data || {};
          var seen = (data.replies || []).map(function (r) {
            return (r && typeof r === "object") ? String(r.text || "") : String(r || "");
          }).filter(Boolean);
          state.popoverDrafts = state.popoverDrafts.concat(seen).slice(-8);
          showAnalyzePopover(article, data);
        } else {
          showAnalyzePopover(article, {
            status: "error",
            message: String((err && err.message) || (resp && resp.error) || "bilinmeyen hata")
          });
        }
      });
    } catch (e) {
      showAnalyzePopover(article, { status: "error", message: String((e && e.message) || e) });
    }
  }

  // Shimmer placeholder shown while the model responds — reads as "working"
  // far better than a line of text, and keeps the card from resizing on arrival.
  function buildSkeleton() {
    var sk = document.createElement("div");
    sk.className = "xverim-skeleton";
    sk.setAttribute("aria-label", "Hazırlanıyor");
    var rows = [
      { cls: "xverim-sk-line", w: "42%" },
      { cls: "xverim-sk-card" },
      { cls: "xverim-sk-card" },
      { cls: "xverim-sk-card" }
    ];
    rows.forEach(function (row) {
      var el = document.createElement("div");
      el.className = row.cls;
      if (row.w) el.style.width = row.w;
      if (row.h) el.style.height = row.h;
      if (row.mt) el.style.marginTop = row.mt;
      sk.appendChild(el);
    });
    return sk;
  }

  // The source tweet, one line, above the drafts. With several cards open in a
  // session it stops being obvious which tweet you are answering.
  function buildTweetContext(article) {
    var wrap = document.createElement("div");
    wrap.className = "xverim-popover-source";
    var handle = D.getAuthorHandle(article);
    if (handle) {
      var h = document.createElement("span");
      h.className = "xverim-popover-source-handle";
      h.textContent = "@" + handle;
      wrap.appendChild(h);
    }
    var text = (D.getTweetText(article) || "").replace(/\s+/g, " ").trim();
    var t = document.createElement("span");
    t.className = "xverim-popover-source-text";
    t.textContent = text.length > 130 ? (text.slice(0, 130) + "…") : (text || "(metin yok)");
    wrap.appendChild(t);
    return wrap;
  }

  // One reply draft as a self-contained card: the draft (in the tweet's
  // language) in an editable field, its translation underneath, a live char
  // count, and the primary "Yanıtla" (insert into composer) + secondary copy
  // action. Only the draft text is ever posted or copied — the translation is
  // just to read. Editing here beats copying it out, fixing it, pasting back.
  function buildReplyCard(article, reply, index) {
    var text = (reply && reply.text) || "";
    var translation = (reply && reply.translation ? String(reply.translation) : "").trim();

    var li = document.createElement("li");

    var top = document.createElement("div");
    top.className = "xverim-draft-top";

    var badge = document.createElement("span");
    badge.className = "xverim-draft-index";
    badge.textContent = String(index + 1);
    badge.setAttribute("aria-hidden", "true");
    badge.title = (index + 1) + " tuşu bu taslağı yanıt kutusuna koyar";

    var body = document.createElement("textarea");
    body.className = "xverim-draft-text";
    body.value = text;
    body.rows = 1;              // autoGrow sets the real height
    body.spellcheck = false;
    body.setAttribute("aria-label", "Yanıt taslağı (düzenlenebilir)");

    top.appendChild(badge);
    top.appendChild(body);
    li.appendChild(top);

    if (translation && translation !== text) {
      var tr = document.createElement("span");
      tr.className = "xverim-popover-angle-tr";
      tr.textContent = translation;
      li.appendChild(tr);
    }

    var actions = document.createElement("span");
    actions.className = "xverim-popover-angle-actions";

    var count = document.createElement("span");
    count.className = "xverim-char-count";

    function currentText() { return body.value.trim(); }
    function autoGrow() {
      body.style.height = "auto";
      body.style.height = body.scrollHeight + "px";
    }
    function refreshCount() {
      var len = body.value.length;
      count.textContent = len;
      count.classList.toggle("xverim-char-warn", len > 240 && len <= 280);
      count.classList.toggle("xverim-char-over", len > 280);
    }
    body.addEventListener("input", function () { refreshCount(); autoGrow(); });

    var group = document.createElement("span");
    group.className = "xverim-popover-btn-group";

    // Primary: drop the draft straight into X's reply composer.
    var replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.className = "xverim-reply-btn";
    replyBtn.innerHTML = REPLY_ICON + '<span>Yanıtla</span>';
    replyBtn.title = "Bu taslakla yanıt kutusunu aç";
    replyBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var out = currentText();
      if (!out) { showToast("Taslak boş.", { kind: "warn" }); return; }
      closePopover();
      replyWithText(article, out);
    });

    // Escape steps out of the field first (so the card survives a stray Esc);
    // Cmd/Ctrl+Enter sends the edited draft on to the composer.
    body.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.stopPropagation(); body.blur(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        replyBtn.click();
      }
    });

    // Secondary: copy, for when you'd rather paste it elsewhere.
    var copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "xverim-copy-btn";
    copyBtn.setAttribute("aria-label", "Kopyala");
    copyBtn.title = "Kopyala";
    copyBtn.innerHTML = COPY_ICON;
    bindCopyButton(copyBtn, currentText);

    group.appendChild(replyBtn);
    group.appendChild(copyBtn);
    actions.appendChild(count);
    actions.appendChild(group);
    li.appendChild(actions);

    refreshCount();
    // scrollHeight is 0 until the element is in the document.
    window.requestAnimationFrame(autoGrow);
    return li;
  }

  // Build just the scrollable content region for a given data object. Kept
  // separate so re-runs can swap it in place without tearing down and
  // repositioning the whole card (that's what makes the reload feel smooth).
  function buildPopoverContent(article, data) {
    var content = document.createElement("div");
    content.className = "xverim-popover-content";
    content.setAttribute("data-bind", "content");

    var status = data.status;  // "loading" | "error" | undefined (=result)
    // Replies are {text, translation}; tolerate a bare string too.
    var replies = Array.isArray(data.replies) ? data.replies.map(function (r) {
      if (r && typeof r === "object") {
        return { text: String(r.text || "").trim(), translation: String(r.translation || "").trim() };
      }
      return { text: String(r || "").trim(), translation: "" };
    }).filter(function (r) { return r.text; }) : [];

    if (status === "loading") {
      content.appendChild(buildSkeleton());
      return content;
    }
    if (status === "error") {
      var errEl = document.createElement("div");
      errEl.className = "xverim-popover-status xverim-popover-error";
      errEl.textContent = "Bir sorun oldu: " + (data.message || "bilinmeyen hata");
      content.appendChild(errEl);
      content.appendChild(buildRetryButton(article));
      return content;
    }

    var rSection = document.createElement("div");
    rSection.className = "xverim-popover-section";
    var rLabel = document.createElement("div");
    rLabel.className = "xverim-popover-label";
    rLabel.textContent = "Yanıt taslakları";
    rSection.appendChild(rLabel);

    if (!replies.length) {
      var none = document.createElement("div");
      none.className = "xverim-popover-empty";
      none.textContent = "Bu tweet için taslak çıkmadı.";
      rSection.appendChild(none);
      rSection.appendChild(buildRetryButton(article));
    } else {
      var ul = document.createElement("ul");
      ul.className = "xverim-popover-list";
      replies.forEach(function (reply, i) { ul.appendChild(buildReplyCard(article, reply, i)); });
      rSection.appendChild(ul);
      var hint = document.createElement("div");
      hint.className = "xverim-popover-hint";
      hint.textContent = "Taslakları düzenleyebilirsin · 1-" + replies.length + " tuşları yanıt kutusuna koyar";
      rSection.appendChild(hint);
    }
    content.appendChild(rSection);
    return content;
  }

  function buildRetryButton(article) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "xverim-ghost-btn";
    btn.textContent = "Tekrar dene";
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      runAnalyze(article);
    });
    return btn;
  }

  // Anchor the card to the right of the tweet, flipping / clamping to stay in
  // the viewport. Called on open and after any in-place content swap.
  function repositionPopover(pop, article) {
    if (!pop || !article) return;
    var r = article.getBoundingClientRect();
    var pw = pop.offsetWidth || 340;
    var ph = pop.offsetHeight || 200;
    var left = window.scrollX + r.right + 10;
    var top = window.scrollY + r.top;
    if (left + pw > window.scrollX + window.innerWidth - 8) left = window.scrollX + r.left - pw - 10;
    if (left < window.scrollX + 8) left = window.scrollX + 8;
    if (top + ph > window.scrollY + window.innerHeight - 8) top = window.scrollY + window.innerHeight - ph - 8;
    if (top < window.scrollY + 8) top = window.scrollY + 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function showAnalyzePopover(article, data) {
    if (!article) return;
    data = data || {};

    // Re-run on the same tweet while the card is open (loading → result, or the
    // ↻ button): swap only the content so the card never flashes or jumps.
    if (state.popoverEl && state.popoverArticle === article && state.popoverEl.isConnected) {
      var open = state.popoverEl;
      var old = open.querySelector("[data-bind='content']");
      var fresh = buildPopoverContent(article, data);
      if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
      else open.appendChild(fresh);
      repositionPopover(open, article);
      return;
    }

    closePopover();

    var pop = document.createElement("div");
    pop.className = "xverim-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "X Verim öneriler");

    var header = document.createElement("div");
    header.className = "xverim-popover-header";
    header.innerHTML = ''
      + '<span class="xverim-popover-title">' + SPARK_ICON + '<span>Öneriler</span></span>'
      + '<span class="xverim-popover-header-actions">'
      +   '<button type="button" class="xverim-icon-btn" data-act="regen" aria-label="Yeniden üret" title="Yeniden üret">' + REFRESH_ICON + '</button>'
      +   '<button type="button" class="xverim-icon-btn" data-act="close" aria-label="Kapat" title="Kapat">' + CLOSE_ICON + '</button>'
      + '</span>';

    header.querySelector("[data-act='close']").addEventListener("click", closePopover);
    header.querySelector("[data-act='regen']").addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      runAnalyze(article, { regenerate: true });
    });

    pop.appendChild(header);
    pop.appendChild(buildTweetContext(article));
    pop.appendChild(buildPopoverContent(article, data));

    (document.body || document.documentElement).appendChild(pop);
    state.popoverEl = pop;
    state.popoverArticle = article;
    repositionPopover(pop, article);
  }
  // Click outside / Esc dismisses the popover, then the panel. X's own dialogs
  // keep Escape to themselves — we never preventDefault, and we don't steal the
  // keypress that was meant to close a reply modal.
  document.addEventListener("mousedown", function (e) {
    if (state.popoverEl && !state.popoverEl.contains(e.target)) closePopover();
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (state.popoverEl) { closePopover(); return; }
    if (state.panelEl && state.panelEl.classList.contains("xverim-open") && !xDialogOpen()) togglePanel(false);
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
    var label = (kind === "like") ? "beğeni" : (kind === "follow") ? "takip" : "işlem";
    el.innerHTML = ''
      + '<span class="xverim-banner-text">'
      +   '<svg class="xverim-banner-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
      +     '<path d="M8 1.5 L15 14 L1 14 Z" fill="currentColor"/>'
      +     '<text x="8" y="12" text-anchor="middle" font-size="9" font-weight="700" fill="#1d9bf0">!</text>'
      +   '</svg>'
      +   'Hız kontrolü: son bir saatte ' + (limit == null ? "?" : limit) + ' ' + label + ' sınırını aştın. Biraz yavaşla — bu senin hesabın.'
      + '</span>'
      + '<button class="xverim-banner-close" aria-label="Kapat">'
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
    // A resize moves the tweet the card is anchored to, and can strand a panel
    // that was dragged to what used to be the right edge.
    window.addEventListener("resize", function () {
      if (state.popoverEl && state.popoverArticle) repositionPopover(state.popoverEl, state.popoverArticle);
      if (state.panelEl) applyPanelPos();
    });
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
