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
    body.setAttribute("aria-label", "Gönderi fikri (düzenlenebilir)");

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

  // ---- Gönderi planlama ----
  // The popup owns the plan (master switch + rules); the content script owns
  // the runtime state (what fired today) under a separate key, so a save here
  // can never clobber an in-flight post over there.
  var SCHED_RULES_KEY = "xverim_schedule_v1";
  var SCHED_STATE_KEY = "xverim_schedule_state_v1";
  var schedPlan = { enabled: false, rules: [] };
  var schedState = {};
  var schedSaveTimer = null;

  var SCHED_DAYS = [
    ["all", "Her gün"], ["wd", "Hafta içi"], ["we", "Hafta sonu"],
    ["1", "Pazartesi"], ["2", "Salı"], ["3", "Çarşamba"], ["4", "Perşembe"],
    ["5", "Cuma"], ["6", "Cumartesi"], ["0", "Pazar"]
  ];

  function schedSaveNow() {
    var obj = {};
    obj[SCHED_RULES_KEY] = schedPlan;
    try { chrome.storage.local.set(obj); } catch (_) {}
  }
  // Debounced: every keystroke in a messages box is a change event.
  function schedSave() {
    if (schedSaveTimer) clearTimeout(schedSaveTimer);
    schedSaveTimer = setTimeout(schedSaveNow, 400);
  }

  var SCHED_TR_DAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
  function schedWhen(ms) {
    var d = new Date(ms);
    var hm = (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
    var today = new Date();
    var days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate())
      - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    if (days === 0) return "bugün " + hm;
    if (days === 1) return "yarın " + hm;
    return SCHED_TR_DAYS[d.getDay()] + " " + hm;
  }
  // One line under each rule, so the only proof the plan is live isn't the
  // tweet showing up days later. Reads the slots actually lodged with X.
  function schedStatusText(rule) {
    if (!rule.enabled) return "kapalı";
    var now = Date.now();
    var soonest = null, booked = 0, failed = null;
    for (var k in schedState) {
      var st = schedState[k];
      if (!st || st.rule !== rule.id) continue;
      if (st.error && !failed) failed = st.error;
      if (!st.ok || st.at <= now) continue;
      booked++;
      if (soonest == null || st.at < soonest) soonest = st.at;
    }
    if (soonest != null) {
      return "X'e kayıtlı · sıradaki " + schedWhen(soonest) + (booked > 1 ? " (+" + (booked - 1) + ")" : "");
    }
    if (failed) return "kaydedilemedi: " + failed;
    return "sıraya alınacak";
  }

  function schedNewRule() {
    return {
      id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      enabled: true,
      label: "",
      days: "all",
      start: "09:00",
      end: "12:00",
      order: "bag",
      skip: 15,
      messages: ""
    };
  }

  function schedRuleEl(rule) {
    var wrap = document.createElement("div");
    wrap.className = "xverim-sched-rule";

    var head = document.createElement("div");
    head.className = "xverim-sched-row";

    var on = document.createElement("input");
    on.type = "checkbox";
    on.checked = !!rule.enabled;
    on.title = "Bu kural açık / kapalı";
    on.addEventListener("change", function () {
      rule.enabled = on.checked;
      refreshMsgCount();
      schedSave();
    });

    var label = document.createElement("input");
    label.type = "text";
    label.className = "xverim-sched-label";
    label.placeholder = "Ad (örn. Günaydın)";
    label.value = rule.label || "";
    label.addEventListener("input", function () { rule.label = label.value; schedSave(); });

    var del = document.createElement("button");
    del.type = "button";
    del.className = "xverim-btn small";
    del.textContent = "Sil";
    del.addEventListener("click", function () {
      schedPlan.rules = schedPlan.rules.filter(function (r) { return r !== rule; });
      schedRender();
      schedSave();
    });

    head.appendChild(on);
    head.appendChild(label);
    head.appendChild(del);

    // Two rows: 380px minus paddings can't fit day + window + order side by
    // side without crushing the day select into an unreadable sliver.
    var when = document.createElement("div");
    when.className = "xverim-sched-row";
    var when2 = document.createElement("div");
    when2.className = "xverim-sched-row";

    var days = document.createElement("select");
    days.className = "xverim-sched-days";
    for (var i = 0; i < SCHED_DAYS.length; i++) {
      var opt = document.createElement("option");
      opt.value = SCHED_DAYS[i][0];
      opt.textContent = SCHED_DAYS[i][1];
      days.appendChild(opt);
    }
    days.value = rule.days || "all";
    days.addEventListener("change", function () { rule.days = days.value; schedSave(); });

    var start = document.createElement("input");
    start.type = "time";
    start.value = rule.start || "09:00";
    start.addEventListener("change", function () { rule.start = start.value; schedSave(); });

    var dash = document.createElement("span");
    dash.className = "xverim-sched-dash";
    dash.textContent = "–";

    var end = document.createElement("input");
    end.type = "time";
    end.value = rule.end || "12:00";
    end.addEventListener("change", function () { rule.end = end.value; schedSave(); });

    var order = document.createElement("select");
    order.className = "xverim-sched-order";
    order.title = "Mesaj sırası";
    [["bag", "Tekrarsız"], ["random", "Rastgele"], ["sequential", "Sırayla"]].forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      order.appendChild(opt);
    });
    order.value = rule.order || "bag";
    order.addEventListener("change", function () { rule.order = order.value; schedSave(); });

    // Never missing a day is the giveaway, so skipping some is a feature.
    var skip = document.createElement("select");
    skip.className = "xverim-sched-order";
    skip.title = "Bazı günleri atlama oranı";
    [["0", "Hiç atlama"], ["15", "%15 atla"], ["25", "%25 atla"], ["40", "%40 atla"]].forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      skip.appendChild(opt);
    });
    skip.value = String(Number(rule.skip) || 0);
    skip.addEventListener("change", function () { rule.skip = Number(skip.value) || 0; schedSave(); });

    when.appendChild(days);
    when.appendChild(order);
    when2.appendChild(start);
    when2.appendChild(dash);
    when2.appendChild(end);
    when2.appendChild(skip);

    var msgs = document.createElement("textarea");
    msgs.className = "xverim-sched-msgs";
    msgs.placeholder = "Her satıra bir mesaj:\nGünaydın\nHayırlı sabahlar";
    msgs.value = rule.messages || "";
    msgs.rows = 3;
    msgs.spellcheck = false;
    msgs.setAttribute("aria-label", "Mesajlar, her satıra bir tane");
    // Enter inserts a newline (the separator), so it must not reach the
    // popup-wide Cmd/Ctrl+Enter generate shortcut or the topic field.
    msgs.addEventListener("keydown", function (e) { e.stopPropagation(); });

    var count = document.createElement("div");
    count.className = "xverim-sched-status";
    function refreshMsgCount() {
      var n = String(msgs.value || "").split(/[\n|]+/)
        .map(function (s) { return s.trim(); }).filter(Boolean).length;
      count.textContent = n ? (n + " mesaj · " + schedStatusText(rule)) : schedStatusText(rule);
    }
    msgs.addEventListener("input", function () {
      rule.messages = msgs.value;
      refreshMsgCount();
      schedSave();
    });

    var status = count;
    refreshMsgCount();

    wrap.appendChild(head);
    wrap.appendChild(when);
    wrap.appendChild(when2);
    wrap.appendChild(msgs);
    wrap.appendChild(status);
    // Lets a live state update repaint just this line, instead of re-rendering
    // the list out from under someone who is mid-sentence in the textarea.
    wrap.xvRefresh = refreshMsgCount;
    return wrap;
  }

  function schedRender() {
    var root = $("sched-rules");
    if (!root) return;
    root.innerHTML = "";
    if (!schedPlan.rules.length) {
      var empty = document.createElement("div");
      empty.className = "xverim-empty";
      empty.textContent = "Henüz kural yok. Örnek: Günaydın kuralı, 07:00–10:00.";
      root.appendChild(empty);
      return;
    }
    for (var i = 0; i < schedPlan.rules.length; i++) {
      root.appendChild(schedRuleEl(schedPlan.rules[i]));
    }
  }

  function schedRefreshStatuses() {
    var root = $("sched-rules");
    if (!root) return;
    for (var i = 0; i < root.children.length; i++) {
      var el = root.children[i];
      if (typeof el.xvRefresh === "function") el.xvRefresh();
    }
  }

  // Typing fifty lines through a 380px popup is not a thing anyone should do,
  // so rules go in and out as JSON. Import replaces the rule list wholesale
  // and is deliberately loud about it: it is the one destructive button here.
  var SCHED_DAY_VALUES = { all: 1, wd: 1, we: 1, 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
  function schedNormalizeRule(raw, i) {
    if (!raw || typeof raw !== "object") throw new Error((i + 1) + ". kural bir nesne değil");
    var messages = raw.messages;
    if (Array.isArray(messages)) messages = messages.join("\n");
    messages = String(messages == null ? "" : messages);
    if (!messages.split(/[\n|]+/).some(function (s) { return s.trim(); })) {
      throw new Error((i + 1) + ". kuralda hiç mesaj yok");
    }
    var start = String(raw.start || "").trim(), end = String(raw.end || "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      throw new Error((i + 1) + ". kuralın saati SS:DD olmalı");
    }
    var days = String(raw.days == null ? "all" : raw.days);
    if (!SCHED_DAY_VALUES[days]) throw new Error((i + 1) + ". kuralın gün değeri geçersiz: " + days);
    return {
      // A fresh id per import: reusing one would inherit the old rule's
      // already-registered days and silently skip the new content.
      id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + i,
      enabled: raw.enabled !== false,
      label: String(raw.label || "").slice(0, 60),
      days: days,
      start: start,
      end: end,
      order: (raw.order === "random" || raw.order === "sequential") ? raw.order : "bag",
      skip: Math.max(0, Math.min(90, Number(raw.skip) || 0)),
      messages: messages
    };
  }
  function schedImport() {
    var box = $("sched-json");
    var text = String(box.value || "").trim();
    if (!text) { setStatus("Önce JSON yapıştır.", "warn"); return; }
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { setStatus("JSON okunamadı: " + String((e && e.message) || e), "error", 0); return; }
    var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rules) ? parsed.rules : null);
    if (!list || !list.length) { setStatus("JSON içinde kural dizisi yok.", "error", 0); return; }
    var rules = [];
    try {
      for (var i = 0; i < list.length; i++) rules.push(schedNormalizeRule(list[i], i));
    } catch (e2) { setStatus(String((e2 && e2.message) || e2), "error", 0); return; }
    if (schedPlan.rules.length &&
        !window.confirm("Mevcut " + schedPlan.rules.length + " kural silinip yerine " + rules.length + " kural yüklenecek. Devam?")) {
      return;
    }
    schedPlan.rules = rules;
    schedSaveNow();
    schedRender();
    box.value = "";
    setStatus(rules.length + " kural yüklendi. Planlamayı açmayı unutma.", null, 4000);
  }

  function loadSchedule() {
    try {
      chrome.storage.local.get([SCHED_RULES_KEY, SCHED_STATE_KEY], function (d) {
        var plan = d && d[SCHED_RULES_KEY];
        if (plan && typeof plan === "object") {
          schedPlan.enabled = !!plan.enabled;
          schedPlan.rules = Array.isArray(plan.rules) ? plan.rules : [];
        }
        schedState = (d && d[SCHED_STATE_KEY]) || {};
        $("sched-enabled").checked = schedPlan.enabled;
        schedRender();
      });
      // The content script updates the state as it plans and posts; mirror it
      // live so "bugün ~09:41" appears without reopening the popup.
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local" || !changes[SCHED_STATE_KEY]) return;
        schedState = changes[SCHED_STATE_KEY].newValue || {};
        schedRefreshStatuses();
      });
    } catch (_) {}
  }

  function init() {
    loadCounts();
    loadFilter();
    loadPrefs();
    loadSchedule();

    $("sched-enabled").addEventListener("change", function (e) {
      schedPlan.enabled = !!e.target.checked;
      schedSaveNow();
      setStatus(schedPlan.enabled
        ? "Planlama açık — saati gelince açık x.com sekmesi paylaşır."
        : "Planlama kapalı.", null, 2600);
    });
    $("sched-add").addEventListener("click", function () {
      schedPlan.rules.push(schedNewRule());
      schedRender();
      schedSave();
    });
    $("sched-export").addEventListener("click", function () {
      $("sched-json").value = JSON.stringify(schedPlan.rules, null, 2);
      setStatus("Mevcut kurallar yazıldı, kopyalayıp saklayabilirsin.", null, 2600);
    });
    $("sched-import").addEventListener("click", schedImport);
    // Enter and Cmd+Enter belong to the JSON box while it has focus.
    $("sched-json").addEventListener("keydown", function (e) { e.stopPropagation(); });

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

    // The popup is torn down the instant it loses focus — flush the debounced
    // schedule save or the last edit before closing never lands.
    window.addEventListener("pagehide", function () {
      if (schedSaveTimer) { clearTimeout(schedSaveTimer); schedSaveTimer = null; schedSaveNow(); }
    });
    window.addEventListener("blur", function () {
      if (schedSaveTimer) { clearTimeout(schedSaveTimer); schedSaveTimer = null; schedSaveNow(); }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
