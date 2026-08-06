// X Verim popup — two jobs: show what the model has actually cost, and lodge
// the JSON post plan with X. Drafting itself lives entirely in the timeline.
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

  // ---- Maliyet ----
  // Everything here is derived from what the provider actually billed for:
  // the background worker records the token split of every call, and this only
  // formats it. No estimate, no per-call guess from character counts.
  var usage = null;

  // At these amounts fixed decimals are useless — $0.0003 and $0.0009 look
  // identical at a glance. Switch units instead so the number always carries
  // information.
  function fmtUsd(n) {
    n = Number(n) || 0;
    if (n === 0) return "$0";
    if (n < 0.01) return (n * 100).toFixed(2) + "¢";
    if (n < 1) return "$" + n.toFixed(3);
    return "$" + n.toFixed(2);
  }
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "K";
    return (n / 1e6).toFixed(2) + "M";
  }
  function fmtTry(usd, rate) {
    if (!rate) return "";
    var t = Number(usd) * rate;
    return " · ₺" + (t < 1 ? t.toFixed(2) : t.toFixed(1));
  }
  function dayKey(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  var TR_MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
  function shortDate(ms) {
    var d = new Date(ms);
    return d.getDate() + " " + TR_MONTHS[d.getMonth()];
  }

  // Seven bars, scaled to the busiest day in the window. A sparkline is the
  // only part of this card that answers "is today unusual" without arithmetic.
  function renderSpark(days) {
    var root = $("cost-spark");
    if (!root) return;
    root.innerHTML = "";
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var series = [];
    for (var i = 6; i >= 0; i--) {
      var ms = today.getTime() - i * 86400000;
      var bucket = days[dayKey(ms)] || null;
      series.push({ ms: ms, usd: bucket ? bucket.usd : 0, calls: bucket ? bucket.calls : 0 });
    }
    var max = 0;
    for (var j = 0; j < series.length; j++) max = Math.max(max, series[j].usd);
    for (var k = 0; k < series.length; k++) {
      var bar = document.createElement("i");
      // A day with calls must not render as a zero-height sliver, or a quiet
      // day and an idle day look the same.
      var ratio = max > 0 ? series[k].usd / max : 0;
      bar.style.height = (series[k].usd > 0 ? Math.max(9, Math.round(ratio * 100)) : 2) + "%";
      if (k === series.length - 1) bar.className = "today";
      bar.title = shortDate(series[k].ms) + ": " + fmtUsd(series[k].usd) + " · " + series[k].calls + " taslak";
      root.appendChild(bar);
    }
  }

  function renderUsage(u) {
    usage = u;
    var totals = u.totals || {};
    var today = u.today || {};
    var pr = u.pricing || {};
    var rate = Number(pr.usdTry) || 0;

    $("model-tag").textContent = u.model || "kişisel";
    $("model-select").value = u.model || "google/gemini-2.5-flash-lite";
    $("cost-total").textContent = fmtUsd(totals.usd) + fmtTry(totals.usd, rate);
    $("cost-sub").textContent = totals.calls
      ? (totals.calls + " taslak isteği · " + shortDate(u.since) + " tarihinden beri")
      : "henüz taslak üretilmedi";

    $("cost-today").textContent = fmtUsd(today.usd);
    $("cost-today-calls").textContent = (today.calls || 0) + " taslak";

    $("cost-avg").textContent = totals.calls ? fmtUsd(totals.usd / totals.calls) : "—";
    $("cost-last").textContent = u.last ? ("son: " + fmtUsd(u.last.usd)) : "son: —";

    renderSpark(u.days || {});

    var inTok = (totals.missTok || 0) + (totals.cachedTok || 0);
    $("cost-tokens").innerHTML = "";
    [
      ["giriş", fmtTok(inTok)],
      ["önbellek", fmtTok(totals.cachedTok)],
      ["çıkış", fmtTok(totals.outTok)]
    ].forEach(function (pair) {
      var chip = document.createElement("span");
      chip.className = "xverim-chip";
      chip.innerHTML = '<span>' + pair[0] + '</span><b>' + pair[1] + '</b>';
      $("cost-tokens").appendChild(chip);
    });

    // The rates are the one thing that makes the total auditable, and they are
    // three different numbers — a single "$/1M" line would be a lie.
    $("cost-rates").textContent = "1M token: giriş $" + pr.inputPerMTok
      + " · önbellek $" + pr.cachedInputPerMTok
      + " · çıkış $" + pr.outputPerMTok
      + (rate ? (" · ₺ kuru " + rate) : "");
  }

  function loadUsage() {
    bgRequest({ type: "GET_USAGE" }).then(function (resp) {
      if (!resp || !resp.ok) {
        setStatus("Maliyet verisi okunamadı" + (resp && resp.error ? ": " + resp.error : "."), "error", 0);
        return;
      }
      renderUsage(resp.data || {});
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
    loadUsage();
    loadSchedule();

    $("cost-reset").addEventListener("click", function () {
      if (!window.confirm("Maliyet sayacı sıfırlanacak. OpenRouter'daki gerçek faturan değişmez, sadece buradaki toplam sıfırdan başlar. Devam?")) return;
      bgRequest({ type: "RESET_USAGE" }).then(function () {
        loadUsage();
        setStatus("Sayaç sıfırlandı.", null, 2200);
      });
    });

    $("model-select").addEventListener("change", function (event) {
      var select = event.target;
      var model = select.value;
      select.disabled = true;
      bgRequest({ type: "SET_OPENROUTER_MODEL", model: model }).then(function (resp) {
        select.disabled = false;
        if (!resp || !resp.ok) {
          setStatus("Model seçimi kaydedilemedi" + (resp && resp.error ? ": " + resp.error : "."), "error", 0);
          loadUsage();
          return;
        }
        $("model-tag").textContent = (resp.data && resp.data.model) || model;
        setStatus("Model seçildi. Yeni taslaklar bununla üretilecek.", null, 2200);
      });
    });

    // A draft generated in the timeline while this popup is open should move
    // the total immediately — that is the whole point of a live counter.
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "local" && changes.xverim_usage_v1) loadUsage();
      });
    } catch (_) {}

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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
