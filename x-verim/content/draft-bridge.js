// X Verim page-world bridge. This file intentionally runs in X's MAIN world:
// Safari/WebKit does not reliably deliver synthetic clipboard/input events from
// an isolated extension world to React's delegated event system.
//
// Draft.js owns the composer DOM. Calling its actual onPaste handler therefore
// updates EditorState without letting WebKit create a native text node first.
(function () {
  "use strict";

  var REQUEST = "xverim:draft-insert-request";
  var RESPONSE = "xverim:draft-insert-response";
  var READY = "xverim:draft-bridge-ready";

  function textOf(el) {
    return (el && el.textContent ? el.textContent : "").replace(/\u00A0/g, " ");
  }

  function matchesText(el, text) {
    return textOf(el).trim() === String(text || "").trim();
  }

  function findComposer(request) {
    var selector = window.XVerimDom && window.XVerimDom.SELECTORS && window.XVerimDom.SELECTORS.composer;
    if (!selector) return null;
    // A reply draft is valid only in X's /compose/post modal. Refusing the
    // request while that route/dialog is absent is intentional: it prevents a
    // late request from leaking into Home's permanent composer.
    if (request.requireComposePost && window.location.pathname !== "/compose/post") return null;
    var composers = Array.prototype.slice.call(document.querySelectorAll(selector));
    if (!composers.length) return null;

    // The content script sends the exact current index. Validate it first, then
    // prefer the reply modal so a persistent timeline composer never wins.
    var indexed = composers[Number(request.composerIndex)];
    if (indexed && !request.inDialog) return indexed;
    if (indexed && indexed.closest) {
      var indexedDialog = indexed.closest('[role="dialog"]');
      if (indexedDialog && indexedDialog.getClientRects && indexedDialog.getClientRects().length) return indexed;
    }
    if (request.inDialog) {
      for (var i = 0; i < composers.length; i++) {
        var dialog = composers[i].closest && composers[i].closest('[role="dialog"]');
        if (dialog && dialog.getClientRects && dialog.getClientRects().length) return composers[i];
      }
      return null;
    }
    // Never substitute the first composer for a stale/missing target.
    return indexed || null;
  }

  function reactProps(el) {
    var keys = Object.keys(el || {});
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactProps$") === 0 && el[keys[i]]) return el[keys[i]];
    }
    return null;
  }

  function draftEditorFromFiber(el) {
    var keys = Object.keys(el || {});
    var fiber = null;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) {
        fiber = el[keys[i]];
        break;
      }
    }
    // The DraftEditor instance is a class component above the editable host
    // fiber. Its private proxy is still the public runtime's real paste path.
    while (fiber) {
      var instance = fiber.stateNode;
      if (instance && typeof instance._onPaste === "function" && instance.editor === el) return instance;
      fiber = fiber.return;
    }
    return null;
  }

  function pasteEvent(el, text) {
    var clipboard = {
      getData: function (type) { return type === "text/plain" ? text : ""; },
      files: [],
      items: [],
      types: ["text/plain"]
    };
    var prevented = false;
    return {
      type: "paste",
      target: el,
      currentTarget: el,
      clipboardData: clipboard,
      nativeEvent: { clipboardData: clipboard },
      preventDefault: function () { prevented = true; this.defaultPrevented = true; },
      isDefaultPrevented: function () { return prevented; },
      stopPropagation: function () {},
      persist: function () {}
    };
  }

  function invokeDraftPaste(el, text) {
    var event = pasteEvent(el, text);
    var props = reactProps(el);
    if (props && typeof props.onPaste === "function") {
      props.onPaste(event);
      return true;
    }
    var editor = draftEditorFromFiber(el);
    if (editor) {
      editor._onPaste(event);
      return true;
    }
    return false;
  }

  function respond(id, payload) {
    document.dispatchEvent(new CustomEvent(RESPONSE, { detail: JSON.stringify({ id: id, payload: payload }) }));
  }

  document.addEventListener(REQUEST, function (event) {
    var request;
    try { request = JSON.parse(event.detail || "{}"); } catch (_) { return; }
    if (!request || !request.id || !request.text) return;

    var el = findComposer(request);
    if (!el) { respond(request.id, { ok: false, reason: "composer-not-found" }); return; }
    // This is a normal focus only; unlike execCommand it never changes the DOM.
    try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }

    // Let DraftEditor finish its mount/focus pass so _latestEditorState and its
    // selection are current before its paste handler turns text into EditorState.
    window.requestAnimationFrame(function () {
      var invoked = false;
      try { invoked = invokeDraftPaste(el, String(request.text)); } catch (_) {}
      window.requestAnimationFrame(function () {
        respond(request.id, {
          ok: invoked && matchesText(el, request.text),
          reason: invoked ? "draft-paste-no-match" : "draft-handler-not-found"
        });
      });
    });
  }, false);

  document.dispatchEvent(new CustomEvent(READY));
})();
