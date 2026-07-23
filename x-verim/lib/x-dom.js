// X DOM helpers — single source of truth for talking to x.com.
// All selectors use data-testid / role / aria-label only. No CSS class names.
(function (root) {
  "use strict";

  // --- Verified selector table (from spec) ---
  var SELECTORS = {
    tweet:              'article[data-testid="tweet"]',
    cellInnerDiv:       'div[data-testid="cellInnerDiv"]',
    tweetText:          '[data-testid="tweetText"]',
    userName:           '[data-testid="User-Name"]',
    userAvatar:         '[data-testid^="UserAvatar-Container-"]',
    permalink:          'a[href*="/status/"]',
    like:               'button[data-testid="like"]',
    unlike:             'button[data-testid="unlike"]',
    reply:              'button[data-testid="reply"]',
    retweet:            'button[data-testid="retweet"]',
    bookmark:           'button[data-testid="bookmark"]',
    analytics:          'a[href$="/analytics"]',
    countText:          '[data-testid="app-text-transition-container"]',
    group:              'div[role="group"][aria-label]',
    follow:             'button[data-testid$="-follow"]',
    unfollow:           'button[data-testid$="-unfollow"]',
    composer:           '[data-testid="tweetTextarea_0"]',
    submitInline:       '[data-testid="tweetButtonInline"]',  // NEVER auto-click
    submitModal:        '[data-testid="tweetButton"]',        // NEVER auto-click
    newTweetButton:     '[data-testid="SideNav_NewTweet_Button"]',
    verified:           'svg[data-testid="icon-verified"]',
    primaryColumn:      '[data-testid="primaryColumn"]'
  };

  // --- Element lookup helpers ---

  function getTweetArticle(node) {
    if (!node) return null;
    if (node.nodeType !== 1) node = node.parentElement;
    if (!node) return null;
    if (node.tagName === "ARTICLE" && node.getAttribute("data-testid") === "tweet") return node;
    var inner = node.closest && node.closest(SELECTORS.tweet);
    return inner || null;
  }

  function getTweetText(article) {
    if (!article) return "";
    var el = article.querySelector(SELECTORS.tweetText);
    if (!el) return "";
    return (el.innerText || el.textContent || "").trim();
  }

  function getAuthorHandle(article) {
    if (!article) return "";
    var avatar = article.querySelector(SELECTORS.userAvatar);
    if (avatar) {
      var id = avatar.getAttribute("data-testid") || "";
      var m = id.match(/^UserAvatar-Container-(.+)$/);
      if (m) return m[1];
    }
    var permalink = article.querySelector(SELECTORS.permalink);
    if (permalink) {
      var href = permalink.getAttribute("href") || "";
      var m2 = href.match(/^\/([A-Za-z0-9_]+)\/status\//);
      if (m2) return m2[1];
    }
    return "";
  }

  function getTweetId(article) {
    if (!article) return "";
    var permalink = article.querySelector(SELECTORS.permalink);
    if (!permalink) return "";
    var href = permalink.getAttribute("href") || "";
    var m = href.match(/\/status\/(\d+)/);
    return m ? m[1] : "";
  }

  function getLikeButton(article) {
    if (!article) return null;
    return article.querySelector(SELECTORS.like) || article.querySelector(SELECTORS.unlike);
  }

  function getBookmarkButton(article) {
    return article ? article.querySelector(SELECTORS.bookmark) : null;
  }

  function getReplyButton(article) {
    return article ? article.querySelector(SELECTORS.reply) : null;
  }

  function getFollowButton(article) {
    return article ? article.querySelector(SELECTORS.follow) : null;
  }

  function getComposer() {
    return document.querySelector(SELECTORS.composer);
  }

  function getNewTweetButton() {
    return document.querySelector(SELECTORS.newTweetButton);
  }

  // --- Number parsing ---
  // Accepts plain integers, English short forms (K, M, B) and Turkish short forms
  // (B = bin, Mn = milyon, Tr = trilyon). "2.5K" -> 2500, "2 B" -> 2000, "1,2 Mn" -> 1200000.
  function parseTrNumber(str) {
    if (str == null) return 0;
    var s = String(str).trim();
    if (!s) return 0;
    s = s.replace(/\s+/g, "");
    s = s.replace(",", ".");
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      return Math.round(parseFloat(s));
    }
    var m = s.match(/^(-?\d+(?:\.\d+)?)([a-zA-ZığüşöçİĞÜŞÖÇ]+)$/);
    if (!m) {
      var digits = s.replace(/[^\d\-]/g, "");
      if (digits) return parseInt(digits, 10) || 0;
      return 0;
    }
    var num = parseFloat(m[1]);
    var suffix = m[2].toLowerCase();
    var mult = {
      "b": 1e3, "bin": 1e3, "k": 1e3,
      "mn": 1e6, "m": 1e6, "milyon": 1e6,
      "tr": 1e12, "t": 1e12, "trilyon": 1e12
    }[suffix];
    if (mult) return Math.round(num * mult);
    return Math.round(num);
  }

  // --- Engagement count parser ---
  // Reads the div[role="group"][aria-label] and maps Turkish / English tokens
  // back to {replies, reposts, likes, bookmarks, views}. The aria-label is
  // preferred over the visible abbreviation (it has the full integer).
  // Example: "10 yanıt, 3 yeniden gönderi, 346 beğeni, Beğenildi,
  //           3 yer işareti, 2648 görüntülenme"
  var TR_TOKEN_MAP = {
    "yanıt": "replies",
    "yanit": "replies",
    "replies": "replies",
    "reply": "replies",
    "yeniden gönderi": "reposts",
    "yeniden gonderi": "reposts",
    "reposts": "reposts",
    "retweet": "reposts",
    "retweets": "reposts",
    "beğeni": "likes",
    "begeni": "likes",
    "likes": "likes",
    "like": "likes",
    "yer işareti": "bookmarks",
    "yer isareti": "bookmarks",
    "bookmarks": "bookmarks",
    "bookmark": "bookmarks",
    "görüntülenme": "views",
    "goruntulenme": "views",
    "views": "views",
    "view": "views"
  };
  // Longest first so "yeniden gönderi" wins over any partial overlap.
  var TR_TOKEN_KEYS = Object.keys(TR_TOKEN_MAP).sort(function (a, b) {
    return b.length - a.length;
  });

  function getCountsFromGroup(article) {
    var out = { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: 0, liked: false };
    if (!article) return out;
    var group = article.querySelector(SELECTORS.group);
    if (!group) return out;
    var label = group.getAttribute("aria-label") || "";
    if (/beğenildi|begenildi|liked/i.test(label)) out.liked = true;
    // Match "<digits> <word chars>" pairs separated by commas / end-of-string.
    var re = /(\d[\d.\u00A0\s]*)\s+([\p{L}\s]+?)(?=,|$)/gu;
    var match;
    while ((match = re.exec(label)) !== null) {
      var numStr = (match[1] || "").replace(/[.\u00A0\s]/g, "").trim();
      var token = (match[2] || "").trim().toLowerCase();
      if (!numStr || !token) continue;
      var n = parseInt(numStr, 10);
      if (isNaN(n)) continue;
      var key = null;
      for (var i = 0; i < TR_TOKEN_KEYS.length; i++) {
        var tk = TR_TOKEN_KEYS[i];
        if (token === tk || token.indexOf(tk + " ") === 0) {
          key = TR_TOKEN_MAP[tk];
          break;
        }
      }
      if (key && out[key] === 0) out[key] = n;
    }
    return out;
  }

  // --- Public API ---
  var api = {
    SELECTORS: SELECTORS,
    getTweetArticle: getTweetArticle,
    getTweetText: getTweetText,
    getAuthorHandle: getAuthorHandle,
    getTweetId: getTweetId,
    getLikeButton: getLikeButton,
    getBookmarkButton: getBookmarkButton,
    getReplyButton: getReplyButton,
    getFollowButton: getFollowButton,
    getComposer: getComposer,
    getNewTweetButton: getNewTweetButton,
    parseTrNumber: parseTrNumber,
    getCountsFromGroup: getCountsFromGroup
  };

  var exportRoot = (typeof self !== "undefined") ? self
                 : (typeof window !== "undefined") ? window
                 : globalThis;
  exportRoot.XVerimDom = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
