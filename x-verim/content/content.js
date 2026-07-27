// X Verim content script — runs in the x.com page at document_idle.
// Modules (in order):
//   1. Focus model         — pick the timeline article closest to viewport center
//   2. Keyboard shortcuts  — j/k/l/f/s/a/r/v, read from config.SHORTCUTS
//   3. Insert draft        — page-world Draft.js paste bridge (no native DOM writes)
//   4. Niche filter        — MutationObserver + rAF sweep, dim/hide/highlight
//   5. Floating panel      — filter toggle + counters, draggable
//   6. Analyze popover     — small dark card: translation + reply drafts (a)
//   7. Scheduled posts     — user-planned message lists, posted in-window
//   8. Guardrail banner    — non-blocking warning when pace exceeds the limit
//
// HARD RULE: never auto-click submit (tweetButton / tweetButtonInline) —
//   except the scheduler posting a message the user planned themselves, at
//   the time they chose. That path is opt-in and the only one allowed to click.
// HARD RULE: only use data-testid / role / aria-label selectors (lib/x-dom.js).
(function () {
  "use strict";
  if (window.__XVERIM_LOADED__) return;
  window.__XVERIM_LOADED__ = true;

  var C = window.XVERIM_CONFIG || {};
  var D = window.XVerimDom || {};
  var SC = C.SHORTCUTS || {};
  var FILTER = C.FILTER || { enabled: true };
  // Read live, not once: someone who turns motion down mid-session shouldn't
  // have to reload the tab to get instant jumps instead of smooth ones.
  var MOTION_QUERY = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var REDUCED_MOTION = !!(MOTION_QUERY && MOTION_QUERY.matches);
  if (MOTION_QUERY && MOTION_QUERY.addEventListener) {
    MOTION_QUERY.addEventListener("change", function (e) { REDUCED_MOTION = !!e.matches; });
  }

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
    // The active-tweet marker: one floating wrapper holding the accent bar and
    // its label, so both are placed from a single measurement per frame.
    markEl: null,
    barEl: null,
    focusBadgeEl: null,
    markVisible: false,
    markEnter: false,
    // A j/k jump or a click is a deliberate pick: it stays put while you can
    // still see the tweet, instead of the reading line re-picking under you.
    explicitFocus: false,
    // Holds that pick through a smooth scroll, while the target is still
    // off-screen and the reading line would grab whatever we pass over.
    focusLock: null,
    // Drafts currently on screen, fed back to the model on ↻ so a re-run
    // produces new angles instead of the same three sentences reworded.
    popoverDrafts: [],
    // How many under-the-tweet replies were sent along as context (detail page
    // only) — surfaced in the card so it is visible that the thread was read.
    popoverReplyCtx: 0,
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
  var HEADER_FALLBACK = 56;      // used only when the sticky bar can't be found
  var FOCUS_LINE_RATIO = 0.35;   // the "reading line", as a share of the viewport
  var FOCUS_BAND_RATIO = 0.12;   // hysteresis around it

  function viewportH() { return window.innerHeight || document.documentElement.clientHeight || 0; }

  // X's sticky top bar is a different height per view — the home timeline adds
  // the "For you / Following" tabs under the heading — so the line the ring has
  // to stay clear of is measured, not assumed. A hardcoded 56 let the ring paint
  // across the tabs whenever a tall tweet scrolled up behind them.
  // Memoised: this only really changes on route change and resize.
  var headerSafeCache = HEADER_FALLBACK;
  var headerSafeAt = 0;
  function stickyBottom(parent, depth) {
    var out = 0;
    if (!parent || depth < 0) return out;
    var kids = parent.children;
    for (var i = 0; kids && i < kids.length && i < 8; i++) {
      var el = kids[i];
      var cs;
      try { cs = window.getComputedStyle(el); } catch (_) { continue; }
      if (cs.position === "sticky" || cs.position === "fixed") {
        var r = el.getBoundingClientRect();
        // Only a bar currently pinned across the top counts: a sticky element
        // further down the column, or a tall sticky sidebar, is not something
        // the ring has to stay clear of.
        if (r.top <= 24 && r.bottom > out && r.bottom <= 240) out = r.bottom;
      } else if (depth > 0) {
        out = Math.max(out, stickyBottom(el, depth - 1));
      }
    }
    return out;
  }
  function headerSafe() {
    var now = Date.now();
    if (now - headerSafeAt < 500) return headerSafeCache;
    headerSafeAt = now;
    var col = document.querySelector(D.SELECTORS.primaryColumn);
    var found = col ? stickyBottom(col, 2) : 0;
    headerSafeCache = found > 0 ? Math.round(found) : HEADER_FALLBACK;
    return headerSafeCache;
  }

  function readingLine(vh) { return Math.max(headerSafe() + 32, vh * FOCUS_LINE_RATIO); }

  // Rebuilt on DOM change, not on every scroll frame: X mutates the timeline
  // constantly but not 60 times a second, and re-running querySelectorAll over
  // the whole document per frame was the reason scrolling felt heavy.
  //
  // The TTLs are the safety net. Attaching the MutationObserver is allowed to
  // fail (it's wrapped in a try), and without a fallback both caches would then
  // be frozen for the life of the tab — the extension would silently stop
  // seeing new tweets. Two extra queries a second is a cheap price for that.
  var ARTICLES_TTL = 500;
  var DIALOG_TTL = 250;
  var articlesDirty = true;
  var articlesAt = 0;
  var dialogDirty = true;
  var dialogAt = 0;
  var dialogOpenCache = false;

  function collectArticles() {
    var out = [];
    var root = document.querySelector(D.SELECTORS.primaryColumn) || document.body;
    if (!root) return out;
    var found;
    try { found = root.querySelectorAll(D.SELECTORS.tweet); } catch (_) { return out; }
    for (var i = 0; i < found.length; i++) {
      // The tweet X copies into its reply / quote dialog matches the same
      // selector but is not a row you navigate: focusing one drew the ring on
      // top of an overlay and left a detached "active tweet" behind when the
      // dialog closed.
      if (found[i].closest && found[i].closest('[role="dialog"]')) continue;
      out.push(found[i]);
    }
    return out;
  }
  function getArticles() {
    var now = Date.now();
    if (articlesDirty || !state.articles || now - articlesAt > ARTICLES_TTL) {
      state.articles = collectArticles();
      articlesDirty = false;
      articlesAt = now;
      // React recycles DOM nodes, so a row can be remounted still carrying our
      // class — which showed two tweets as active at once.
      var marked = document.querySelectorAll(".xverim-focused");
      for (var i = 0; i < marked.length; i++) {
        if (marked[i] !== state.focusedTweet) marked[i].classList.remove("xverim-focused");
      }
    }
    return state.articles;
  }

  // A *visible* X dialog (reply / compose / media viewer) — deliberately not
  // our own panel/popover, which also carry role="dialog" and would otherwise
  // keep the ring hidden for good once opened. Cached per DOM change:
  // getClientRects forces layout, and this is read on every scroll frame.
  function xDialogOpen() {
    var now = Date.now();
    if (!dialogDirty && now - dialogAt <= DIALOG_TTL) return dialogOpenCache;
    dialogDirty = false;
    dialogAt = now;
    dialogOpenCache = false;
    var dialogs = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      var d = dialogs[i];
      if (d.classList.contains("xverim-panel") || d.classList.contains("xverim-popover")) continue;
      if (d.getClientRects && d.getClientRects().length) { dialogOpenCache = true; break; }  // rendered
    }
    return dialogOpenCache;
  }

  // One rect read per article per pass. The old pair of isFocusable() +
  // focusLineDist() measured the same element twice, and layout reads are the
  // expensive half of a scroll frame.
  //
  // null  → can't hold focus at all (unmounted, filtered out, no box)
  // dist  → distance to the reading line; 0 when the row crosses it, Infinity
  //         when the row is off-screen (behind the sticky header counts as off).
  function measure(article, vh, line) {
    if (!article || !article.isConnected) return null;
    if (article.classList.contains("xverim-hide")) return null;
    var r = article.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    var safe = headerSafe();
    var offEdge = (r.top <= line && r.bottom >= line) ? 0
                : (r.top > line ? r.top - line : line - r.bottom);
    return {
      rect: r,
      edge: offEdge,
      dist: (r.bottom <= safe || r.top >= vh) ? Infinity : offEdge,
      visible: Math.min(r.bottom, vh) - Math.max(r.top, safe)
    };
  }

  // The active tweet is the one crossing a reading line above the viewport's
  // middle — that reads as the tweet you're actually looking at, and stays
  // right even for a tweet taller than the viewport (whose real midpoint would
  // be off-screen). Two things keep it from flickering: a deliberate pick holds
  // while a real part of it is still visible, and everything else gets a band
  // of hysteresis so neighbours can't flip-flop on the boundary.
  function pickFocused(list, current, vh, line) {
    var m;
    if (current) {
      m = measure(current, vh, line);
      if (m) {
        if (state.explicitFocus && m.visible >= Math.min(80, m.rect.height)) return current;
        // Scaled to the row, not just the viewport: a flat 12% of the window is
        // wider than a short tweet, so the ring could sit a whole row away from
        // the line it's supposed to track. A tall row still gets the full band —
        // it fills the screen anyway, and nothing else is competing for it.
        var band = Math.min(vh * FOCUS_BAND_RATIO, Math.max(40, m.rect.height * 0.4));
        if (m.dist <= band) return current;
      }
    }
    var best = null, bestDist = Infinity;
    for (var i = 0; i < list.length; i++) {
      m = measure(list[i], vh, line);
      if (!m || m.dist >= bestDist) continue;
      bestDist = m.dist;
      best = list[i];
    }
    return best;
  }
  // Where "start here" is, when nothing is active yet: nearest to the reading
  // line whether or not it's on screen, so a gap between loaded rows lands on
  // the closest one instead of the end of the timeline.
  function nearestArticle(list, vh, line) {
    var best = null, bestEdge = Infinity;
    for (var i = 0; i < list.length; i++) {
      var m = measure(list[i], vh, line);
      if (!m || m.edge >= bestEdge) continue;
      bestEdge = m.edge;
      best = list[i];
    }
    return best;
  }

  function applyFocus() {
    var vh = viewportH();
    var line = readingLine(vh);
    var lock = state.focusLock;
    if (lock) {
      var lm = lock.article.isConnected ? measure(lock.article, vh, line) : null;
      // Released the moment the target actually reaches the line (or when the
      // backstop expires), so the next scroll is live again instead of waiting
      // out a fixed timer.
      if (!lm || lm.dist === 0 || Date.now() > lock.until) state.focusLock = null;
      else { paintFocus(); return; }
    }
    var next = pickFocused(getArticles(), state.focusedTweet, vh, line);
    if (next !== state.focusedTweet) setFocus(next, null);
    else paintFocus();   // same row, new position: scrolling moved it
  }

  // The single place that changes which tweet is active.
  function setFocus(article, opts) {
    var o = opts || {};
    var prev = state.focusedTweet;
    if (prev && prev !== article) prev.classList.remove("xverim-focused");
    state.focusedTweet = article || null;
    if (state.focusedTweet) state.focusedTweet.classList.add("xverim-focused");
    if (prev !== state.focusedTweet) state.markEnter = true;
    // Always assigned: a passive re-pick has to drop the stickiness a previous
    // j/k or click earned, or the new row would inherit it.
    state.explicitFocus = !!o.explicit;
    if (o.scroll && state.focusedTweet) {
      scrollArticleToLine(state.focusedTweet);
      state.focusLock = { article: state.focusedTweet, until: Date.now() + (REDUCED_MOTION ? 150 : 900) };
    }
    paintFocus();
  }

  // ---------- Active-tweet marker ----------
  // Drawn as a floating element rather than styles on X's own article: it can't
  // be faded by the niche filter's opacity, can't be clipped by the row, and
  // can't fight X's hover backgrounds.
  //
  // Deliberately small. A full ring around the row was unmistakable but loud —
  // it fenced off a card X doesn't draw as a card. The signal is the row's faint
  // tint; this is just the edge marker that makes it unambiguous.
  function ensureMark() {
    if (state.markEl && state.markEl.isConnected) return state.markEl;
    var wrap = document.createElement("div");
    wrap.className = "xverim-active-mark";
    wrap.setAttribute("aria-hidden", "true");

    var bar = document.createElement("div");
    bar.className = "xverim-active-bar";
    wrap.appendChild(bar);

    var badge = document.createElement("div");
    badge.className = "xverim-focus-badge";
    // The hint is what makes the label teach the extension instead of just
    // marking a tweet — and it follows the configured key, not a hardcoded "a".
    var analyzeKey = String(SC.analyze || "").toUpperCase();
    badge.textContent = analyzeKey ? ("Aktif tweet · " + analyzeKey + " taslak") : "Aktif tweet";
    wrap.appendChild(badge);

    (document.body || document.documentElement).appendChild(wrap);
    state.markEl = wrap;
    state.barEl = bar;
    state.focusBadgeEl = badge;
    state.markVisible = false;
    return wrap;
  }
  function hideMark() {
    if (state.markEl && state.markVisible) {
      state.markEl.style.display = "none";
      state.markVisible = false;
    }
  }
  function playMarkEnter() {
    var bar = state.barEl;
    if (!bar || REDUCED_MOTION || !bar.animate) return;
    // The bar grows into place at the new row, rather than tweening from the old
    // one: a tween would have to race the scroll it happens during, and lose.
    // Starts visible, not from zero: a document whose timeline is paused (a
    // backgrounded tab) holds an animation in its active phase indefinitely, and
    // a keyframe of opacity 0 would then be a bar that never appears. At 0.35
    // the worst case is a dimmer bar, and the 160ms fade looks the same.
    try {
      bar.animate(
        [{ opacity: 0.35, transform: "scaleY(0.4)" }, { opacity: 1, transform: "scaleY(1)" }],
        { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
      );
    } catch (_) {}
  }

  var BAR_MIN = 20, BAR_MAX = 56, BAR_INSET = 12;
  function paintFocus() {
    var article = state.focusedTweet;
    // Hidden entirely while a modal is open (reply / compose): the timeline sits
    // behind the overlay, and a marker floating over the dialog looks broken.
    if (!article || !article.isConnected || xDialogOpen()) { hideMark(); return; }
    var vh = viewportH();
    var r = article.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { hideMark(); return; }
    var safe = headerSafe();
    // The part of the row you can actually see, between X's sticky header and
    // the fold. Everything below is placed inside it, which is what keeps the
    // marker off the header without needing to clip anything.
    var visTop = Math.max(r.top, safe);
    var visBottom = Math.min(r.bottom, vh);
    if (visBottom - visTop < 16) { hideMark(); return; }

    var wrap = ensureMark();
    if (!state.markVisible) { wrap.style.display = "block"; state.markVisible = true; }
    // transform (not top/left) so tracking the scroll stays on the compositor.
    wrap.style.transform = "translate3d(" + Math.round(r.left) + "px, " + Math.round(r.top) + "px, 0)";
    wrap.style.width = Math.round(r.width) + "px";
    wrap.style.height = Math.round(r.height) + "px";

    // Centred on what's visible, not on the row: a tweet taller than the window
    // would otherwise put its marker off-screen while it is the active one.
    var band = visBottom - visTop;
    var barH = Math.max(BAR_MIN, Math.min(BAR_MAX, band - BAR_INSET));
    if (barH > band) barH = band;   // a sliver of a row still can't overhang it
    state.barEl.style.height = Math.round(barH) + "px";
    state.barEl.style.top = Math.round((visTop + visBottom) / 2 - barH / 2 - r.top) + "px";

    // The label rides the row's top edge, and drops just inside the row once
    // that edge has scrolled up under the header.
    var underHeader = Math.max(0, Math.round(safe - r.top));
    state.focusBadgeEl.style.top = (r.top - safe < 12 ? (underHeader + 6) : -9) + "px";

    if (state.markEnter) {
      state.markEnter = false;
      playMarkEnter();
    }
  }

  function scheduleFocus() {
    if (state.rafId != null) return;
    state.rafId = window.requestAnimationFrame(function () {
      state.rafId = null;
      applyFocus();
    });
  }

  // Any real scroll gesture hands control back to the reading line. Keyed off
  // input events, not the scroll event, because our own smooth scroll fires
  // that too — and it must not cancel the pick it was made for.
  var SCROLL_KEYS = { " ": 1, PageUp: 1, PageDown: 1, Home: 1, End: 1, ArrowUp: 1, ArrowDown: 1 };
  function releaseExplicitFocus() {
    if (!state.explicitFocus && !state.focusLock) return;
    state.explicitFocus = false;
    state.focusLock = null;
    scheduleFocus();
  }

  function startFocusObserver() {
    applyFocus();
    window.addEventListener("scroll", scheduleFocus, { passive: true });
    window.addEventListener("resize", scheduleFocus);
    window.addEventListener("wheel", releaseExplicitFocus, { passive: true });
    window.addEventListener("touchmove", releaseExplicitFocus, { passive: true });
  }

  // One observer for the whole extension: rows appearing, dialogs opening and
  // route changes are all the same signal — "the DOM moved, re-measure".
  var OUR_UI = ".xverim-active-mark, .xverim-toasts, .xverim-popover, .xverim-panel, .xverim-banner";
  function onlyOurUi(records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (!t || t.nodeType !== 1 || !t.closest || !t.closest(OUR_UI)) return false;
    }
    return true;
  }
  function startDomObserver() {
    try {
      var mo = new MutationObserver(function (records) {
        // A toast or a popover of ours must not cost a full timeline sweep.
        if (onlyOurUi(records)) return;
        articlesDirty = true;
        dialogDirty = true;
        // Filter first: it decides what's hidden, and focus must not land on a
        // row that this same frame removes.
        scheduleFilterSweep();
        scheduleFocus();
      });
      // document.body, not the primary column: X replaces that node on route
      // changes, and an observer bound to the old one goes quietly dead.
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
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
      var arts = getArticles();
      for (var i = 0; i < arts.length; i++) applyFilter(arts[i]);
    });
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

  // Land the row straddling the same reading line pickFocused measures against.
  // scrollIntoView({block:"center"}) put it somewhere else, so the tweet you
  // jumped to could measure *further* from the line than its neighbour and lose
  // the highlight the moment the scroll settled.
  function scrollArticleToLine(article) {
    if (!article) return;
    var vh = viewportH();
    var line = readingLine(vh);
    var r = article.getBoundingClientRect();
    var desiredTop = line - Math.min(r.height, vh * 0.5) / 2;
    var minTop = headerSafe() + 8;
    if (desiredTop < minTop) desiredTop = minTop;
    var top = window.scrollY + r.top - desiredTop;
    var max = Math.max(0, (document.documentElement.scrollHeight || 0) - vh);
    top = Math.max(0, Math.min(max, top));
    try {
      window.scrollTo({ top: top, behavior: REDUCED_MOTION ? "auto" : "smooth" });
    } catch (_) {
      try { window.scrollTo(0, top); } catch (__) {}
    }
  }

  function focusableArticles(vh, line) {
    var list = getArticles();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (measure(list[i], vh, line)) out.push(list[i]);
    }
    return out;
  }

  function moveFocus(delta) {
    var vh = viewportH();
    var line = readingLine(vh);
    var list = focusableArticles(vh, line);
    if (!list.length) {
      showToast("Gezinecek tweet yok — akış henüz yüklenmemiş olabilir.", { kind: "warn" });
      return;
    }
    var idx = state.focusedTweet ? list.indexOf(state.focusedTweet) : -1;
    if (idx < 0) {
      // Nothing active, or the active tweet was filtered out / unmounted: land
      // on the row nearest the reading line rather than stepping from an index
      // we no longer have. Stepping from a lost index used to send `k` to the
      // very last loaded tweet, far below the fold.
      setFocus(nearestArticle(list, vh, line) || list[0], { scroll: true, explicit: true });
      return;
    }
    var next = Math.max(0, Math.min(list.length - 1, idx + delta));
    setFocus(list[next], { scroll: true, explicit: true });
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
    // Scrolling by keyboard counts as scrolling away: the reading line takes
    // over again, exactly as it would after a wheel gesture.
    if (SCROLL_KEYS[e.key]) releaseExplicitFocus();
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
        btn.title = ok ? "Kopyalandı" : "Kopyalanamadı";
        setTimeout(function () {
          btn.classList.remove("xverim-copy-ok");
          btn.innerHTML = COPY_ICON;
          btn.title = "Kopyala";
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
    state.popoverReplyCtx = 0;
  }

  // A tweet's own page — /<handle>/status/<id> — where the conversation under
  // it is actually on screen. The home timeline never matches.
  function isTweetDetailPage() {
    return /^\/[^/]+\/status\/\d+/.test(window.location.pathname);
  }

  // The replies already visible under the analyzed tweet, on its detail page
  // only. Walked cell by cell (not via getArticles) so the collection stops at
  // the first section heading — X appends a "Discover more" block of unrelated
  // tweets after the conversation, and those must not be read as replies.
  function collectReplyContext(article) {
    if (!isTweetDetailPage()) return [];
    var cell = article.closest && article.closest(D.SELECTORS.cellInnerDiv);
    if (!cell) return [];
    var out = [];
    var node = cell.nextElementSibling;
    while (node && out.length < 10) {
      if (node.querySelector) {
        if (node.querySelector("h2")) break;  // "Discover more" — conversation ended
        var art = node.querySelector(D.SELECTORS.tweet);
        if (art) {
          var text = (D.getTweetText(art) || "").replace(/\s+/g, " ").trim();
          if (text) out.push({ handle: D.getAuthorHandle(art) || "", text: text.slice(0, 280) });
        }
      }
      node = node.nextElementSibling;
    }
    return out;
  }

  // Kick off (or re-run) the AI pass for a tweet and drive the popover through
  // its loading / error / result states. The regenerate button reuses this and
  // passes what's already on screen, so ↻ means "different ones", not "again".
  function runAnalyze(article, options) {
    if (!article) return;
    var regenerate = !!(options && options.regenerate);
    if (!regenerate) state.popoverDrafts = [];
    var contextReplies = collectReplyContext(article);
    state.popoverReplyCtx = contextReplies.length;
    var payload = {
      text: D.getTweetText(article),
      authorHandle: D.getAuthorHandle(article),
      counts: D.getCountsFromGroup(article),
      replies: contextReplies,
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
    // On a detail page the drafts were written with the visible replies as
    // context — say so, or the feature is indistinguishable from not existing.
    rLabel.textContent = state.popoverReplyCtx > 0
      ? ("Yanıt taslakları · " + state.popoverReplyCtx + " yanıt okundu")
      : "Yanıt taslakları";
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
    // Pointing at a tweet makes it the active one. Acting with l / f / s on a
    // row other than the one you just clicked is the worst kind of wrong, and
    // the reading line alone had no way to know where you were looking.
    var article = D.getTweetArticle ? D.getTweetArticle(e.target) : null;
    if (article && getArticles().indexOf(article) >= 0) {
      setFocus(article, { explicit: true });
    }
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (state.popoverEl) { closePopover(); return; }
    if (state.panelEl && state.panelEl.classList.contains("xverim-open") && !xDialogOpen()) togglePanel(false);
  });

  // ============== Scheduled posts (Planlama) ==============
  // Posts the user planned in the popup's Planlama card: message lists split
  // on |, one post per matching day at a random minute inside the chosen
  // window. This is the single, deliberate exception to the "never auto-click
  // submit" rule — the human chose the text and the window; we only pick the
  // minute. Opt-in, off by default.
  //
  // Server-side, so the machine does not have to be on. Each slot is handed to
  // X's OWN scheduled-posts system through the same CreateScheduledTweet
  // GraphQL call its composer makes behind "Gönderiyi planla" — authorised by
  // the user's session cookies, which we never read. Once registered the post
  // lives in X's queue (Planlanan gönderiler, g+t) and goes out with the
  // browser closed; a tab only has to be open long enough to register it,
  // which is why slots are booked up to a week ahead.
  //
  // X rotates the GraphQL operation id on their deploys, so a stale id is
  // expected rather than exceptional: a 400/404 triggers one rediscovery pass
  // over the bundles this page already loaded, and the fresh id is cached.
  //
  // Two storage keys on purpose: the popup owns the plan (rules + master
  // switch), this script owns the runtime state (what has been handled). One
  // shared key would let a popup save clobber an in-flight claim.
  var SCHED_RULES_KEY = "xverim_schedule_v1";
  var SCHED_STATE_KEY = "xverim_schedule_state_v1";
  var SCHED_QID_KEY = "xverim_sched_qid_v1";   // discovered {qid, bearer}
  var SCHED_TICK_MS = 30000;
  var SCHED_MAX_PER_TICK = 4;   // registrations per pass, spaced — not a burst
  var SCHED_MAX_PENDING = 40;   // outstanding registrations — pace beats reach
  var SCHED_MIN_LEAD_MIN = 5;   // X rejects an execute_at that is nearly now
  var SCHED_LOOKAHEAD_DAYS = 7; // how far ahead slots are handed to X
  // X's public web-app token. It ships in x.com's own JS for every visitor and
  // identifies the client, not the person — the session cookie is what proves
  // who you are. Verified against the operation id in the same bundle.
  var SCHED_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  var SCHED_CREATE_QID_DEFAULT = "LCVzRQGxOaGnOnYH01NQXg";
  // Random instance id: content scripts can't see their tab id, and the claim
  // written below has to be attributable to one of them.
  var schedInstanceId = "t" + Math.random().toString(36).slice(2, 10);
  var schedTimer = null;
  var schedBusy = false;
  var schedWarned = false;   // one failure toast per tab, not one per tick

  function schedStorageGet(keys) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(keys, function (d) { resolve(d || {}); }); }
      catch (_) { resolve({}); }
    });
  }
  function schedStorageSet(obj) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set(obj, function () { resolve(); }); }
      catch (_) { resolve(); }
    });
  }

  function schedParseHM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    var v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return (v >= 0 && v < 1440) ? v : null;
  }
  function schedDayKey(d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  // days: "all" | "wd" (Mon-Fri) | "we" (Sat-Sun) | "0".."6" (JS getDay, 0=Sunday)
  function schedDayMatches(days, date) {
    var dow = (date || new Date()).getDay();
    if (!days || days === "all") return true;
    if (days === "wd") return dow >= 1 && dow <= 5;
    if (days === "we") return dow === 0 || dow === 6;
    return String(dow) === String(days);
  }
  // One message per line — that is just the Enter key, whereas "|" is a
  // three-finger gymnastic on a Turkish layout. Pipes still split, so a list
  // pasted from somewhere else keeps working.
  function schedMessages(rule) {
    return String(rule.messages || "").split(/[\n|]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  // ---- X's GraphQL scheduler ----
  // Same call x.com's own composer makes when you pick "Gönderiyi planla":
  // CreateScheduledTweet, with {post_tweet_request, execute_at} and the tweet's
  // rest_id back. It runs from this page, so the user's own cookies authorise
  // it and no credential of theirs is ever read, stored or sent anywhere else.
  function schedCsrfToken() {
    var m = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie || "");
    return m ? decodeURIComponent(m[1]) : "";
  }

  // The operation id is baked into whichever bundle X shipped today, so it
  // changes under us on their deploys. Read it out of the bundles this very
  // page loaded rather than pinning a constant that silently rots.
  function schedDiscoverQid() {
    var urls = [];
    try {
      var entries = performance.getEntriesByType("resource") || [];
      for (var i = 0; i < entries.length; i++) {
        var u = entries[i].name || "";
        if (u.indexOf("abs.twimg.com") >= 0 && /Scheduling|Compose|main\./.test(u) && /\.js($|\?)/.test(u)) {
          urls.push(u);
        }
      }
    } catch (_) {}
    // Newest-looking first: the scheduling chunk is the one that defines it.
    urls.sort(function (a, b) { return (b.indexOf("Scheduling") >= 0) - (a.indexOf("Scheduling") >= 0); });
    var idx = 0;
    function next() {
      if (idx >= urls.length || idx >= 4) return Promise.resolve("");
      return fetch(urls[idx++]).then(function (r) { return r.ok ? r.text() : ""; }).then(function (src) {
        var m = /queryId:"([\w-]{12,})",operationName:"CreateScheduledTweet"/.exec(src)
             || /operationName:"CreateScheduledTweet"[^}]*?queryId:"([\w-]{12,})"/.exec(src);
        return m ? m[1] : next();
      }).catch(next);
    }
    return next();
  }

  function schedGraphQL(qid, text, executeAtMs) {
    var csrf = schedCsrfToken();
    if (!csrf) return Promise.reject(new Error("oturum bulunamadı, x.com'a giriş yapılı olmalı"));
    return fetch("https://x.com/i/api/graphql/" + qid + "/CreateScheduledTweet", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + SCHED_BEARER,
        "x-csrf-token": csrf,
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-active-user": "yes"
      },
      body: JSON.stringify({
        variables: {
          post_tweet_request: {
            auto_populate_reply_metadata: false,
            exclude_reply_user_ids: [],
            media_ids: [],
            status: text
          },
          execute_at: Math.floor(executeAtMs / 1000)
        },
        queryId: qid
      })
    }).then(function (res) {
      return res.text().then(function (body) {
        var data = null;
        try { data = JSON.parse(body); } catch (_) {}
        if (res.status === 404 || res.status === 400) {
          var err = new Error("işlem kimliği eskimiş (" + res.status + ")");
          err.staleQid = true;
          throw err;
        }
        if (!res.ok) throw new Error("X " + res.status);
        if (data && data.errors && data.errors.length) {
          throw new Error(String(data.errors[0].message || "X hatası"));
        }
        var id = data && data.data && data.data.tweet && data.data.tweet.rest_id;
        if (!id) throw new Error("X bir plan kimliği döndürmedi");
        return String(id);
      });
    });
  }

  // Register once, retrying exactly once with a freshly discovered operation
  // id. Two attempts max — a loop here would mean duplicate scheduled posts.
  function schedRegister(text, executeAtMs) {
    return schedStorageGet([SCHED_QID_KEY]).then(function (d) {
      var qid = (d[SCHED_QID_KEY] && d[SCHED_QID_KEY].qid) || SCHED_CREATE_QID_DEFAULT;
      return schedGraphQL(qid, text, executeAtMs).catch(function (e) {
        if (!e || !e.staleQid) throw e;
        return schedDiscoverQid().then(function (fresh) {
          if (!fresh || fresh === qid) throw e;
          var patch = {};
          patch[SCHED_QID_KEY] = { qid: fresh, at: Date.now() };
          return schedStorageSet(patch).then(function () {
            return schedGraphQL(fresh, text, executeAtMs);
          });
        });
      });
    });
  }

  // ---- Planning pass ----
  // For every rule, make sure each matching day in the lookahead window already
  // has a slot registered with X. Once registered the browser is out of the
  // loop entirely — X posts it whether or not this machine is even on.
  // A minute that doesn't look chosen by a machine. Uniform inside the window,
  // then nudged off the quarter-hours: a uniform draw lands on :00 or :30 often
  // enough that, across a month of posts, the round ones are the only thing
  // anybody would notice. Seconds are random too — every scheduled post landing
  // at exactly :00 seconds is a fingerprint nothing else would explain.
  function schedPickMinute(start, end) {
    var span = Math.max(1, end - start);
    var minute = start + Math.floor(Math.random() * span);
    if (minute % 15 === 0 && span > 8) {
      minute += (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 4));
      if (minute < start) minute = start + 1;
      if (minute >= end) minute = end - 1;
    }
    return minute;
  }

  function schedOccurrences(rule) {
    var out = [];
    var start = schedParseHM(rule.start), end = schedParseHM(rule.end);
    if (start == null || end == null || end <= start) return out;
    var now = new Date();
    var nowMs = now.getTime();
    for (var offset = 0; offset <= SCHED_LOOKAHEAD_DAYS; offset++) {
      var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      if (!schedDayMatches(rule.days, day)) continue;
      var minute = schedPickMinute(start, end);
      var at = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                        0, minute, Math.floor(Math.random() * 60), 0).getTime();
      // Too close to now (or past) is not a plan — skip to the next day rather
      // than firing something the user never saw coming.
      if (at - nowMs < SCHED_MIN_LEAD_MIN * 60000) continue;
      out.push({ key: rule.id + "@" + schedDayKey(day), at: at });
    }
    return out;
  }

  // Posting every single matching day, without ever missing one, is the loudest
  // tell there is — no human keeps a 100% streak for a month. `skip` is the
  // percentage of otherwise-matching days the rule quietly sits out. The roll
  // happens once per day and is recorded, so it can't flip between passes.
  function schedRollSkip(rule) {
    var pct = Number(rule.skip);
    if (!(pct > 0)) return false;
    return Math.random() * 100 < Math.min(90, pct);
  }

  // "bag" is the default and the reason drafts don't repeat: draw without
  // replacement until every message has been used, then reshuffle. Pure random
  // posts "Günaydın" twice in one week while another line never appears, which
  // reads worse than a rotation. The bag is stored, so it survives reloads.
  function schedPickMessage(rule, meta) {
    var msgs = schedMessages(rule);
    if (!msgs.length) return null;
    if (rule.order === "sequential") {
      var idx = ((meta.seq || 0) % msgs.length + msgs.length) % msgs.length;
      meta.seq = idx + 1;
      return msgs[idx];
    }
    if (rule.order === "random") return msgs[Math.floor(Math.random() * msgs.length)];

    var bag = Array.isArray(meta.bag) ? meta.bag.filter(function (i) { return i < msgs.length; }) : [];
    if (!bag.length) {
      for (var i = 0; i < msgs.length; i++) bag.push(i);
      // Fisher-Yates, minus the last message drawn, so a reshuffle can't hand
      // back the same line two days running.
      for (var j = bag.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1));
        var tmp = bag[j]; bag[j] = bag[k]; bag[k] = tmp;
      }
      if (bag.length > 1 && bag[bag.length - 1] === meta.last) {
        bag[bag.length - 1] = bag[0];
        bag[0] = meta.last;
      }
    }
    var pick = bag.pop();
    meta.bag = bag;
    meta.last = pick;
    return msgs[pick];
  }

  function schedPrune(state) {
    // Registrations whose time is well past have either fired on X or failed
    // there; either way they are history and the key would grow forever.
    var cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    for (var k in state) {
      if (k.indexOf("@") > 0 && state[k] && state[k].at && state[k].at < cutoff) delete state[k];
    }
  }

  function schedTick() {
    if (schedBusy) return;
    schedStorageGet([SCHED_RULES_KEY, SCHED_STATE_KEY]).then(function (d) {
      var plan = d[SCHED_RULES_KEY] || {};
      if (!plan.enabled || !Array.isArray(plan.rules) || !plan.rules.length) return;
      var state = d[SCHED_STATE_KEY] || {};
      schedPrune(state);

      var pending = 0;
      for (var k in state) { if (state[k] && state[k].at > Date.now() && state[k].ok) pending++; }

      // Walk every rule's unbooked days. Skipped days cost nothing, so they are
      // resolved here and now; real registrations are a network call each, so
      // only a few go out per tick — spacing them is both kinder to X and less
      // machine-like than firing thirty mutations in one burst.
      var queue = [];
      for (var i = 0; i < plan.rules.length; i++) {
        var rule = plan.rules[i];
        if (!rule || !rule.enabled || !rule.id || !schedMessages(rule).length) continue;
        var meta = state[rule.id + "#seq"] || (state[rule.id + "#seq"] = { seq: 0 });
        var occ = schedOccurrences(rule);
        for (var j = 0; j < occ.length; j++) {
          // Anything already decided stays decided. Re-rolling a slot whose
          // response we lost is how you end up posting the same line twice.
          if (state[occ[j].key]) continue;
          if (schedRollSkip(rule)) {
            state[occ[j].key] = { at: occ[j].at, skipped: true, rule: rule.id };
            continue;
          }
          if (queue.length + pending >= SCHED_MAX_PENDING) break;
          if (queue.length >= SCHED_MAX_PER_TICK) break;
          var text = schedPickMessage(rule, meta);
          if (!text) break;
          // Claim before the network call, so a second tab doesn't register the
          // same slot while this one is waiting on X.
          state[occ[j].key] = { at: occ[j].at, ok: false, by: schedInstanceId, ts: Date.now(), rule: rule.id };
          queue.push({ key: occ[j].key, at: occ[j].at, text: text, label: rule.label || "Plan" });
        }
      }
      if (!queue.length) { schedStorageSet(getStatePatch(state)); return; }

      schedBusy = true;
      schedStorageSet(getStatePatch(state)).then(function () {
        var n = 0;
        function step() {
          if (n >= queue.length) {
            schedBusy = false;
            return schedStorageSet(getStatePatch(state));
          }
          var item = queue[n++];
          return schedRegister(item.text, item.at).then(function (id) {
            state[item.key].ok = true;
            state[item.key].xid = id;
          }).catch(function (e) {
            state[item.key].error = String((e && e.message) || e);
            if (!schedWarned) {
              schedWarned = true;
              showToast("Planlama: X'e kaydedilemedi — " + state[item.key].error, { kind: "error", duration: 6000 });
            }
          }).then(function () {
            return schedStorageSet(getStatePatch(state));
          }).then(function () {
            // A human-ish gap between mutations rather than a tight loop.
            return new Promise(function (r) { setTimeout(r, 900 + Math.floor(Math.random() * 700)); });
          }).then(step);
        }
        return step();
      }).catch(function () { schedBusy = false; });
    });
  }
  function getStatePatch(state) {
    var obj = {};
    obj[SCHED_STATE_KEY] = state;
    return obj;
  }

  function startScheduler() {
    if (schedTimer) return;
    // One pass shortly after load registers everything due in the lookahead
    // window; after that a slow tick is enough, since the posting itself is
    // X's job now, not this tab's.
    setTimeout(schedTick, 5000);
    schedTimer = setInterval(schedTick, SCHED_TICK_MS);
  }

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
    scheduleFilterSweep();
    startFocusObserver();
    startDomObserver();
    startScheduler();
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
      applyFilter: applyFilter,
      // Lets you step the active-tweet pass by hand in the inspector, where
      // there is no other way to look at a single frame of it.
      applyFocus: applyFocus,
      articles: getArticles
    };
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
