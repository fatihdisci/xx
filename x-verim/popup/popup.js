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

  function setBusy(root, label) {
    if (!root) return;
    root.textContent = label;
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
    }
    body.addEventListener("input", function () { refreshCount(); autoGrow(); });

    var copy = document.createElement("button");
    copy.type = "button";
    copy.className = "xverim-btn small";
    copy.textContent = "Copy";
    copy.addEventListener("click", function () {
      copyToClipboard(body.value).then(function (ok) {
        copy.textContent = ok ? "Copied" : "Failed";
        setTimeout(function () { copy.textContent = "Copy"; }, 1200);
      });
    });

    var open = document.createElement("button");
    open.type = "button";
    open.className = "xverim-btn small primary";
    open.textContent = "Open in composer";
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

  function renderSuggest(items) {
    var root = $("suggest-result");
    root.innerHTML = "";
    if (!items || !items.length) { root.textContent = "No ideas returned."; return; }
    for (var i = 0; i < items.length; i++) root.appendChild(makeIdeaCard(items[i]));
  }

  async function openInComposer(text) {
    var tab = await activeXTab();
    if (!tab) { alert("Open an x.com tab first, then click this button."); return; }
    try {
      chrome.tabs.sendMessage(tab.id, { type: "OPEN_COMPOSER_WITH_TEXT", text: text }, function (resp) {
        if (chrome.runtime.lastError) {
          alert("Content script not reachable on this tab.");
          return;
        }
        if (!resp || !resp.ok) alert("Could not open composer. Click the page first, then retry.");
        else window.close();
      });
    } catch (e) {
      alert("Could not reach the content script: " + String((e && e.message) || e));
    }
  }

  function loadCounts() {
    bgRequest({ type: "GET_COUNTS" }).then(function (resp) {
      if (!resp || !resp.ok) return;
      $("cnt-likes").textContent = String((resp.data && resp.data.likes) || 0);
      $("cnt-follows").textContent = String((resp.data && resp.data.follows) || 0);
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
    var style = $("suggest-style").value;
    savePrefs({ topic: topic, count: count, style: style });

    btn.disabled = true;
    btn.textContent = "Generating…";
    setBusy($("suggest-result"), "Generating…");
    bgRequest({ type: "AI_SUGGEST", payload: { topic: topic, count: count, style: style } })
      .then(function (resp) {
        btn.disabled = false;
        btn.textContent = "Regenerate";
        if (!resp || !resp.ok) {
          $("suggest-result").textContent = "Error: " + ((resp && resp.error) || "unknown");
          return;
        }
        renderSuggest(resp.data || []);
      });
  }

  function init() {
    loadCounts();
    loadFilter();
    loadPrefs();

    $("filter-enabled").addEventListener("change", function (e) {
      var v = !!e.target.checked;
      try { chrome.storage.local.set({ xverim_filter_enabled: v }); } catch (_) {}
    });

    $("suggest-go").addEventListener("click", generate);
    // Enter in the topic field generates, so the common path needs no mouse.
    $("suggest-topic").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); generate(); }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
