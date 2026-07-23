# X Verim — Personal Accelerator for X

A personal-use Chrome extension (Manifest V3, load-unpacked) that speeds up a single human's X workflow with:

- **Keyboard navigation** — `j` / `k` for vim-style focus on the timeline
- **One-key actions** — `l` like, `s` bookmark, `f` follow on the focused tweet
- **AI assist** — post ideas, reply drafts, and tweet analysis via OpenAI (gpt-5-nano)
- **Niche filter** — dim / hide tweets by keyword or author, highlight on include matches
- **Pace guardrail** — non-blocking banner if hourly like / follow limits are exceeded

## Hard rules (these will never change)

1. **No unattended automation.** Like, follow, reply, and post always require a human keypress or click. The extension only inserts text into the composer; it never clicks the submit button.
2. **Selector discipline.** Every X query uses `data-testid`, `role`, or `aria-label` only. CSS class names (e.g. `css-1dbjc4n`) are not used — they change weekly.
3. **No telemetry.** Nothing leaves your machine except calls to `api.openai.com` (only the persona + tweet text you explicitly submit).
4. **Personal use, no Web Store.** This is a load-unpacked extension for one person. Don't publish it.

## Install (Chrome)

1. Edit `config.js` and fill in:
   - `OPENAI_API_KEY`
   - `PERSONA.identity` / `niche` / `tone`
   - Optional: `FILTER.keywordsInclude` / `keywordsExclude` / `mutedAuthors` / `highlightMinLikes`
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `x-verim/` folder.
4. Open `https://x.com` and the panel hotkey is `v`.

`config.js` is in `.gitignore` — your key never leaves the machine.

## Install (Safari, macOS)

Safari has no "load unpacked" — an extension must live inside a macOS app bundle.
The Xcode project in `../x-verim-safari/` wraps this folder. It **references** these
files rather than copying them, so editing `content.js` / `config.js` here and
rebuilding is all it takes; there is no second copy to keep in sync.

```sh
cd "../x-verim-safari/X Verim"
xcodebuild -project "X Verim.xcodeproj" -scheme "X Verim" \
  -configuration Debug -derivedDataPath ./build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<your-team-id> build
cp -R "build/Build/Products/Debug/X Verim.app" ..
open "../X Verim.app"     # run once so Safari registers the extension
```

Then, in Safari:

1. **Settings → Advanced →** check *Show features for web developers*.
2. **Develop → Allow Unsigned Extensions.** Required because the app is signed
   with an Apple Development certificate, not a Developer ID. **This resets every
   time Safari quits** — re-enable it after a restart. (Signing with a Developer ID
   certificate removes this step, but that needs a paid Apple Developer account.)
3. **Settings → Extensions →** enable **X Verim**.
4. Click the toolbar icon → **Always Allow on x.com**. Safari gates host access per
   site at runtime; without this the content script never injects and the keyboard
   shortcuts do nothing.

### Reloading after an edit

Chrome has a reload button; Safari does not. The built `.appex` contains copies of
the extension files made at build time, so edits under `x-verim/` only take effect
after a rebuild:

```sh
../x-verim-safari/rebuild.sh
```

Then quit and reopen Safari (or toggle X Verim off/on in Settings → Extensions),
re-enable **Develop → Allow Unsigned Extensions**, and reload the x.com tab.

To debug the background code, use **Develop → Web Extension Background Content**;
content scripts show up in the normal Web Inspector for the x.com tab.

To regenerate the project from scratch (only needed if `manifest.json` gains new keys):

```sh
xcrun safari-web-extension-converter --project-location ../x-verim-safari \
  --app-name "X Verim" --bundle-identifier com.fatihdisci.xverim \
  --macos-only --swift --no-open --no-prompt --force .
```

Note the converter gives the app and the extension mismatched bundle identifiers
(`…X-Verim` vs `…xverim.Extension`), which fails `ValidateEmbeddedBinary`. Fix by
setting the app target's `PRODUCT_BUNDLE_IDENTIFIER` to `com.fatihdisci.xverim` so
the extension's id is prefixed by it.

### How one codebase serves both browsers

`manifest.json` declares the background twice:

```json
"background": {
  "service_worker": "background.js",
  "scripts": ["config.js", "background.js"]
}
```

