// Background — only place that talks to api.deepseek.com.
// Routes AI_ANALYZE / GET_USAGE / RESET_USAGE from the content script and the
// popup. The persona never leaves this file — it only feeds the system prompt.
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

  // -------- System prompt --------
  // One job now: reply drafts for a tweet you just read. Everything here exists
  // to stop the model doing the two things that give a draft away — sounding
  // composed, and being warm at a stranger.

  // Written as concrete bans rather than adjectives ("be natural" does nothing;
  // "no em dashes" does), because the tells are specific and repeatable.
  var HUMAN_VOICE = [
    "Type the way this person types on their phone: plain words, short sentences, the odd fragment. Thinking out loud, not publishing.",
    "One idea per reply. Say it and stop. No wrap-up line, no lesson at the end, no call to action.",
    "Length is the first thing that gives a draft away. Most real replies on X are under twelve words. Long enough to need two sentences is already unusual.",
    "Plain punctuation, the kind a phone keyboard produces. Commas and periods. No em dashes, no semicolons, no colon-then-payoff, no ellipses for drama, no ALL CAPS, no emoji unless the text you are answering used them first. Straight quotes and apostrophes, never curly ones. No parentheses for an aside — start a new sentence instead.",
    "Do not balance your sentences. Two clauses of equal length joined by a comma, a pair of adjectives, a rhythm that resolves neatly — that symmetry is the loudest AI tell there is.",
    "Say the thing once. Never restate your point in different words, never add a sentence that explains the sentence before it.",
    "These constructions read as AI on sight, never use them: \"not X, but Y\", \"X isn't just Y, it's Z\", three-item lists, \"here's the thing\", \"the truth is\", \"turns out\", a rhetorical question as the opening line, an opening word that labels your own reaction (\"honestly\", \"genuinely\", \"wild\", \"okay but\").",
    "These words are banned unless the source text used them first: leverage, unlock, delve, dive into, game changer, journey, landscape, ecosystem, robust, seamless, empower, curated, elevate, \"in today's world\", \"at the end of the day\".",
    "A bit blunt, dry or unfinished beats polished. Do not smooth it out. If a line would look good on a poster, it is wrong.",
    "Small imperfections are welcome where they fit how this person types: starting lowercase, skipping the final period, a casual filler word, an apostrophe left out of a suffix. Never force them, never misspell on purpose, and never sprinkle them evenly — a fake typo is worse than none.",
    "React to one concrete detail of the tweet, not to its topic in general. A number, a tool, a place, a moment — grab that.",
    "Specifics over adjectives. A number, a name, a thing that happened beats \"incredible\" or \"powerful\".",
    "No hashtags. No engagement bait: no \"thoughts?\", no \"agree?\", no exclamation marks unless something is actually funny."
  ];

  // Politeness is the other half of the AI accent. A model reaches for warmth by
  // default — it validates, thanks, encourages, includes you in a "we" — and
  // that manufactured closeness is exactly what makes a draft unpostable to
  // someone you have never met. These ban emotions the writer does not have;
  // they are not a licence to be rude.
  var NO_FAKE_WARMTH = [
    "You have no relationship with this person. Do not perform one. No welcoming, no congratulating, no encouraging, no thanking, no reassuring, unless the tweet is literally about that and you would genuinely mean it.",
    "No emotional mirroring: no \"I feel you\", \"been there\", \"anlıyorum\", \"çok haklısın\", \"aynen öyle\". You do not know what they went through.",
    "No collective \"we\" or \"us\" with strangers: no \"we've all been there\", \"hepimiz\", \"bizim gibi\", \"as developers we\". Speak only for yourself.",
    "No cushioning before a disagreement. No \"good point but\", \"katılıyorum ama\", \"fair, though\". Say the disagreement first, plainly, or say nothing.",
    "Enthusiasm only when the thing is genuinely notable, and then in the flattest possible words. Never \"harika\", \"muhteşem\", \"bayıldım\", \"love this\", \"this is huge\".",
    "Being liked is not the goal. Indifference, mild irritation and a plain factual correction are all acceptable outputs. A draft that is trying to be charming is a failed draft."
  ];

  // The rules above are tuned to English tells, and this account replies in
  // Turkish at least as often. Turkish AI text gives itself away somewhere else
  // entirely: written-register connectors, academic passives and textbook-perfect
  // suffix punctuation in a medium where nobody writes like that.
  var TURKISH_VOICE = [
    "Write spoken Turkish, not written Turkish. The register is a message to a friend, not an article.",
    "Never use these connectors: dolayısıyla, bu bağlamda, öte yandan, kısacası, özetle, sonuç olarak, bununla birlikte, ne var ki, unutmayalım ki, şunu söyleyebilirim ki.",
    "Never use the -mektedir / -maktadır register, and avoid nominalised officialese (sağlamaktadır, gerçekleştirmek, bulunmakta). Use plain verbs: yapıyor, oluyor, çıktı, patladı.",
    "Cut the filler intensifiers a model reaches for: aslında, gerçekten, kesinlikle, oldukça, son derece, bir hayli, epey bir. One of these in a draft is already too many.",
    "Do not pile up -ebilir/-abilir hedging. Say what you think in the plain present tense.",
    "\"Bu sadece X değil, aynı zamanda Y\" is the Turkish form of the worst AI sentence in existence. Never write it, in any variation.",
    "No closing moral and no closing question. Never end with \"sonuçta önemli olan\", \"bakalım göreceğiz\", \"sizce?\", \"siz ne düşünüyorsunuz?\".",
    "Use sen, not siz, unless the source tweet used siz first.",
    "Keep English tech words in English the way people actually say them: prompt, agent, commit, deploy, build, context, repo, model. Translating them (\"yapay zeka ajanı\", \"bağlam penceresi\") instantly reads as machine translation.",
    "Turkish suffix apostrophes are optional on X and often skipped: Xte, GitHubda, iOSla are all fine. Perfect apostrophes everywhere reads like a press release.",
    "Everyday spoken shortenings are allowed where they fit: bi, napıyor, geliyo, yapcak. Sparingly, and never inside an otherwise formal sentence — mixing the two registers is the tell.",
    "Particles like ya, işte, yani, hani, valla, bak sound human when a person would actually say them there, and robotic when dropped in to sound casual. At most one per draft, or none.",
    "Never write a sentence that reads as translated from English. If the word order would be more natural in English, rewrite the thought in Turkish from scratch."
  ];

  // Markets are the second front this account is turning toward, and they break
  // two defaults that hold everywhere else. The audience for borsa is Turkish
  // even when the tweet is not, so the mirror-the-source language rule is wrong
  // here. And on this topic the model's instinct is to be useful — which comes
  // out as a buy call, a target price or a confidence nobody can have. Those are
  // liabilities, not drafts. Both are hard rules, which is why they live here
  // rather than in the persona's tone.
  var MARKETS_VOICE = [
    "Language override: when the tweet is about markets — borsa, hisse, halka arz, BIST, endeks, temettü, KAP, SPK, aracı kurum, portföy, lot — write the draft in Turkish even if the tweet itself is in English. This is a deliberate exception to the language rule above, because the audience for this topic is Turkish.",
    "Never write anything that functions as a buy or sell call. No \"alınır\", \"girilir\", \"toplanıyor\", \"kaçmaz\", \"bu fiyattan bedava\", no target prices, no \"X TL görür\", no percentage forecasts. You are reacting in public, not advising anyone.",
    "No certainty about where a price goes. The honest registers are bence, izliyorum, merak ediyorum, bakalım. A draft that promises a direction is a failed draft.",
    "Never claim positions, portfolio size, returns or a track record: no \"ben aldım\", \"portföyümde\", \"şu kadar kazandım\". You follow this stuff, you do not run money.",
    "No expert framing and no analyst voice. \"Analistlere göre\", \"teknik olarak\", \"temel analizde\", \"direnç seviyesi\" are all the wrong register for someone typing a reply on their phone.",
    "Market words stay exactly as traders type them, never translated and never explained to the reader: lot, tavan, taban, halka arz, KAP, katılım endeksi, temettü, bedelli, bedelsiz, endeks, aracı kurum. Explaining a term reads as a bot.",
    "On halka arz tweets, react to the mechanics people actually argue about — dağıtım yöntemi, eşit dağıtım, lot sayısı, talep toplama tarihleri, aracı kurum, tavan serisi — not to whether it is a good investment."
  ];

  // Rules describe the target; pairs demonstrate the move. A model that has seen
  // the same thought written both ways corrects itself far more reliably than
  // one holding forty bans in its head — this block is doing more work than any
  // single rule above it.
  var REWRITE_PAIRS = [
    ["Kesinlikle haklısın, bu tam olarak benim de yaşadığım bir durum.", "bende de aynısı oldu, iki gün kaybettim"],
    ["Bu sadece bir araç değil, aynı zamanda bir düşünce biçimi.", "araçtan çok alışkanlık meselesi bence"],
    ["Harika bir tespit! Peki sizce bu nasıl gelişecek?", "6 ay sonra bunun ne halde olacağını merak ediyorum"],
    ["Çok değerli bir noktaya değinmişsin, gerçekten önemli.", "(bu hiçbir şey eklemiyor. böyle bir taslak yazma.)"],
    ["This is such a great point, it really highlights how much the landscape has shifted.", "the pricing changed too, nobody mentions that"],
    ["Not just faster, but fundamentally different.", "faster sure. still breaks on the same edge case"],
    ["Halka arzlar son dönemde yatırımcılar için oldukça cazip fırsatlar sunuyor.", "dağıtım eşit olursa girerim, değilse boşver"],
    ["Bu hisse teknik olarak güçlü duruyor, kesinlikle tavan yapar.", "(bu bir al çağrısı. böyle bir taslak asla yazma.)"]
  ];

  // A model's sense of "now" is its training cutoff, so drafts quietly assumed
  // an earlier year — replies dated themselves to 2024 or 2025 and read as
  // stale. State the real date instead. Local parts, not toISOString(), which is
  // UTC and would name yesterday for anyone east of Greenwich late in the
  // evening. Built per request, so a tab left open overnight isn't a day behind.
  var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function todayLine() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    var iso = d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
    return "Today is " + WEEKDAYS[d.getDay()] + ", " + iso + ". That is the present moment: "
      + "the current year is " + d.getFullYear() + ", and \"now\", \"this year\", \"lately\" and "
      + "\"recently\" all mean relative to this date — never relative to whatever year you remember "
      + "as current. Do not put the date in a draft unless the tweet is actually about timing.";
  }

  function buildSystemPrompt(extraRules) {
    var persona = C.PERSONA || {};
    var lines = [];
    lines.push("You are one specific human on X. You are not an assistant and you are not writing copy: every draft is something this person would have typed themselves, in the two seconds between reading a tweet and replying to it.");
    if (persona.identity) lines.push("Who they are: " + persona.identity);
    if (persona.niche && persona.niche.length) {
      var clean = persona.niche.filter(Boolean);
      // Background only. When the niche read as "topics", analysing a tweet
      // about football produced replies about shipping software.
      if (clean.length) lines.push("Their usual interests (background only — NOT topics to steer toward): " + clean.join(", "));
    }
    if (persona.tone) lines.push("How they sound: " + persona.tone);
    // Optional style anchors from config: real tweets of theirs. Nothing
    // imitates a voice as well as a few samples of it.
    if (Array.isArray(persona.samples)) {
      var samples = persona.samples.filter(Boolean).slice(0, 8);
      if (samples.length) {
        lines.push("Things they have actually posted. Copy the rhythm, the length and the level of effort, never the content:");
        for (var s = 0; s < samples.length; s++) lines.push("  · " + samples[s]);
      }
    }
    if (Array.isArray(persona.avoid)) {
      for (var i = 0; i < persona.avoid.length; i++) {
        if (persona.avoid[i]) lines.push("- Avoid " + persona.avoid[i]);
      }
    }
    if (!persona.language || persona.language === "auto") {
      lines.push("CRITICAL LANGUAGE RULE: detect the language the source tweet quoted in the user message is written in, and write your reply text in that exact language — not the language of these instructions. If the tweet mixes languages, mirror that mix. Exception: if a field's own instruction explicitly asks for a specific language (e.g. a translation), that field follows its own instruction.");
      lines.push("Write it the way a native speaker actually types that language on X, including how casually they punctuate. Never write a sentence that reads like it was translated.");
    } else {
      lines.push("Language: write in " + persona.language + ", the way a native speaker actually types it on X.");
    }
    lines.push(todayLine());

    lines.push("- You just read this tweet and had one reaction. Type that. Nothing more.");
    lines.push("- The source tweet decides the subject. Answer what it is actually about, on its own terms.");
    lines.push("- If the tweet has nothing to do with the interests listed above, do not mention them at all. Never bend an unrelated tweet toward software, AI, agents, coding or 'building things'. A tweet about football gets a football reply; about food, a food reply; about a joke, a joke back.");
    lines.push("- Do not repeat the tweet back at them, they know what they wrote. Add something: a detail, a disagreement, a joke, or the one question you would genuinely ask.");
    lines.push("- Match its register and its length. A one-line joke gets a one-line joke back; a serious question gets a plain answer; a technical post gets a technical detail.");
    lines.push("- No credentials, no expert framing. Never open with 'As someone who…'. Never open with 'I '.");
    lines.push("- No compliment openers: no 'Great point', 'So true', 'Well said', 'This', 'Exactly this'.");
    lines.push("- It is fine to be brief to the point of curt. A four-word reply is a real reply.");
    lines.push("- You are one voice in a public thread, not the last word on it. Sometimes the honest reaction is just being amused, curious or mildly annoyed — write that, don't upgrade it to analysis.");

    for (var h = 0; h < HUMAN_VOICE.length; h++) lines.push("- " + HUMAN_VOICE[h]);
    for (var w = 0; w < NO_FAKE_WARMTH.length; w++) lines.push("- " + NO_FAKE_WARMTH[w]);

    // Only worth the tokens when Turkish is reachable at all.
    var langPref = String(persona.language || "auto");
    if (langPref === "auto" || /türk|turk/i.test(langPref)) {
      lines.push("When the draft is in Turkish, these apply on top of everything above:");
      for (var t = 0; t < TURKISH_VOICE.length; t++) lines.push("  - " + TURKISH_VOICE[t]);
    }

    // Kept unconditional so the cached prefix stays byte-identical across calls:
    // deciding per tweet whether to include this would break DeepSeek's prompt
    // cache on every switch, and the block costs a few hundred cached tokens.
    lines.push("MARKETS. Only when the tweet is genuinely about them — never steer a tweet here — these override everything above, including the language rule:");
    for (var mv = 0; mv < MARKETS_VOICE.length; mv++) lines.push("  - " + MARKETS_VOICE[mv]);

    lines.push("Same thought, written wrong then written the way this person would type it:");
    for (var p = 0; p < REWRITE_PAIRS.length; p++) {
      lines.push("  ✗ " + REWRITE_PAIRS[p][0]);
      lines.push("  ✓ " + REWRITE_PAIRS[p][1]);
    }

    lines.push("- Last pass on every draft: (1) does any sentence exist only to round the reply off — cut it; (2) is there warmth, praise or agreement you do not actually feel — cut it; (3) is the rhythm too even — break it; (4) could this be shorter — it almost always can. If it sounds like a brand, a newsletter or a chatbot, rewrite it shorter and plainer.");
    if (extraRules) lines.push(extraRules);
    return lines.join("\n");
  }

  // -------- Token accounting --------
  // DeepSeek bills three ways and the cached rate is 50x cheaper than a miss, so
  // a single blended number would be wrong by an order of magnitude on a session
  // that reuses the same system prompt — which is every session here.
  var PRICE_DEFAULT = {
    inputPerMTok: 0.14,        // cache miss
    cachedInputPerMTok: 0.0028,
    outputPerMTok: 0.28
  };
  function pricing() {
    var p = C.PRICING || {};
    return {
      inputPerMTok: Number(p.inputPerMTok) >= 0 ? Number(p.inputPerMTok) : PRICE_DEFAULT.inputPerMTok,
      cachedInputPerMTok: Number(p.cachedInputPerMTok) >= 0 ? Number(p.cachedInputPerMTok) : PRICE_DEFAULT.cachedInputPerMTok,
      outputPerMTok: Number(p.outputPerMTok) >= 0 ? Number(p.outputPerMTok) : PRICE_DEFAULT.outputPerMTok,
      usdTry: Number(p.usdTry) > 0 ? Number(p.usdTry) : 0
    };
  }

  var USAGE_KEY = "xverim_usage_v1";
  var USAGE_DAYS_KEPT = 60;

  function emptyBucket() {
    return { calls: 0, cachedTok: 0, missTok: 0, outTok: 0, usd: 0 };
  }
  function addTo(bucket, entry) {
    bucket.calls += 1;
    bucket.cachedTok += entry.cachedTok;
    bucket.missTok += entry.missTok;
    bucket.outTok += entry.outTok;
    bucket.usd += entry.usd;
    return bucket;
  }
  function dayKey(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function loadUsage() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([USAGE_KEY], function (data) {
          var u = (data && data[USAGE_KEY]) || {};
          if (!u.totals) u.totals = emptyBucket();
          if (!u.days || typeof u.days !== "object") u.days = {};
          if (!u.since) u.since = Date.now();
          resolve(u);
        });
      } catch (_) {
        resolve({ totals: emptyBucket(), days: {}, since: Date.now() });
      }
    });
  }
  function saveUsage(u) {
    return new Promise(function (resolve) {
      var obj = {};
      obj[USAGE_KEY] = u;
      try { chrome.storage.local.set(obj, function () { resolve(); }); } catch (_) { resolve(); }
    });
  }

  // DeepSeek reports the cache split in its own fields; OpenAI-compatible
  // proxies only fill prompt_tokens_details.cached_tokens. Read whichever
  // arrived, and never let the miss count go negative on a partial payload.
  function readUsage(raw) {
    var u = (raw && raw.usage) || {};
    var promptTok = Number(u.prompt_tokens) || 0;
    var details = u.prompt_tokens_details || {};
    var cached = Number(u.prompt_cache_hit_tokens);
    if (!(cached >= 0)) cached = Number(details.cached_tokens) || 0;
    var miss = Number(u.prompt_cache_miss_tokens);
    if (!(miss >= 0)) miss = Math.max(0, promptTok - cached);
    var out = Number(u.completion_tokens) || 0;
    var pr = pricing();
    return {
      cachedTok: cached,
      missTok: miss,
      outTok: out,
      usd: (miss / 1e6) * pr.inputPerMTok
         + (cached / 1e6) * pr.cachedInputPerMTok
         + (out / 1e6) * pr.outputPerMTok
    };
  }

  function recordUsage(entry) {
    if (!entry || (!entry.missTok && !entry.cachedTok && !entry.outTok)) return Promise.resolve();
    return loadUsage().then(function (u) {
      var key = dayKey(Date.now());
      addTo(u.totals, entry);
      u.days[key] = addTo(u.days[key] || emptyBucket(), entry);
      u.last = { at: Date.now(), cachedTok: entry.cachedTok, missTok: entry.missTok, outTok: entry.outTok, usd: entry.usd };
      // Trim the day map so a long-lived install doesn't grow without bound.
      var keys = Object.keys(u.days).sort();
      while (keys.length > USAGE_DAYS_KEPT) delete u.days[keys.shift()];
      return saveUsage(u);
    }).catch(function () {});
  }

  // -------- DeepSeek API call --------
  // A raw provider error body in a 340px popover is unreadable. Map the codes
  // that actually happen to one short line, and keep the body only as a tail
  // for the cases nobody anticipated.
  function describeApiError(status, body) {
    var short = String(body || "").replace(/\s+/g, " ").trim();
    if (short.length > 140) short = short.slice(0, 140) + "…";
    if (status === 401 || status === 403) return "API anahtarı geçersiz (config.js)";
    if (status === 429) return "İstek sınırı doldu, biraz sonra tekrar deneyin";
    if (status === 402) return "API bakiyesi bitmiş görünüyor";
    if (status >= 500) return "Sağlayıcı şu an yanıt vermiyor (" + status + ")";
    return "API " + status + (short ? ": " + short : "");
  }

  async function deepseek(messages, opts) {
    var o = opts || {};
    var key = C.DEEPSEEK_API_KEY;
    if (!key || key === "PASTE_YOUR_KEY_HERE") {
      throw new Error("config.js içinde DEEPSEEK_API_KEY tanımlı değil");
    }
    var base = (C.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
    var url = base + "/chat/completions";
    var body = {
      model: C.DEEPSEEK_MODEL || "deepseek-v4-flash",
      messages: messages,
      temperature: typeof o.temperature === "number" ? o.temperature : (C.AI_TEMPERATURE != null ? C.AI_TEMPERATURE : 0.8),
      // Prompt rules alone do not stop a batch from settling into one template —
      // the sampler keeps picking the same opener and the same connectives.
      // A mild frequency penalty is what actually makes three drafts sound like
      // three different moods. Higher than ~0.5 starts breaking word choice.
      frequency_penalty: Number(C.AI_FREQUENCY_PENALTY) >= 0 ? Number(C.AI_FREQUENCY_PENALTY) : 0.3
    };
    if (o.json) body.response_format = { type: "json_object" };
    // Without a deadline a stalled request leaves the popover shimmering
    // forever, with no way back except reloading the tab.
    var timeoutMs = Number(C.AI_TIMEOUT_MS) > 0 ? Number(C.AI_TIMEOUT_MS) : 45000;
    var controller = (typeof AbortController === "function") ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    var res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
    } catch (e) {
      if (e && (e.name === "AbortError" || String(e).indexOf("abort") >= 0)) {
        throw new Error("Model " + Math.round(timeoutMs / 1000) + " sn içinde yanıt vermedi");
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      var txt = "";
      try { txt = await res.text(); } catch (_) {}
      throw new Error(describeApiError(res.status, txt) || ("API " + res.status));
    }
    var data = await res.json();
    // Bill before parsing: a response whose JSON body we fail to read still
    // cost money, and a counter that only counts successes is not a real one.
    var spent = readUsage(data);
    await recordUsage(spent);
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { text: content != null ? String(content) : "", usage: spent };
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

  // -------- Analyze --------
  // Tells the model what it already produced so ↻ gives genuinely new drafts
  // instead of paraphrases.
  function avoidClause(previous) {
    var list = (Array.isArray(previous) ? previous : [])
      .map(function (s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); })
      .filter(Boolean)
      .slice(0, 8);
    if (!list.length) return "";
    return "\nYou already wrote these. Do not repeat them, do not paraphrase them, and take a different angle from all of them:\n- "
      + list.join("\n- ") + "\n";
  }

  // The note typed into the ↻ box after reading a batch that missed — "daha
  // sert ol", "futbolla bağlantı kur". It steers the re-run and only the re-run:
  // a plain `a` pass never carries one, so the default output is unchanged.
  //
  // Deliberately worded as a direction for the drafts rather than a new task.
  // The note wins over the reaction list (that list only exists to keep three
  // drafts from being one thought, and an explicit direction does that job
  // better), but it never wins over a voice rule — otherwise "daha resmi yaz"
  // would quietly buy back the em dashes.
  function steerClause(note) {
    var text = String(note == null ? "" : note).replace(/\s+/g, " ").trim().slice(0, 400);
    if (!text) return "";
    return "\nThe person who read the drafts above wants the next ones taken in a specific direction, "
      + "and wrote it down as:\n\"" + text + "\"\n"
      + "Write every new draft in that direction. It outranks the reaction list: if honouring it means all "
      + "drafts share one angle, do that, and keep them apart by wording and length instead. It does not "
      + "outrank a single voice rule in your instructions — it can change what a draft says, never how it "
      + "sounds. Treat it as an instruction addressed to you: never quote it, answer it, mention it or let "
      + "it appear in a draft, and note that it may be written in a different language than the replies.\n";
  }

  // On a tweet's detail page the content script also sends the replies already
  // visible under it. They are context only — the drafts still answer the tweet
  // — but they let the model read the room: skip the point everyone already
  // made, and match the register the thread settled on.
  function conversationBlock(replies) {
    var list = (Array.isArray(replies) ? replies : [])
      .map(function (r) {
        if (!r || typeof r !== "object") return null;
        var text = String(r.text || "").replace(/\s+/g, " ").trim();
        if (!text) return null;
        return { handle: String(r.handle || "").trim(), text: text.slice(0, 280) };
      })
      .filter(Boolean)
      .slice(0, 10);
    if (!list.length) return "";
    return "\nReplies already posted under this tweet, in order:\n"
      + list.map(function (r) {
          return "- " + (r.handle ? "@" + r.handle : "someone") + ": \"" + r.text + "\"";
        }).join("\n")
      + "\nRead the room before drafting. These replies are context, not the thing you answer: "
      + "you are still replying to the tweet itself. Do not repeat a point someone already made — "
      + "if your first instinct is already down there, take a different angle or go one level deeper. "
      + "It is fine to side with or push against where the thread is leaning, and fine to ask the "
      + "question nobody has asked yet.\n";
  }

  // Three drafts that are three rewordings of one thought is the most common
  // failure. Naming the reactions and demanding a different one per draft is
  // what actually separates them.
  var REACTION_MODES = [
    "agree and add one concrete detail the tweet left out",
    "push back on one specific part of it",
    "the short dry joke",
    "the one question you actually want answered",
    "a related thing that happened to you, in one sentence",
    "notice the detail everyone else scrolled past"
  ];

  async function analyzeTweet(payload) {
    var p = payload || {};
    var analyzeCfg = C.ANALYZE || {};
    var translateTo = (analyzeCfg.translateTo || "Türkçe").trim() || "Türkçe";
    var replyCount = Math.max(1, Math.min(5, analyzeCfg.replyCount || 3));
    var sys = buildSystemPrompt(
      'Return ONLY valid JSON with shape {"replies": [{"text": string, "translation": string}, ...]}.');
    var user = "Tweet by @" + (p.authorHandle || "unknown") + ": \"" + (p.text || "") + "\"\n"
             + conversationBlock(p.replies) + "\n"
             + "Write " + replyCount + " reply drafts to this tweet, ready to post as-is — finished tweets, not descriptions of an approach.\n"
             + "Before writing, silently pick " + replyCount + " DIFFERENT reactions from this list, then write one draft for each:\n"
             + REACTION_MODES.map(function (m) { return "  · " + m; }).join("\n") + "\n"
             + "text: the reply itself, in the SAME language as the tweet. Under 240 chars, and much shorter than that most of the time. "
             + "Make at least one draft under eight words. No two drafts may open with the same word.\n"
             + "translation: a natural " + translateTo + " translation of that reply, so it can be understood before posting. "
             + "If the reply is ALREADY written in " + translateTo + ", set translation to an empty string \"\".\n"
             + avoidClause(p.previous)
             + steerClause(p.steer) + "\n"
             + 'Return JSON: {"replies": [{"text": "...", "translation": "..."}, ...]} with ' + replyCount + ' items.';
    var out = await deepseek(
      [{ role: "system", content: sys }, { role: "user", content: user }],
      { json: true, temperature: C.AI_TEMPERATURE != null ? C.AI_TEMPERATURE : 0.9 }
    );
    var parsed = safeJsonParse(out.text);
    // Models drop the wrapper key often enough that tolerating a bare array (or
    // an "items" key) beats showing an empty card for a response that actually
    // contained drafts.
    var raw = null;
    if (parsed && Array.isArray(parsed.replies)) raw = parsed.replies;
    else if (parsed && Array.isArray(parsed.items)) raw = parsed.items;
    else if (Array.isArray(parsed)) raw = parsed;
    var replies = (raw || []).map(function (r) {
      if (r && typeof r === "object") {
        return { text: String(r.text || r.reply || "").trim(), translation: String(r.translation || "").trim() };
      }
      return { text: String(r || "").trim(), translation: "" };
    }).filter(function (r) { return r.text; });
    return { replies: replies, usage: out.usage };
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
        if (msg.type === "AI_ANALYZE") {
          var data = await analyzeTweet(msg.payload || {});
          return sendResponse({ ok: true, data: data });
        }
        if (msg.type === "GET_USAGE") {
          var u = await loadUsage();
          var pr = pricing();
          return sendResponse({ ok: true, data: {
            totals: u.totals,
            today: u.days[dayKey(Date.now())] || emptyBucket(),
            days: u.days,
            last: u.last || null,
            since: u.since,
            model: C.DEEPSEEK_MODEL || "deepseek-v4-flash",
            pricing: pr
          } });
        }
        if (msg.type === "RESET_USAGE") {
          await saveUsage({ totals: emptyBucket(), days: {}, since: Date.now() });
          return sendResponse({ ok: true });
        }
        return sendResponse({ ok: false, error: "unknown message type: " + msg.type });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;  // async response
  });
})();
