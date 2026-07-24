// X Verim popup — talks to the background service worker for AI calls
// and to the active x.com tab for "open in composer".
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function bgRequest(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, error: chrome.runtime.lastError.message });
          }
          resolve(resp || { ok: false, error: "no response" });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function activeXTab() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true, url: "https://x.com/*" }, function (tabs) {
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch (_) { resolve(null); }
    });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
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

  // A popup is 380px of chrome-owned window; a native alert() on top of it is
  // a modal for a message that is never worth one. Everything reports here.
  var statusTimer = null;
  function setStatus(message, kind, ms) {
    var el = $("popup-status");
    if (!el) return;
    el.textContent = message || "";
    el.className = "xverim-status" + (message ? " visible" : "") + (kind ? " " + kind : "");
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (message && ms !== 0) statusTimer = setTimeout(function () { setStatus(""); }, ms || 3600);
  }

  // Same shimmer language as the timeline card, so waiting looks the same in
  // both surfaces — and the panel doesn't collapse to one line of text.
  function renderSkeleton(count) {
    var root = $("suggest-result");
    root.innerHTML = "";
    var n = Math.max(1, Math.min(10, count || 3));
    for (var i = 0; i < n; i++) {
      var sk = document.createElement("div");
      sk.className = "xverim-sk-card";
      root.appendChild(sk);
    }
  }

  var TWEET_LIMIT = 280;

  // Cards are editable: an idea is a starting point, and tweaking it here beats
  // copying it out, fixing it elsewhere, and pasting it back.
  function makeIdeaCard(text) {
    var card = document.createElement("div");
    card.className = "xverim-idea";

    var body = document.createElement("textarea");
    body.className = "xverim-idea-text";
    body.value = text;
    body.rows = 1;  // autoGrow sets the real height; a larger rows= would floor it
    body.setAttribute("aria-label", "Post idea (editable)");

    var actions = document.createElement("div");
    actions.className = "xverim-idea-actions";

    var count = document.createElement("span");
    count.className = "xverim-idea-count";

    function autoGrow() {
      body.style.height = "auto";
      body.style.height = body.scrollHeight + "px";
    }
    function refreshCount() {
      var n = body.value.length;
      count.textContent = n + " / " + TWEET_LIMIT;
      count.classList.toggle("over", n > TWEET_LIMIT);
      count.classList.toggle("near", n <= TWEET_LIMIT && n > TWEET_LIMIT - 40);
    }
    body.addEventListener("input", function () { refreshCount(); autoGrow(); });

    var copy = document.createElement("button");
    copy.type = "button";
    copy.className = "xverim-btn small";
    copy.textContent = "Kopyala";
    copy.addEventListener("click", function () {
      copyToClipboard(body.value).then(function (ok) {
        copy.textContent = ok ? "Kopyalandı" : "Olmadı";
        setTimeout(function () { copy.textContent = "Kopyala"; }, 1200);
      });
    });

    var open = document.createElement("button");
    open.type = "button";
    open.className = "xverim-btn small primary";
    open.textContent = "Kutuya koy";
    open.title = "x.com sekmesinde gönderi kutusunu açar ve metni yerleştirir";
    open.addEventListener("click", function () { openInComposer(body.value); });

    actions.appendChild(count);
    actions.appendChild(copy);
    actions.appendChild(open);
    card.appendChild(body);
    card.appendChild(actions);

    refreshCount();
    // scrollHeight is 0 until the element is in the document.
    requestAnimationFrame(autoGrow);
    return card;
  }

  // Kept so a regenerate can tell the model what it already said.
  var lastItems = [];

  function renderSuggest(items) {
    var root = $("suggest-result");
    root.innerHTML = "";
    if (!items || !items.length) {
      var empty = document.createElement("div");
      empty.className = "xverim-empty";
      empty.textContent = "Fikir çıkmadı. Konuyu biraz daralt ya da tekrar üret.";
      root.appendChild(empty);
      return;
    }
    for (var i = 0; i < items.length; i++) root.appendChild(makeIdeaCard(items[i]));
  }

  async function openInComposer(text) {
    if (!text || !text.trim()) { setStatus("Kart boş.", "warn"); return; }
    var tab = await activeXTab();
    if (!tab) { setStatus("Önce bir x.com sekmesi aç, sonra tekrar dene.", "warn"); return; }
    setStatus("Gönderi kutusu açılıyor…", null, 0);
    try {
      chrome.tabs.sendMessage(tab.id, { type: "OPEN_COMPOSER_WITH_TEXT", text: text }, function (resp) {
        if (chrome.runtime.lastError) {
          setStatus("Bu sekmede eklenti çalışmıyor — sayfayı yenile.", "error");
          return;
        }
        if (!resp || !resp.ok) setStatus("Kutu açılamadı. Sayfaya bir tıkla ve tekrar dene.", "error");
        else window.close();
      });
    } catch (e) {
      setStatus("İçerik betiğine ulaşılamadı: " + String((e && e.message) || e), "error");
    }
  }

  function paintMeter(kind, value, limit) {
    var num = $("cnt-" + kind);
    var suffix = $("lim-" + kind);
    var bar = $("bar-" + kind);
    if (num) num.textContent = String(value);
    if (suffix) suffix.textContent = limit ? (" / " + limit) : "";
    if (!bar) return;
    var ratio = limit > 0 ? Math.min(1, value / limit) : 0;
    bar.style.width = Math.round(ratio * 100) + "%";
    bar.className = ratio >= 1 ? "over" : (ratio >= 0.75 ? "near" : "");
  }

  // The popup never loads config.js, so the thresholds come from the background
  // (counts alone don't say whether you are anywhere near the line).
  function loadCounts() {
    Promise.all([
      bgRequest({ type: "GET_COUNTS" }),
      bgRequest({ type: "GET_LIMITS" })
    ]).then(function (res) {
      var counts = (res[0] && res[0].ok && res[0].data) || {};
      var limits = (res[1] && res[1].ok && res[1].data) || {};
      paintMeter("likes", counts.likes || 0, Number(limits.likes) || 0);
      paintMeter("follows", counts.follows || 0, Number(limits.follows) || 0);
    });
  }

  function loadFilter() {
    try {
      chrome.storage.local.get(["xverim_filter_enabled"], function (d) {
        if (d && typeof d.xverim_filter_enabled === "boolean") {
          $("filter-enabled").checked = d.xverim_filter_enabled;
          return;
        }
        // No stored override yet — mirror the config.js default.
        bgRequest({ type: "GET_FILTER" }).then(function (resp) {
          if (resp && resp.ok) $("filter-enabled").checked = !!resp.data.enabled;
        });
      });
    } catch (_) {}
  }

  // The popup is torn down on every close, so the last topic/angle would be lost
  // between generations without this.
  var PREFS_KEY = "xverim_suggest_prefs";
  function loadPrefs() {
    try {
      chrome.storage.local.get([PREFS_KEY], function (d) {
        var p = (d && d[PREFS_KEY]) || {};
        if (p.topic) $("suggest-topic").value = p.topic;
        if (p.count) $("suggest-count").value = p.count;
        if (p.style) $("suggest-style").value = p.style;
      });
    } catch (_) {}
  }
  function savePrefs(prefs) {
    var obj = {};
    obj[PREFS_KEY] = prefs;
    try { chrome.storage.local.set(obj); } catch (_) {}
  }

  function generate() {
    var btn = $("suggest-go");
    if (btn.disabled) return;
    var topic = $("suggest-topic").value.trim();
    var count = parseInt($("suggest-count").value, 10) || 5;
    if (count < 1) count = 1;
    if (count > 10) count = 10;
    var style = $("suggest-style").value;
    savePrefs({ topic: topic, count: count, style: style });

    btn.disabled = true;
    btn.textContent = "Üretiliyor…";
    setStatus("");
    renderSkeleton(count);
    // Re-runs ask for something new rather than the same list reworded.
    bgRequest({ type: "AI_SUGGEST", payload: { topic: topic, count: count, style: style, previous: lastItems } })
      .then(function (resp) {
        btn.disabled = false;
        btn.textContent = "Yeniden üret";
        if (!resp || !resp.ok) {
          $("suggest-result").innerHTML = "";
          setStatus((resp && resp.error) || "Bilinmeyen hata", "error", 0);
          return;
        }
        var items = resp.data || [];
        lastItems = lastItems.concat(items).slice(-10);
        renderSuggest(items);
      });
  }

  function init() {
    loadCounts();
    loadFilter();
    loadPrefs();

    $("filter-enabled").addEventListener("change", function (e) {
      var v = !!e.target.checked;
      try { chrome.storage.local.set({ xverim_filter_enabled: v }); } catch (_) {}
      setStatus(v ? "Niş filtresi açık." : "Niş filtresi kapalı.", null, 1600);
    });

    $("suggest-go").addEventListener("click", generate);
    // Enter in the topic field generates, so the common path needs no mouse.
    $("suggest-topic").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); generate(); }
    });
    // …and Cmd/Ctrl+Enter works from anywhere in the popup, including from
    // inside an idea card you just finished editing.
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); generate(); }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
