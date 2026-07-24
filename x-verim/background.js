// Background — only place that talks to api.deepseek.com.
// Routes AI_* / GET_FILTER / GET_COUNTS / GUARDRAIL_LOG messages from content
// scripts and the popup, and pushes GUARDRAIL_WARN to x.com tabs. The persona
// never leaves this file — it only feeds the system prompt.
//
// Runs as a service worker on Chrome and as an event page on Safari (Safari
// prefers background.scripts, which loads config.js for us). importScripts
// exists only in the service-worker case.
if (typeof self.XVERIM_CONFIG === "undefined" && typeof importScripts === "function") {
  importScripts("config.js");
}

(function () {
  "use strict";

  var C = self.XVERIM_CONFIG || {};

  // -------- System prompt builder --------
  // Two modes, because the persona's niches mean different things:
  //   "compose" — the niches ARE the subject (post ideas come from them)
  //   "respond" — the source tweet is the subject; niches only colour the voice
  // Without this split, analysing a tweet about football produced replies about
  // shipping software, because the niche list was in the prompt either way.
  function buildSystemPrompt(mode, extraRules) {
    var persona = C.PERSONA || {};
    var respond = (mode === "respond");
    var lines = [];
    lines.push("You write for X (formerly Twitter) on behalf of a single human. Your job: sound like them, not like AI.");
    if (persona.identity) lines.push("Identity: " + persona.identity);
    if (persona.niche && persona.niche.length) {
      var clean = persona.niche.filter(Boolean);
      if (clean.length) {
        lines.push(respond
          ? "Their usual interests (background only — NOT topics to steer toward): " + clean.join(", ")
          : "Niches: " + clean.join(", "));
      }
    }
    if (persona.tone) lines.push("Tone: " + persona.tone);
    if (Array.isArray(persona.avoid)) {
      for (var i = 0; i < persona.avoid.length; i++) {
        if (persona.avoid[i]) lines.push("- Avoid " + persona.avoid[i]);
      }
    }
    if (!persona.language || persona.language === "auto") {
      if (respond) {
        lines.push("CRITICAL LANGUAGE RULE: detect the language the source tweet quoted in the user message is written in, and write your reply text in that exact language — not the language of these instructions. If the tweet mixes languages, mirror that mix. Exception: if a field's own instruction explicitly asks for a specific language (e.g. a translation into another language), that field follows its own instruction.");
      } else {
        lines.push("Language: write in the language of the requested topic; if that is unclear, default to the language the request itself is written in.");
      }
    } else {
      lines.push("Language: write in " + persona.language + ".");
    }
    if (respond) {
      lines.push("- The source tweet decides the subject. Answer what it is actually about, on its own terms.");
      lines.push("- If the tweet has nothing to do with the interests listed above, do not mention them at all. Never bend an unrelated tweet toward software, AI, agents, coding or 'building things'. A tweet about football gets a football reply; about food, a food reply; about a joke, a joke back.");
      lines.push("- No credentials and no expert framing. Never open with 'As someone who…'.");
    }
    // Natural-speech and X-specific anti-patterns.
    lines.push("- Write the way a person actually talks: everyday words, natural rhythm, contractions where the language allows. Not a blog post, not a LinkedIn update, not a thread opener.");
    lines.push("- No buzzwords, no jargon the tweet itself didn't use, no explaining the obvious.");
    lines.push("- Concise, single take; no hashtag spam (one max if relevant).");
    lines.push("- No 'Great point!' / 'This is so true!' / generic engagement-bait closers.");
    lines.push("- No em-dash pile-up; vary sentence length; prefer commas or periods.");
    if (extraRules) lines.push(extraRules);
    return lines.join("\n");
  }

  // -------- DeepSeek API call --------
  async function deepseek(messages, opts) {
    var o = opts || {};
    var key = C.DEEPSEEK_API_KEY;
    if (!key || key === "PASTE_YOUR_KEY_HERE") {
      throw new Error("DEEPSEEK_API_KEY not set in config.js");
    }
    var base = (C.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
    var url = base + "/chat/completions";
    var body = {
      model: C.DEEPSEEK_MODEL || "deepseek-v4-flash",
      messages: messages,
      temperature: typeof o.temperature === "number" ? o.temperature : (C.AI_TEMPERATURE != null ? C.AI_TEMPERATURE : 0.8)
    };
    if (o.json) body.response_format = { type: "json_object" };
    var res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      var txt = "";
      try { txt = await res.text(); } catch (_) {}
      throw new Error("DeepSeek " + res.status + ": " + (txt || res.statusText || "request failed"));
    }
    var data = await res.json();
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return content != null ? String(content) : "";
  }

  // -------- Defensive JSON parsing --------
  function stripCodeFence(s) {
    if (s == null) return "";
    var t = String(s).trim();
    t = t.replace(/^```(?:json)?\s*/i, "");
    t = t.replace(/```\s*$/, "");
    return t.trim();
  }
  function safeJsonParse(s) {
    var cleaned = stripCodeFence(s);
    if (!cleaned) return null;
    try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
    var first = cleaned.indexOf("{");
    var last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (_) {}
    }
    var a = cleaned.indexOf("[");
    var b = cleaned.lastIndexOf("]");
    if (a >= 0 && b > a) {
      try { return JSON.parse(cleaned.slice(a, b + 1)); } catch (_) {}
    }
    return null;
  }

  // -------- AI handlers --------
  var SUGGEST_STYLES = {
    mixed: "Vary the shape across the batch — mix opinions, observations, questions and small concrete moments. No two should open the same way.",
    opinion: "Each one takes a clear position and commits to it. Something a reasonable person could disagree with. No hedging.",
    lesson: "Each one shares something learned the hard way, told plainly. Concrete detail over abstract advice, and no moralising closer.",
    question: "Each one is a genuine question to the timeline — something you actually want answers to, not rhetorical bait.",
    story: "Each one is a small concrete moment or anecdote, told in a couple of sentences. Specific details, no setup like 'story time'.",
    observation: "Each one notices something specific and states it plainly, without drawing a lesson from it."
  };

  async function suggestPosts(payload) {
    var p = payload || {};
    var count = Math.max(1, Math.min(10, p.count || 5));
    var topic = (p.topic || "").trim();
    var styleRule = SUGGEST_STYLES[p.style] || SUGGEST_STYLES.mixed;
    var fallbackTopic = (C.PERSONA && C.PERSONA.niche || []).filter(Boolean).join(", ");
    var sys = buildSystemPrompt("compose", 'Return ONLY a JSON object of the form {"items": [string, ...]}. No prose around it.');
    var user = "Give me " + count + " tweet ideas about: " + (topic || fallbackTopic || "your niche") + ".\n"
             + styleRule + "\n"
             + "Each under 240 chars and postable as-is — a finished tweet, not a description of one.\n"
             + "Do not number them and do not add hashtags unless one genuinely belongs.\n"
             + 'Return JSON: {"items": ["tweet1", "tweet2", ...]}.';
    var out = await deepseek(
      [{ role: "system", content: sys }, { role: "user", content: user }],
      { json: true, temperature: C.AI_TEMPERATURE != null ? C.AI_TEMPERATURE : 0.9 }
    );
    var parsed = safeJsonParse(out);
    var items = [];
    if (parsed && Array.isArray(parsed.items)) items = parsed.items;
    else if (Array.isArray(parsed)) items = parsed;
    else {
      // Last-ditch: treat every non-empty line as a tweet candidate.
      var lines = stripCodeFence(out).split(/\n+/).map(function (s) {
        return s.replace(/^[\s\-\*\d\.\)]+/, "").trim();
      }).filter(Boolean);
      items = lines.slice(0, count);
    }
    return items
      .filter(function (s) { return typeof s === "string"; })
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  // The "a" shortcut. Returns ready-to-post reply drafts in the tweet's own
  // language, each paired with a translation into the user's language so a
  // foreign-language draft can be understood before posting. The source tweet
  // itself is NOT translated.
  async function analyzeTweet(payload) {
    var p = payload || {};
    var analyzeCfg = C.ANALYZE || {};
    var translateTo = (analyzeCfg.translateTo || "Türkçe").trim() || "Türkçe";
    var replyCount = Math.max(1, Math.min(5, analyzeCfg.replyCount || 3));
    var sys = buildSystemPrompt("respond",
      'Return ONLY valid JSON with shape {"replies": [{"text": string, "translation": string}, ...]}.');
    var user = "Tweet by @" + (p.authorHandle || "unknown") + ": \"" + (p.text || "") + "\"\n\n"
             + "Write " + replyCount + " reply drafts to this tweet, ready to post as-is — finished tweets, not descriptions of an approach. "
             + "text: the reply itself, in the SAME language as the tweet. Each under 240 chars, each a genuinely different angle, "
             + "all strictly about this tweet's own subject. Sound like a real person firing off a quick reply — "
             + "casual, specific, no brand voice, no 'Great point', no opening with 'I '.\n"
             + "translation: a natural " + translateTo + " translation of that reply, so it can be understood before posting. "
             + "If the reply is ALREADY written in " + translateTo + ", set translation to an empty string \"\".\n\n"
             + 'Return JSON: {"replies": [{"text": "...", "translation": "..."}, ...]} with ' + replyCount + ' items.';
    var out = await deepseek(
      [{ role: "system", content: sys }, { role: "user", content: user }],
      { json: true }
    );
    var parsed = safeJsonParse(out);
    var replies = [];
    if (parsed && Array.isArray(parsed.replies)) {
      replies = parsed.replies.map(function (r) {
        if (r && typeof r === "object") {
          return { text: String(r.text || "").trim(), translation: String(r.translation || "").trim() };
        }
        return { text: String(r || "").trim(), translation: "" };
      }).filter(function (r) { return r.text; });
    }
    return { replies: replies };
  }

  async function draftReply(payload) {
    var p = payload || {};
    var sys = buildSystemPrompt("respond", "");  // language rule already baked in
    var user = "Original by @" + (p.authorHandle || "unknown") + ": \"" + (p.originalTweet || "") + "\"\n"
             + "Write one reply draft, ready to post as-is. ≤ 240 chars. Do not start with 'I '. "
             + "Reply to what this tweet is actually about — nothing else.";
    var out = await deepseek(
      [{ role: "system", content: sys }, { role: "user", content: user }],
      { temperature: C.AI_TEMPERATURE != null ? C.AI_TEMPERATURE : 0.8 }
    );
    return stripCodeFence(out).trim();
  }

  // -------- Guardrail counter (60-min rolling window, stored locally) --------
  var STORAGE_KEY = "xverim_guardrails_v1";

  function loadAll() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_KEY], function (data) {
          var all = (data && data[STORAGE_KEY]) || { likes: [], follows: [] };
          if (!Array.isArray(all.likes)) all.likes = [];
          if (!Array.isArray(all.follows)) all.follows = [];
          resolve(all);
        });
      } catch (_) { resolve({ likes: [], follows: [] }); }
    });
  }

  function saveAll(all) {
    return new Promise(function (resolve) {
      var obj = {};
      obj[STORAGE_KEY] = all;
      try { chrome.storage.local.set(obj, function () { resolve(); }); } catch (_) { resolve(); }
    });
  }

  function countInLastHour(kind) {
    return loadAll().then(function (all) {
      var cutoff = Date.now() - 60 * 60 * 1000;
      return (all[kind] || []).filter(function (t) { return typeof t === "number" && t >= cutoff; }).length;
    });
  }

  function pruneAndAppend(kind, ts) {
    return loadAll().then(function (all) {
      var cutoff = Date.now() - 60 * 60 * 1000;
      all[kind] = (all[kind] || []).filter(function (t) { return typeof t === "number" && t >= cutoff; });
      all[kind].push(ts);
      return saveAll(all).then(function () { return all[kind].length; });
    });
  }

  function maybeWarn(kind) {
    var limits = C.GUARDRAILS || {};
    var threshold = kind === "like" ? limits.warnLikesPerHour
                  : kind === "follow" ? limits.warnFollowsPerHour
                  : null;
    if (!threshold) return;
    countInLastHour(kind).then(function (n) {
      if (n > threshold) {
        chrome.tabs.query({ url: "https://x.com/*" }, function (tabs) {
          if (!tabs) return;
          for (var i = 0; i < tabs.length; i++) {
            try {
              chrome.tabs.sendMessage(tabs[i].id, { type: "GUARDRAIL_WARN", kind: kind }, function () {
                // Swallow "no receiving end" for tabs without the content script.
                void chrome.runtime.lastError;
              });
            } catch (_) {}
          }
        });
      }
    });
  }

  // -------- Message router --------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    (async function () {
      try {
        if (!msg || typeof msg !== "object") {
          return sendResponse({ ok: false, error: "invalid message" });
        }
        // No GET_PERSONA: the persona is never sent out of this worker. It
        // exists only to build the system prompt.
        if (msg.type === "GET_FILTER") {
          // Config default — the popup uses this when storage has no override yet.
          return sendResponse({ ok: true, data: { enabled: !!(C.FILTER && C.FILTER.enabled) } });
        }
        if (msg.type === "AI_SUGGEST") {
          var data = await suggestPosts(msg.payload || {});
          return sendResponse({ ok: true, data: data });
        }
        if (msg.type === "AI_ANALYZE") {
          var data2 = await analyzeTweet(msg.payload || {});
          return sendResponse({ ok: true, data: data2 });
        }
        if (msg.type === "AI_DRAFT") {
          var data3 = await draftReply(msg.payload || {});
          return sendResponse({ ok: true, data: data3 });
        }
        if (msg.type === "GUARDRAIL_LOG") {
          var kind = msg.kind === "follow" ? "follow" : "like";
          var n = await pruneAndAppend(kind, Date.now());
          maybeWarn(kind);
          return sendResponse({ ok: true, data: { count: n } });
        }
        if (msg.type === "GET_COUNTS") {
          var likes = await countInLastHour("like");
          var follows = await countInLastHour("follow");
          return sendResponse({ ok: true, data: { likes: likes, follows: follows } });
        }
        return sendResponse({ ok: false, error: "unknown message type: " + msg.type });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;  // async response
  });
})();
