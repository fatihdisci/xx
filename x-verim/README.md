# X Verim — Personal Accelerator for X

A personal-use Chrome extension (Manifest V3, load-unpacked) that speeds up a single human's X workflow with:

- **Keyboard navigation** — `j` / `k` for vim-style focus on the timeline
- **One-key actions** — `l` like, `s` bookmark, `f` follow on the focused tweet
- **AI assist** — post ideas, reply drafts, and tweet analysis via DeepSeek
- **Niche filter** — dim / hide tweets by keyword or author, highlight on include matches
- **Scheduled posts** — message lists handed to X's own scheduler at a random minute inside a window you set, so they go out with the browser closed (opt-in)
- **Pace guardrail** — non-blocking banner if hourly like / follow limits are exceeded

## Hard rules (these will never change)

1. **The only automation is the automation you schedule.** Like, follow, reply, and ad-hoc posting always require a human keypress or click; the extension never clicks a submit button on its own — with one deliberate, opt-in exception: posts you plan in the popup's *Gönderi planlama* card are posted at the time you chose, with the exact text you wrote. Nothing else may press that button, and the scheduler is off by default.
2. **Selector discipline.** Every X query uses `data-testid`, `role`, or `aria-label` only. CSS class names (e.g. `css-1dbjc4n`) are not used — they change weekly.
3. **No telemetry.** Nothing leaves your machine except calls to `api.deepseek.com` (only the persona + tweet text you explicitly submit) and, if you enable scheduling, calls to `x.com`'s own API carrying posts you wrote.
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
- The marker is deliberately quiet: the row lifts by a 6% tint, a 3px accent bar
  marks its left edge, and a small chip names the analyse key. **No border** —
  X doesn't draw timeline rows as cards, and framing one made the extension look
  like it had taken the page over.
- The bar and chip are drawn by a **floating overlay**, not by styles inside X's
  own markup: they can't be faded by the niche filter, can't be clipped by the
  row, and can't fight X's hover backgrounds. The bar is centred on the part of
  the row you can actually see, between X's sticky header and the fold, so a
  tweet taller than the window still shows its marker. That header's height is
  measured, not assumed, because the home timeline's tab bar makes it taller
  than other views.
- The whole marker is hidden while a reply or compose dialog is open, and the
  tweet X copies into that dialog is never focusable.
- The keyword-highlight bar is **green and 2px**, against the active bar's blue
  and 3px. Both used to be 3px blue at the same left edge, so on a row that was
  both they sat exactly on top of each other and neither could be read.
- A **dimmed** tweet stays interactive and comes back to 90% when you point at
  it. It used to carry `pointer-events: none`, which meant a dimmed tweet could
  not be opened, its links could not be clicked, and it could not be selected —
  fading something out is not the same as taking it away. `hide` remains the
  hard treatment.

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
- On a tweet's **detail page**, the replies already visible under it (up to 10,
  stopping before X's "Discover more" block) are sent along as context: drafts
  skip the points the thread already made and match its register. The card's
  label shows `· N yanıt okundu` when this happened. The home timeline never
  does this — there are no replies on screen to read.
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

### Gönderi planlama (scheduled posts)

Opt-in, off by default. Each *rule* is: a name, a day filter (her gün / hafta
içi / hafta sonu / one weekday), a time window, an ordering (rastgele or
sırayla), and a message list — **one message per line**. On each matching day
the rule takes a **random minute inside the window** and posts one message from
the list (random pick, or round-robin for `sırayla`).

**The posting is X's, not ours.** Each slot is registered with X's own
scheduled-posts queue through `CreateScheduledTweet` — the same GraphQL
mutation x.com's composer fires behind *Gönderiyi planla*. Your session cookies
authorise it; the extension never reads or stores a credential. Once a slot is
registered it shows up under **Planlanan gönderiler** (`g` then `t`) and goes
out whether or not this machine is even switched on.

Mechanics worth knowing:

- Slots are booked **up to 7 days ahead**, so an x.com tab open for one minute
  today covers the week. The tab is only ever the thing that *registers*
  a post, never the thing that publishes it.
- The GraphQL operation id rotates on X's deploys. A 400/404 triggers one
  rediscovery pass over the bundles the page already loaded, and the fresh id
  is cached in `xverim_sched_qid_v1` — so a deploy costs one failed attempt,
  not a broken feature.
- Registration is attempted **once per rule per day**. A slot whose response
  was lost stays attempted rather than being retried: a duplicate scheduled
  post is worse than a missed one.
- The popup owns the rules (`xverim_schedule_v1`); the content script owns the
  registration state (`xverim_schedule_state_v1`), keyed `ruleId@YYYY-MM-DD`.
  Separate keys, so a popup save can't clobber an in-flight registration, and
  multiple tabs claim a slot before the network call rather than after.
- A window that has already closed today is skipped to the next matching day,
  and anything less than 5 minutes out is skipped too (X rejects an
  `execute_at` that is nearly now).
- At most 40 outstanding registrations, at most 4 per pass, spaced ~1 s apart.
- Each rule shows its real state in the popup: `3 mesaj · X'e kayıtlı ·
  sıradaki yarın 08:12 (+4)`, or the error X returned.
- **İçe / dışa aktar** takes the rule list as JSON, because typing fifty lines
  through a 380px popup is not a thing anyone should do. Import replaces the
  whole list and asks first. Keep your own rules in a `planlama-*.json` beside
  the extension — that pattern is gitignored, since content that is supposed
  to read as unplanned has no business in a public repo.

#### Not looking automated

Timing alone doesn't hide a schedule. Three things do, and all three are on by
default:

- **No repeats until the list is exhausted.** `Tekrarsız` (the default) draws
  without replacement and reshuffles only when the bag is empty, never handing
  back the line it just used. Pure random posts one greeting twice in a week
  while another never appears, which reads worse than an obvious rotation.
- **Missed days.** `%15/%25/%40 atla` sits out that share of otherwise-matching
  days. An unbroken 60-day streak is the loudest tell there is; nothing else
  about the posts matters if they never miss.
- **No round minutes.** A uniform draw lands on `:00` and `:30` often enough
  that, over a month, those are the only ones anyone would notice — so a
  quarter-hour hit gets nudged a few minutes off, and the seconds are random
  too. Every post landing at exactly `:00` seconds is a fingerprint with no
  innocent explanation.

Content still has to carry its own weight, and the rule is stricter than
"evergreen": **a scheduled line must not claim anything happened.** These are
written now and posted on an unknown future day, so "shipped it today" or
"started four things this week" isn't merely stale when it lands, it's false —
and a feed of progress reports that never match reality is both a lie and the
easiest kind of automation to spot. Greetings, wishes and moods are safe
because they're true whenever they land. Keep the shapes varied (two words up
to a short sentence) so ten of them don't read as one template.

This is the one sanctioned exception to hard rule 1 — see above. Note that the
exception is narrow: the extension asks X to publish text the user wrote at a
time the user chose. It still never clicks *Gönder* on anything else.
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

Every prompt also states today's real date. A model's sense of "now" is its
training cutoff, so drafts quietly assumed an earlier year and dated themselves
to 2024 or 2025. The line is built per request from local date parts (not
`toISOString()`, which is UTC and names yesterday for anyone east of Greenwich
late in the evening), so a tab left open overnight doesn't keep yesterday's date.

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
