# X Verim — Personal Accelerator for X

A personal-use Chrome extension (Manifest V3, load-unpacked) that speeds up a single human's X workflow with:

- **Keyboard navigation** — `j` / `k` for vim-style focus on the timeline
- **One-key actions** — `l` like, `s` bookmark, `f` follow on the focused tweet
- **AI assist** — post ideas, reply drafts, and tweet analysis via DeepSeek
- **Niche filter** — dim / hide tweets by keyword or author, highlight on include matches
- **Pace guardrail** — non-blocking banner if hourly like / follow limits are exceeded

## Hard rules (these will never change)

1. **No unattended automation.** Like, follow, reply, and post always require a human keypress or click. The extension only inserts text into the composer; it never clicks the submit button.
2. **Selector discipline.** Every X query uses `data-testid`, `role`, or `aria-label` only. CSS class names (e.g. `css-1dbjc4n`) are not used — they change weekly.
3. **No telemetry.** Nothing leaves your machine except calls to `api.deepseek.com` (only the persona + tweet text you explicitly submit).
4. **Personal use, no Web Store.** This is a load-unpacked extension for one person. Don't publish it.

## Install (Chrome)

1. Copy `config.example.js` to `config.js` and fill in:
   - `DEEPSEEK_API_KEY`
   - `PERSONA.identity` / `niche` / `tone`, and — the biggest quality lever —
     `PERSONA.samples`, a handful of tweets you actually wrote. The model copies
     their rhythm, never their content.
   - Optional: `FILTER.keywordsInclude` / `keywordsExclude` / `mutedAuthors` / `highlightMinLikes`
   - Optional: `AI_TIMEOUT_MS` (default 45 s) so a stalled request gives up instead of hanging.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `x-verim/` folder.
4. Open `https://x.com` and the panel hotkey is `v`.

`config.js` is in `.gitignore` — your key never leaves the machine. Without it
the extension will not load at all, which is why the example file is committed.

Any action missing from `SHORTCUTS` falls back to the default key in the table
below; setting one to `""` still disables it.

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
| `a` | Show the drafts card: ready reply drafts (each with a Turkish translation) you can drop straight into the composer |
| `v` | Toggle the floating panel |
| `1`…`5` | While the drafts card is open: put that draft into the reply box |
| `Esc` | Close the drafts card, then the panel |

Shortcuts are ignored while you're typing in an `input`, `textarea`, or any
`contenteditable` region — including the editable draft fields in the card.

### The active tweet

Every one-key action applies to exactly one tweet, so which one that is has to
be obvious and never surprising:

- **Scrolling** picks the tweet crossing a reading line at 35% of the viewport
  height, with hysteresis around it so two neighbours can't flip-flop.
- **`j` / `k` and clicking** are deliberate picks: they stay put while any real
  part of that tweet is still on screen, and hand control back to the reading
  line the moment you scroll — wheel, trackpad, or `Space` / `PageDown` /
  arrows. `j` / `k` land the tweet straddling the same line they're measured
  against, so a jump can never lose the highlight as the scroll settles.
- The ring and its badge are drawn by a **floating overlay**, not by styles
  inside X's own markup: it can't be faded by the niche filter, can't be
  clipped by the row, and can't fight X's hover backgrounds. It's cut where X's
  sticky header crosses it — and that header's height is measured, not assumed,
  because the home timeline's tab bar makes it taller than other views.
- The badge names the analyse key, so the one thing worth pressing is always on
  screen. It's hidden entirely while a reply or compose dialog is open, and the
  tweet X copies into that dialog is never focusable.

`window.__xverim.applyFocus()` steps the pass by hand in the inspector, and
`window.__xverim.articles()` returns the rows it considers.

### Drafts card (`a`)

- The source tweet's handle and first line sit above the drafts — with several
  cards opened in a session, it stops being obvious which tweet you're answering.
- Each draft is **editable in place**, with a live character count (yellow past
  240, red past 280). `Yanıtla`, `Kopyala` and the number keys all use whatever
  is in the field at that moment.
- `Cmd`/`Ctrl` + `Enter` inside a draft sends it to the reply box. `Esc` steps
  out of the field first, so a stray Esc never throws away an edit.
