// Generates the X-Client-Transaction-Id header required by X's web API.
//
// Adapted for a browser content script from x-client-transaction-id 0.3.1:
// https://github.com/Lqm1/x-client-transaction-id
// MIT License, Copyright (c) 2025 Lami.
(function () {
  "use strict";

  var ON_DEMAND_NAME = "ondemand.s";
  var ON_DEMAND_HASH = /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/;
  var INDICES = /\(\w\[(\d{1,2})\],\s*16\)/g;
  var EPOCH_MS = 1682924400 * 1000;
  var KEYWORD = "obfiowerehiring";
  var initPromise = null;

  function fail(message) {
    return new Error("X işlem kimliği: " + message);
  }

  function decodeBase64(value) {
    var raw = atob(value);
    var out = [];
    for (var i = 0; i < raw.length; i++) out.push(raw.charCodeAt(i));
    return out;
  }

  function encodeBase64(bytes) {
    var raw = "";
    for (var i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
    return btoa(raw);
  }

  function interpolate(from, to, amount) {
    var out = [];
    for (var i = 0; i < from.length; i++) {
      out.push(from[i] * (1 - amount) + to[i] * amount);
    }
    return out;
  }

  function solve(value, min, max, floorResult) {
    var result = (value * (max - min)) / 255 + min;
    return floorResult ? Math.floor(result) : Math.round(result * 100) / 100;
  }

  function cubicValue(curves, time) {
    var startGradient = 0;
    var endGradient = 0;
    var start = 0;
    var mid = 0;
    var end = 1;

    function calculate(a, b, m) {
      return 3 * a * (1 - m) * (1 - m) * m +
        3 * b * (1 - m) * m * m +
        m * m * m;
    }

    if (time <= 0) {
      if (curves[0] > 0) startGradient = curves[1] / curves[0];
      else if (curves[1] === 0 && curves[2] > 0) startGradient = curves[3] / curves[2];
      return startGradient * time;
    }
    if (time >= 1) {
      if (curves[2] < 1) endGradient = (curves[3] - 1) / (curves[2] - 1);
      else if (curves[2] === 1 && curves[0] < 1) {
        endGradient = (curves[1] - 1) / (curves[0] - 1);
      }
      return 1 + endGradient * (time - 1);
    }
    while (start < end) {
      mid = (start + end) / 2;
      var x = calculate(curves[0], curves[2], mid);
      if (Math.abs(time - x) < 0.00001) return calculate(curves[1], curves[3], mid);
      if (x < time) start = mid;
      else end = mid;
    }
    return calculate(curves[1], curves[3], mid);
  }

  function floatToHex(value) {
    var result = [];
    var quotient = Math.floor(value);
    var fraction = value - quotient;
    while (quotient > 0) {
      quotient = Math.floor(value / 16);
      var remainder = Math.floor(value - quotient * 16);
      result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
      value = quotient;
    }
    if (fraction === 0) return result.join("");
    result.push(".");
    while (fraction > 0) {
      fraction *= 16;
      var integer = Math.floor(fraction);
      fraction -= integer;
      result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
    }
    return result.join("");
  }

  function animationKey(frames) {
    var fromColor = frames.slice(0, 3).concat(1).map(Number);
    var toColor = frames.slice(3, 6).concat(1).map(Number);
    var toRotation = solve(frames[6], 60, 360, true);
    var curves = frames.slice(7).map(function (item, index) {
      return solve(item, index % 2 ? -1 : 0, 1, false);
    });
    var amount = cubicValue(curves, frames.targetTime);
    var color = interpolate(fromColor, toColor, amount).map(function (value) {
      return value > 0 ? value : 0;
    });
    var rotation = interpolate([0], [toRotation], amount)[0];
    var radians = rotation * Math.PI / 180;
    var matrix = [Math.cos(radians), -Math.sin(radians), Math.sin(radians), Math.cos(radians)];
    var parts = color.slice(0, -1).map(function (value) {
      return Math.round(value).toString(16);
    });
    matrix.forEach(function (value) {
      var rounded = Math.round(Math.abs(value) * 100) / 100;
      var hex = floatToHex(rounded);
      parts.push(hex.indexOf(".") === 0 ? ("0" + hex).toLowerCase() : (hex || "0"));
    });
    parts.push("0", "0");
    return parts.join("").replace(/[.-]/g, "");
  }

  function resolveOnDemandUrl(doc) {
    var sources = Array.prototype.map.call(doc.querySelectorAll("script"), function (script) {
      return script.textContent || "";
    }).filter(function (source) {
      return source.indexOf(ON_DEMAND_NAME) >= 0;
    });
    sources.push(doc.documentElement.outerHTML);
    for (var i = 0; i < sources.length; i++) {
      var match = ON_DEMAND_HASH.exec(sources[i]);
      if (match) {
        return "https://abs.twimg.com/responsive-web/client-web/" +
          ON_DEMAND_NAME + "." + match[2] + "a.js";
      }
    }
    throw fail("X'in doğrulama dosyası bulunamadı");
  }

  function parseFrameRows(doc, keyBytes) {
    var frameEls = doc.querySelectorAll("[id^='loading-x-anim']");
    if (!frameEls.length) throw fail("animasyon verisi bulunamadı");
    var frame = frameEls[keyBytes[5] % 4];
    var path = frame && frame.children[0] && frame.children[0].children[1];
    var d = path && path.getAttribute("d");
    if (!d) throw fail("animasyon yolu okunamadı");
    return d.substring(9).split("C").map(function (item) {
      var cleaned = item.replace(/[^\d]+/g, " ").trim();
      return cleaned ? cleaned.split(/\s+/).map(function (part) {
        return parseInt(part, 10);
      }) : [];
    });
  }

  function initialize() {
    return fetch("https://x.com/home", {
      credentials: "include",
      cache: "no-store",
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    }).then(function (response) {
      if (!response.ok) throw fail("X ana sayfası alınamadı (" + response.status + ")");
      return response.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, "text/html");
      var meta = doc.querySelector("[name='twitter-site-verification']");
      var key = meta && meta.getAttribute("content");
      if (!key) throw fail("site doğrulama anahtarı bulunamadı");
      var keyBytes = decodeBase64(key);
      var onDemandUrl = resolveOnDemandUrl(doc);
      return fetch(onDemandUrl, { cache: "no-store" }).then(function (response) {
        if (!response.ok) throw fail("doğrulama dosyası alınamadı (" + response.status + ")");
        return response.text();
      }).then(function (source) {
        var indices = [];
        var match;
        INDICES.lastIndex = 0;
        while ((match = INDICES.exec(source)) !== null) indices.push(parseInt(match[1], 10));
        if (indices.length < 2) throw fail("doğrulama indisleri bulunamadı");

        var rowIndex = keyBytes[indices[0]] % 16;
        var frameTime = indices.slice(1).reduce(function (value, index) {
          return value * (keyBytes[index] % 16);
        }, 1);
        frameTime = Math.round(frameTime / 10) * 10;
        var rows = parseFrameRows(doc, keyBytes);
        if (!rows[rowIndex]) throw fail("animasyon satırı bulunamadı");
        rows[rowIndex].targetTime = frameTime / 4096;
        return {
          keyBytes: keyBytes,
          animationKey: animationKey(rows[rowIndex])
        };
      });
    });
  }

  function getState() {
    if (!initPromise) {
      initPromise = initialize().catch(function (error) {
        initPromise = null;
        throw error;
      });
    }
    return initPromise;
  }

  function create(method, path) {
    return getState().then(function (state) {
      var now = Math.floor((Date.now() - EPOCH_MS) / 1000);
      var timeBytes = [
        now & 255,
        (now >> 8) & 255,
        (now >> 16) & 255,
        (now >> 24) & 255
      ];
      var data = method + "!" + path + "!" + now + KEYWORD + state.animationKey;
      return crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)).then(function (buffer) {
        var hash = Array.prototype.slice.call(new Uint8Array(buffer), 0, 16);
        var random = Math.floor(Math.random() * 256);
        var bytes = state.keyBytes.concat(timeBytes, hash, [3]);
        var out = [random].concat(bytes.map(function (value) { return value ^ random; }));
        return encodeBase64(out).replace(/=/g, "");
      });
    });
  }

  function reset() {
    initPromise = null;
  }

  window.XVerimTransaction = { create: create, reset: reset };
})();
