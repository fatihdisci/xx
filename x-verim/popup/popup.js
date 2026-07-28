// X Verim popup — talks to the background service worker for AI calls
// and to the active x.com tab for "open in composer".
(function () {
  "use strict";

  var EXPECTED_SCHEDULER_VERSION = 7;

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
      // Safari intermittently returns no rows when `url` is included in the
      // query, even though x.com is in host_permissions. Ask only for the
      // active tab; the content-script handshake below is the authoritative
      // proof that it is an X tab running X Verim.
      function pick(tabs) {
        return tabs && tabs[0] && tabs[0].id != null ? tabs[0] : null;
      }
      function fallback() {
        try {
          chrome.tabs.query({ active: true }, function (tabs) {
            resolve(pick(tabs));
          });
        } catch (_) { resolve(null); }
      }
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          var tab = pick(tabs);
          if (tab) resolve(tab);
          else fallback();
        });
      } catch (_) { fallback(); }
    });
  }

  async function syncScheduleNow(successMessage) {
    if (!schedPlan.enabled) {
      setStatus("JSON planı yüklü ama aktarım kapalı. Üstteki Açık anahtarını aç.", "warn", 0);
      return false;
    }
    if (!schedPlan.posts.length) {
      setStatus("Önce kesin tarihli posts dizisi içeren JSON'u yükle.", "warn", 0);
      return false;
    }
    var tab = await activeXTab();
    if (!tab) {
      setStatus("Bir x.com sekmesi aç; planlar X'e o sekmeden kaydedilecek.", "warn", 0);
      return false;
    }
    return new Promise(function (resolve) {
      try {
        var syncButton = $("sched-sync");
        if (syncButton) {
          syncButton.disabled = true;
          syncButton.textContent = "X kontrol ediliyor…";
        }
        chrome.tabs.sendMessage(tab.id, { type: "SCHEDULE_SYNC_NOW" }, function (resp) {
          var lastError = chrome.runtime.lastError;
          if (syncButton) {
            syncButton.disabled = false;
            syncButton.textContent = "Şimdi X'e kaydet";
          }
          // Safari can leave a benign lastError even though a response arrived.
          // A valid version handshake wins.
          if (resp && resp.ok) {
            if (Number(resp.schedulerVersion) !== EXPECTED_SCHEDULER_VERSION) {
              setStatus("Safari hâlâ eski X Verim paketini çalıştırıyor (v" + (resp.schedulerVersion || "?") + "). Safari Ayarları → Eklentiler → X Verim'i kapatıp yeniden aç; sonra x.com'u yenile.", "error", 0);
              resolve(false);
              return;
            }
            if (resp.cooldownUntil) {
              var waitUntil = new Date(resp.cooldownUntil);
              var hh = (waitUntil.getHours() < 10 ? "0" : "") + waitUntil.getHours();
              var mm = (waitUntil.getMinutes() < 10 ? "0" : "") + waitUntil.getMinutes();
              if (resp.cooldownReason === "paced") {
                setStatus("Kayıt başarılı. X'te toplam " + (resp.booked || 0) + " plan var; sıradaki kayıt denemesi " + hh + ":" + mm + " sonrasında.", null, 0);
              } else if (resp.cooldownReason === "calendar-paced") {
                setStatus("60 günlük takvim aktarılıyor: " + (resp.calendarBooked || 0) + "/" +
                  (resp.calendarTotal || 0) + " X'e kayıtlı. Sonraki kayıt " + hh + ":" + mm + " sonrasında.", null, 0);
              } else {
                setStatus("X yeni kayıtları geçici olarak reddetti: " + (resp.error || resp.cooldownReason || "403 Forbidden") + ". Planlayıcı " + hh + ":" + mm + " sonrasında otomatik devam edecek.", "warn", 0);
              }
            } else if (resp.busy) {
              setStatus("X yanıtı 20 saniyede tamamlanmadı. Düğmeye tekrar basma; JSON planı sayacını ve X listesini kontrol et.", "warn", 0);
            } else if (resp.error) {
              setStatus("X'e kaydedilemedi: " + resp.error, "error", 0);
            } else if (resp.booked > 0) {
              setStatus("Kayıt tamamlandı. X'te toplam " + resp.booked + " gelecek plan yerel olarak doğrulandı.", null, 0);
            } else {
              setStatus(successMessage || "Yeni kayıt oluşturulmadı. JSON tarihlerini ve aktarım anahtarını kontrol et.", "warn", 0);
            }
            resolve(true);
            return;
          }
          var detail = String((lastError && lastError.message) || "");
          if (/receiv|connection|message port|end does not exist/i.test(detail)) {
            setStatus("x.com sekmesi eklentiye bağlı değil. Sayfayı yenile, sonra yeniden dene.", "error", 0);
          } else {
            setStatus("x.com sekmesine ulaşılamadı" + (detail ? ": " + detail : ".") , "error", 0);
          }
          resolve(false);
        });
      } catch (_) {
        setStatus("x.com sekmesine ulaşılamadı. Sayfayı yenile ve tekrar dene.", "error", 0);
        resolve(false);
      }
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
  // The popup owns the exact JSON plan; the content script owns only the
  // runtime state, so replacing a JSON file cannot clobber an in-flight claim.
  var SCHED_RULES_KEY = "xverim_schedule_v1";
  var SCHED_STATE_KEY = "xverim_schedule_state_v1";
  var BUNDLED_PLAN_URL = "planlama-60-gun.json";
  var schedPlan = { enabled: false, posts: [], jsonOnlyV7: false };
  var schedState = {};

  function schedStableHash(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function schedTimeZoneName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local"; }
    catch (_) { return "local"; }
  }

  function schedSaveNow(done) {
    var obj = {};
    obj[SCHED_RULES_KEY] = schedPlan;
    try {
      chrome.storage.local.set(obj, function () {
        if (typeof done === "function") done();
      });
    } catch (_) {
      if (typeof done === "function") done();
    }
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
  function schedRenderCalendar() {
    var root = $("sched-calendar");
    if (!root) return;
    root.innerHTML = "";
    if (!schedPlan.posts.length) return;

    var now = Date.now();
    var booked = 0;
    for (var i = 0; i < schedPlan.posts.length; i++) {
      var stateItem = schedState["post@" + schedPlan.posts[i].id];
      if (stateItem && stateItem.ok) booked++;
    }
    var first = Date.parse(schedPlan.posts[0].at);
    var last = Date.parse(schedPlan.posts[schedPlan.posts.length - 1].at);
    var wrap = document.createElement("div");
    wrap.className = "xverim-sched-calendar";
    var head = document.createElement("div");
    head.className = "xverim-sched-calendar-head";
    var title = document.createElement("span");
    title.textContent = "Kesin tarihli JSON planı";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "xverim-btn small";
    remove.textContent = "Kaldır";
    remove.addEventListener("click", function () {
      if (!window.confirm("Hazır takvim kaldırılacak. X'e daha önce kaydedilen gönderiler X'ten silinmez. Devam?")) return;
      schedPlan.posts = [];
      schedSaveNow();
      schedRenderCalendar();
      setStatus("JSON planı kaldırıldı.", null, 3000);
    });
    var status = document.createElement("div");
    status.className = "xverim-sched-status";
    status.textContent = booked + "/" + schedPlan.posts.length + " X'e kayıtlı · " +
      schedWhen(first) + " – " + schedWhen(last) +
      (last < now ? " · tamamlandı" : " · tek oturumda otomatik aktarılır");
    head.appendChild(title);
    head.appendChild(remove);
    wrap.appendChild(head);
    wrap.appendChild(status);
    root.appendChild(wrap);
  }

  function schedRender() {
    schedRenderCalendar();
  }

  function schedRefreshStatuses() {
    schedRenderCalendar();
  }

  // The JSON is the plan. Import validates every exact timestamp and message,
  // then replaces the local list without altering anything already stored at X.
  function schedNormalizePost(raw, i) {
    if (!raw || typeof raw !== "object") throw new Error((i + 1) + ". gönderi bir nesne değil");
    var text = String(raw.text == null ? (raw.message == null ? "" : raw.message) : raw.text).trim();
    if (!text) throw new Error((i + 1) + ". gönderinin metni boş");
    if (text.length > 280) throw new Error((i + 1) + ". gönderi 280 karakteri aşıyor");
    var at = typeof raw.at === "number" ? raw.at : Date.parse(String(raw.at || ""));
    if (!isFinite(at)) throw new Error((i + 1) + ". gönderinin tarih-saat değeri geçersiz");
    var suppliedId = String(raw.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    return {
      id: suppliedId || ("post-" + schedStableHash(at + "!" + text)),
      at: new Date(at).toISOString(),
      text: text,
      label: String(raw.label || "Hazır takvim").slice(0, 60)
    };
  }

  function schedNormalizePosts(list) {
    if (!Array.isArray(list)) throw new Error("JSON nesnesinde kesin tarihli bir posts dizisi olmalı");
    var posts = [];
    for (var p = 0; p < list.length; p++) posts.push(schedNormalizePost(list[p], p));
    posts.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
    if (!posts.length) throw new Error("JSON planında hiç gönderi yok");
    var ids = {};
    for (var n = 0; n < posts.length; n++) {
      if (ids[posts[n].id]) throw new Error("JSON planında yinelenen gönderi kimliği var: " + posts[n].id);
      ids[posts[n].id] = true;
    }
    return posts;
  }

  function schedImport() {
    var box = $("sched-json");
    var text = String(box.value || "").trim();
    if (!text) { setStatus("Önce JSON yapıştır.", "warn"); return; }
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { setStatus("JSON okunamadı: " + String((e && e.message) || e), "error", 0); return; }
    if (!parsed || Array.isArray(parsed) || !Array.isArray(parsed.posts)) {
      setStatus("JSON nesnesinde kesin tarihli bir posts dizisi olmalı.", "error", 0);
      return;
    }
    var posts;
    try {
      posts = schedNormalizePosts(parsed.posts);
    } catch (e2) { setStatus(String((e2 && e2.message) || e2), "error", 0); return; }
    if (schedPlan.posts.length &&
        !window.confirm("Mevcut JSON planının yerini " + posts.length +
          " kesin tarihli gönderi alacak. X'e önceden kaydedilenler silinmez. Devam?")) {
      return;
    }
    schedPlan.posts = posts;
    schedPlan.jsonOnlyV7 = true;
    schedRender();
    box.value = "";
    if (schedPlan.enabled) {
      schedSaveNow(function () {
        syncScheduleNow(posts.length + " kesin tarihli gönderi yüklendi; X'e aktarım başladı.");
      });
    } else {
      schedSaveNow();
      setStatus(posts.length + " gönderilik JSON planı yüklendi; aktarım için üstteki Açık anahtarını aç.", "warn", 0);
    }
  }

  function loadSchedule() {
    try {
      chrome.storage.local.get([SCHED_RULES_KEY, SCHED_STATE_KEY], function (d) {
        var plan = d && d[SCHED_RULES_KEY];
        var enabled = !!(plan && plan.enabled);
        if (plan && typeof plan === "object") {
          schedPlan.enabled = enabled;
          schedPlan.posts = Array.isArray(plan.posts) ? plan.posts : [];
          schedPlan.jsonOnlyV7 = !!plan.jsonOnlyV7;
        }
        schedState = (d && d[SCHED_STATE_KEY]) || {};
        $("sched-enabled").checked = schedPlan.enabled;
        schedRender();
        if (!schedPlan.jsonOnlyV7) {
          fetch(BUNDLED_PLAN_URL).then(function (response) {
            if (!response.ok) throw new Error("paketli JSON okunamadı (" + response.status + ")");
            return response.json();
          }).then(function (bundled) {
            schedPlan.posts = schedNormalizePosts(bundled.posts);
            schedPlan.jsonOnlyV7 = true;
            schedRender();
            schedSaveNow(function () {
              setStatus("Paketli 60 gönderilik kesin JSON planı yüklendi." +
                (enabled ? " X'e aktarım otomatik başladı." : " Aktarım için Açık anahtarını aç."), enabled ? null : "warn", 0);
            });
          }).catch(function (error) {
            setStatus("Paketli plan yüklenemedi: " + String((error && error.message) || error), "error", 0);
          });
        }
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
      if (schedPlan.enabled) {
        schedSaveNow(function () {
          syncScheduleNow("Planlama açık; JSON gönderileri X'in kuyruğuna aktarılıyor.");
        });
      } else {
        schedSaveNow();
        setStatus("Planlama kapalı.", null, 2600);
      }
    });
    $("sched-sync").addEventListener("click", function () {
      schedSaveNow(function () { syncScheduleNow(); });
    });
    $("sched-export").addEventListener("click", function () {
      var exported = {
        version: 2,
        type: "xverim-calendar",
        timezone: schedTimeZoneName(),
        posts: schedPlan.posts
      };
      $("sched-json").value = JSON.stringify(exported, null, 2);
      setStatus("Kesin tarihli JSON planı yazıldı; kopyalayıp saklayabilirsin.", null, 2600);
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

  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
