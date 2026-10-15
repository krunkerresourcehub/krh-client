# Third-party notices

## LaF Client

- Source: https://github.com/LaFClient/LaF
- Authors: Hiro527 and sh (client), NamekujiLSDs (CSS themes)
- License: MIT, full text in `assets/laf-themes/LICENSE-LaF.txt`

Used for:

- `assets/laf-themes/type1.css` to `type5.css`: the five EasyCSS themes, included **unmodified**
  (their original header comments and license notes are kept inside the files).
  Please note that some of those headers carry their own terms (for example "All Rights Reserved" or
  CC BY-NC-SA 4.0). They are bundled as separate, unmodified files and credited to their author;
  if you are the author and want one removed, open an issue.
- The idea of the Twitch `!link` command and of the "copy system info" button. The code of both
  was written from scratch for KRH Client.

## PC7 Client and Water Client (ideas only)

- PC7 Client: https://github.com/PC7-Client/PC7-Client (discontinued; its license does not allow reusing its code)
- Water Client: https://github.com/ghostypostie/Water (no license file)

No code or assets from either project are included. The features that were inspired by their public
feature lists (Chat Logs window, external resource swapper, chat filters, Quick Play grid, one-click mod
downloader, settings profiles, display mode, userscript hot reload, hide-menu options, Discord buttons,
readable logs) were written from scratch for KRH Client.

## Lombre_Blanche's Krunker scripts (ideas only)

- https://lombreblanche34.github.io/krunker_scripts/

No code is included. The raid finder, Trade Plaza joiner, custom crosshair, auto find after disconnect, ARG shortcut,
Trade Plaza info and recently-joined avoidance were inspired by the public "Lombre Matchmaker" userscript and written from scratch
for KRH Client.

## WOK Client (GPL-3.0, code adapted)

- Source: https://github.com/Alx8g/wok-client
- License: GPL-3.0 (KRH Client is GPL-3.0 as well, full text in `LICENSE`)

Used for:

- `src/preload/motion-blur.ts`: adapted from WOK Client's `src/motion-blur.ts`. Changes: code style, element ids,
  removal of WOK's preferences helper and weapon-loader check, and a small settings wrapper (`setMotionBlur`).
- The Quick Class Picker styling in `src/preload/menu-tweaks.ts`, adapted from WOK Client's
  `assets/quickClassPicker.css` and `hiddenClassesImages()`.

## Kute (GPL-3.0, code adapted)

- Source: https://github.com/NullDev/Kute
- License: GPL-3.0 (full text in `LICENSE`)

Used for:

- `src/preload/menu-tweaks.ts` (Classic Menu): the rules of Kute's `classicMenu.css`, with the same declarations.
- `src/preload/chat-draft.ts`: adapted from `chatDraft.js`, rewritten in TypeScript and made switchable at runtime.
- `src/preload/end-message.ts`: adapted from `accountEndMessage.js`, rewritten in TypeScript; the messages are stored by
  KRH Client's main process instead of Kute's host bridge.
- `assets/example-userscripts/classRoulette.js` and `quickSellByRarity.js`: included **unmodified**. Their headers
  name MIT as their license (authors: Kute / aashten). They are also covered by Kute's GPL-3.0 repository license.
- Ideas only, written for KRH Client: Ranked Match Alert (`src/preload/ranked-alert.ts`, `krh-ranked-found` in the
  main process) and Disable Video Skins (a request filter in the main process).

No part of Kute's website, API or native components is used.

## NM/NZ Client (GPL-3.0-or-later, code adapted)

- Source: https://github.com/nmallik1029/nm-nez-client
- License: GPL-3.0-or-later (KRH Client is GPL-3.0 as well, full text in `LICENSE`)

Code adapted for KRH Client (each of these files carries a header naming its NM/NZ source file and what was changed):

- `src/shared/lite-update.ts`, `src/main/lite-swap.ts`, `src/main/lite-update.ts`, `scripts/lite-release.mjs`: updating
  without the installer (only `app.asar` plus a SHA-512 checked manifest). Changes: `app.asar` only, 4-part versions,
  KRH release repository and runtime pin, retry of stalled downloads.
- `src/shared/escape-lock.ts`, `src/main/escape-lock.ts`, `src/preload/escape-lock.ts`: Escape without the two second
  wait before the mouse can be captured again. Changes: a settings switch, KRH IPC channel names.
- `src/shared/accuracy.ts`, `src/preload/game-sound.ts`, `src/preload/hud-counter.ts`, `src/preload/live-accuracy.ts`:
  live match and life accuracy. Changes: KRH styling, death detection through `#uiBase`, KRH headshot replays not counted.
- `src/preload/frame-stats.ts`, `src/preload/perf-hud.ts`: frame-time HUD (FPS and 1% / 0.1% lows).
- `src/shared/presets.ts`, `src/preload/game-settings.ts`: sensitivity and FOV presets. Changes: setting ids inlined,
  presets are managed from Settings > Extras.
- `src/preload/name-colors.ts`: friend and clan name colours. Changes: the lists are edited in Settings instead of
  being part of the source.
- The Linux launcher logic in `scripts/afterPack-linux.js` (root, setuid sandbox, X server check) and the extra hosts in
  the request blocklist.

Ideas only (written for KRH Client): the crosshair picture kept as bytes inside the settings.
Not taken: the Fortnite and Valorant sound packs (ripped from copyrighted games) and the `nmnez://` tournament links.

