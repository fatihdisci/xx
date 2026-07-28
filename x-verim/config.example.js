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
    DEEPSEEK_API_KEY: "PASTE_YOUR_KEY_HERE",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
    DEEPSEEK_MODEL: "deepseek-chat",
    AI_TEMPERATURE: 0.8,
    AI_FREQUENCY_PENALTY: 0.3, // keeps a batch of drafts from settling into one template; above 0.5 it starts mangling word choice
    AI_TIMEOUT_MS: 45000,      // give up on a stalled request instead of shimmering forever

    // ---- Who you are ----
    // This never appears in any UI. It only ever feeds the system prompt.
    PERSONA: {
      identity: "Software engineer in Istanbul, builds small tools, follows football.",
      niche: ["yazılım", "yapay zeka", "ürün"],
      tone: "Direct, dry, a bit sarcastic. Short sentences.",
      language: "auto",        // "auto" mirrors the tweet's language; or e.g. "Türkçe"
      avoid: [
        "motivational closers",
        "emoji"
      ],
      // Optional but the single biggest quality lever: a handful of tweets you
      // actually wrote. The model copies the rhythm, never the content.
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
    // Any action left out falls back to the default shown here. Set one to ""
    // to switch it off.
    SHORTCUTS: {
      focusNext: "j",
      focusPrev: "k",
      like: "l",
      bookmark: "s",
      followAuthor: "f",
      replyWithDraft: "r",
      analyze: "a",
      togglePanel: "v"
    },

    // ---- Timeline filter ----
    FILTER: {
      enabled: true,
      hideMode: "dim",         // "dim" or "hide" for keywordsExclude matches
      keywordsInclude: [],     // highlight tweets containing these
      keywordsExclude: [],     // dim/hide tweets containing these
      mutedAuthors: [],        // handles, with or without the @
      highlightMinLikes: 0     // 0 = off
    },

    // ---- Pace guardrail (warns, never blocks) ----
    GUARDRAILS: {
      warnLikesPerHour: 60,
      warnFollowsPerHour: 20
    }
  };
})(typeof self !== "undefined" ? self : this);