- ↻ regenerates. It sends the drafts already on screen back to the model as
  "don't repeat these", so a re-run means *different angles*, not a reword.
- Errors and empty results get a `Tekrar dene` button instead of a dead card.

### Floating panel (toggle with `v`)

- Filter on / off (live — syncs with the popup)
- 60-min rolling pace meters for likes and follows, each against its
  `GUARDRAILS` limit (yellow at 75%, red at the limit)
- A collapsible shortcut cheat sheet, generated from the live `SHORTCUTS` — a
  custom key can never disagree with what it shows

Drag the header to reposition. Position is persisted in `chrome.storage.local`,
and clamped back into view if the window is later resized smaller.

### Popup (toolbar icon)

- **Niş filtresi** — reflects content-script state, syncs both ways
- **Gönderi fikirleri** — topic (optional), how many, and an *angle* (karışık /
  görüş / ders / soru / an / gözlem). Each result is an **editable** card with a
  live character count against X's 280 limit, plus `Kopyala` and `Kutuya koy`.
  Topic, count and angle persist between openings; Enter in the topic field or
  `Cmd`/`Ctrl` + `Enter` anywhere generates, and a re-run asks for ideas that
  differ from the ones already listed.
- **Pace meters** for the last 60 minutes, with the limits fetched from the
  background (the popup never loads `config.js`).
- Failures report into a status line at the bottom. The popup raises no
  `alert()` dialogs.

Reply drafting is not in the popup — it lives on the timeline, where the tweet
already is: focus one and press `a` (three ready-to-post drafts) or `r`
(draft straight into the reply box).

### Feedback

Anything that used to fail into the console now shows a small toast in the
bottom-right corner: a draft on its way to the composer, an API error, a key
pressed with no tweet focused. If a draft can't reach the composer it is copied
to the clipboard instead, and the toast says so — a generated draft is never
silently lost.

The persona is **never displayed** in any surface. It travels from `config.js` into
the system prompt and nowhere else; the background exposes no message that returns it.

`Kutuya koy` clicks the side **New Tweet** button on the current x.com tab, waits for the composer to mount, and inserts the text. You still press the Post button yourself.

## How the drafts get their voice

`buildSystemPrompt()` in `background.js` is the only place a draft's voice is
decided, and it has two modes: `compose` (your niches *are* the subject) and
`respond` (the source tweet is the subject, the niches only colour the voice).

The voice rules are written as concrete bans rather than adjectives, because
"be natural" changes nothing while "no em dashes" does. The shared list
(`HUMAN_VOICE`) rules out the constructions that identify a text as machine-written
on sight — `not X, but Y`, three-item lists, "here's the thing", a rhetorical
question as an opener — plus the usual buzzword set, and it asks for varied
lengths so a batch of three doesn't arrive as three identical sentences.

On top of that, `respond` mode is told to react rather than summarise: no
repeating the tweet back, no compliment openers, match the tweet's register and
length, and a four-word reply is a real reply. `PERSONA.samples` from `config.js`
are pasted in as style anchors — that is the single strongest lever on how much
the output sounds like you.

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
├── config.example.js       Template — copy to config.js
├── config.js               Personal config — NOT committed
├── background.js           DeepSeek + guardrail counters (SW on Chrome, event page on Safari)
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

- `DEEPSEEK_API_KEY` is read in `background.js` only. It is never sent to content scripts or the popup.
- Outgoing network calls:
  - `api.deepseek.com/chat/completions` (only when you press a Generate / Draft / Analyze button)
  - No analytics, no third-party SDK, no telemetry.
- All data (panel position, guardrail counters, filter toggle) lives in `chrome.storage.local` on your machine.
- On Safari the key ships **inside the built `X Verim.app`**, so the rule there is
  "don't hand anyone this .app", not just "don't commit `config.js`".

## Why the guardrail exists

X has aggressive automated rate limiting on likes and follows, and shadowbans hit accounts that look bot-like. The 60-min rolling counter watches your pace and shows a non-blocking banner when you cross the soft limits in `config.js` (`warnLikesPerHour`, `warnFollowsPerHour`). It never blocks anything — it just reminds you to slow down.