Chrome uses `service_worker` and ignores `scripts`; Safari prefers `scripts` and runs
an event page. Because `importScripts` only exists in a service worker, `background.js`
guards it — under Safari `config.js` is already loaded by the `scripts` array.

## Usage

### Keyboard shortcuts (focused tweet, defaults — editable in `config.js`)

| Key | Action |
| --- | --- |
| `j` | Focus next tweet |
| `k` | Focus previous tweet |
| `l` | Like / unlike the focused tweet |
| `s` | Bookmark |
| `f` | Follow the author (if not already following) |
| `r` | Open reply composer and insert an AI draft |
| `a` | Show AI analysis popover (take, why it's performing, reply angles) |
| `v` | Toggle the floating panel |

Shortcuts are ignored while you're typing in an `input`, `textarea`, or any `contenteditable` region.

### Floating panel (toggle with `v`)

- Filter on / off (live — syncs with the popup)
- Hourly counters: likes / follows (60-min rolling)

Drag the header to reposition. Position is persisted in `chrome.storage.local`.

### Popup (toolbar icon)

- **Niche filter on** — reflects content-script state, syncs both ways
- **Post ideas** — topic (optional), how many, and an *angle* (mixed / opinion /
  lesson / question / story / observation). Each result is an **editable** card with
  a live character count against X's 280 limit, plus `Copy` and `Open in composer`.
  Topic, count and angle persist between openings; Enter in the topic field generates.
- **Hourly counters**

Reply drafting is not in the popup — it lives on the timeline, where the tweet
already is: focus one and press `a` (analysis + three ready-to-post drafts) or `r`
(draft straight into the reply box).

The persona is **never displayed** in any surface. It travels from `config.js` into
the system prompt and nowhere else; the background exposes no message that returns it.

`Open in composer` clicks the side **New Tweet** button on the current x.com tab, waits for the composer to mount, and inserts the text. You still press the Post button yourself.

## Why the JS files start with a BOM

Safari decodes background scripts as Latin-1 when nothing declares a charset, which
turned `başına` into `baÅŸÄ±na` — visibly in the UI, and invisibly in the system
prompt and in the Turkish engagement-token table in `lib/x-dom.js` (where a mangled
`beğeni` silently parses every like count as 0). Every `.js` file therefore starts
with a UTF-8 BOM, which forces UTF-8 in both browsers and is treated as whitespace
by JS. Keep it when editing: save as "UTF-8 with BOM". `content.css` avoids the
problem differently, by writing its one non-ASCII glyph as the escape `\2022`.

## If X changes its UI

All selectors live in **`lib/x-dom.js`** in the `SELECTORS` object at the top. Open DevTools on x.com, find the new `data-testid` for the affected element, update the matching entry, and reload the extension.

The DOM helper functions in the same file (`getTweetArticle`, `getTweetText`, `getAuthorHandle`, `getLikeButton`, `getCountsFromGroup`, …) are the single source of truth for how the extension talks to X.

## Files

```
x-verim/
├── manifest.json           MV3 manifest (storage perm only)
├── config.js               Personal config — NOT committed
├── background.js           OpenAI + guardrail counters (SW on Chrome, event page on Safari)
├── lib/x-dom.js            SELECTORS + DOM helpers
├── content/
│   ├── content.js          Focus model, shortcuts, filter, panel, popover
│   └── content.css         Dark-theme styles
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── icons/                  16 / 48 / 128 px PNGs
├── README.md
└── .gitignore

x-verim-safari/             Safari wrapper — references ../x-verim, no copies
└── X Verim/X Verim.xcodeproj
```

## Privacy

- `OPENAI_API_KEY` is read in `background.js` only. It is never sent to content scripts or the popup.
- Outgoing network calls:
  - `api.openai.com/chat/completions` (only when you press a Generate / Draft / Analyze button)
  - No analytics, no third-party SDK, no telemetry.
- All data (panel position, guardrail counters, filter toggle) lives in `chrome.storage.local` on your machine.
- On Safari the key ships **inside the built `X Verim.app`**, so the rule there is
  "don't hand anyone this .app", not just "don't commit `config.js`".

## Why the guardrail exists

X has aggressive automated rate limiting on likes and follows, and shadowbans hit accounts that look bot-like. The 60-min rolling counter watches your pace and shows a non-blocking banner when you cross the soft limits in `config.js` (`warnLikesPerHour`, `warnFollowsPerHour`). It never blocks anything — it just reminds you to slow down.
