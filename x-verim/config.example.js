// Copy this file to config.js and fill it in. config.js is gitignored — the
// key stays on your machine. Both worlds read the same object: the background
// service worker via self.XVERIM_CONFIG, the content script via window.
//
// Save config.js as "UTF-8 with BOM" like every other .js file here, otherwise
// Safari decodes it as Latin-1 and mangles Turkish characters in the prompt.
(function (root) {
  "use strict";

  root.XVERIM_CONFIG = {
    // ---- Model ----
    OPENROUTER_API_KEY: "PASTE_YOUR_KEY_HERE",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_MODEL: "google/gemini-2.5-flash-lite",
    AI_TEMPERATURE: 0.9,
    AI_FREQUENCY_PENALTY: 0.3, // keeps a batch of drafts from settling into one template; above 0.5 it starts mangling word choice
    AI_TIMEOUT_MS: 45000,      // give up on a stalled request instead of shimmering forever

    // ---- Who you are ----
    // This never appears in any UI. It only ever feeds the system prompt.
    PERSONA: {
      identity: "Software engineer in Istanbul, builds small tools, follows football.",
      niche: ["yazılım", "yapay zeka", "ürün"],
      // Avoid the word "samimi" here. The model reads it as an instruction to
      // perform warmth at strangers, which is the single thing that makes a
      // draft unpostable. Say "resmi değil" if that is what you mean.
      tone: "Gündelik ve doğrudan, resmi değil. Kısa cümleler, ölçülü ironi.",
      language: "auto",        // "auto" mirrors the tweet's language; or e.g. "Türkçe"
      avoid: [
        "motivational closers",
        "emoji"
      ],
      // Optional but the single biggest quality lever: a handful of tweets you
      // actually wrote. The model copies the rhythm, never the content. Pick the
      // most offhand ones you can find, not the polished ones.
      samples: [
        // "bunu üç kere denedim, üçünde de aynı yerde patladı"
      ]
    },

    // ---- The "a" popover ----
    ANALYZE: {
      replyCount: 3,           // 1-5 drafts per tweet
      translateTo: "Türkçe"    // language of the small translation under each draft
    },

    // ---- Keyboard ----
    // Three keys, and that is the whole surface. Set one to "" to switch it off.
    SHORTCUTS: {
      focusNext: "j",
      focusPrev: "k",
      analyze: "a"
    },

    // ---- Cost counter ----
    // OpenRouter/model pricing, used to estimate the usage readout in the popup.
    // Set these to the rates shown by OpenRouter for the selected model.
    // usdTry is optional: set it and the popup shows a ₺ figure next to the $.
    PRICING: {
      inputPerMTok: 0,
      cachedInputPerMTok: 0,
      outputPerMTok: 0,
      usdTry: 0
    }
  };
})(typeof self !== "undefined" ? self : this);
