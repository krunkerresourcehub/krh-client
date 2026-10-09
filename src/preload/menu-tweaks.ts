// ── Menu tweaks ──
// Main-menu features: hiding promotional popups, the "Classic Social" menu
// item, and the Mod Manager opener. All pure DOM/Krunker-global code (no IPC).

// ── Hide menu popups ──
// Bundle/claim popups need clearPops(), not CSS — Krunker renders them via
// #popupHolder + #popupBack (the dim backdrop), so CSS-only hiding leaves the
// backdrop visible (the "dark screen") and breaks user-clicked bundles in the
// shop. Only unsolicited popups (pushed by the game with no recent user
// input) are dismissed: bundles opened by clicking — in the shop window, or
// directly on the main menu (home-store ad, KrunkCup widget) — must survive
// so they can be viewed and purchased.
// .nav-notif-section is the header "Notifications" widget; hide the whole
// section (not just its inner .webpush-container) plus its trailing
// .verticalSeparator, otherwise the collapsed section leaves a doubled-up
// pillar between Inbox and Settings.
const HIDE_POPUPS_CSS =
  '#leftTabsHolder > .youNewDiv:not(#battlepassAd), ' +
  '.nav-notif-section, .nav-notif-section + .verticalSeparator, ' +
  '#homeStoreAd, #streamContainerNew, .streams-overlay, ' +
  '#newsHolder, #streamContainer { display: none !important; }';
const USER_INTENT_WINDOW_MS = 2500;
let _hidePopupsStyle: HTMLStyleElement | null = null;
const _hidePopupsObservers: MutationObserver[] = [];
let _lastPointerDown = 0;

function notePointerDown(): void {
  // Pointer-locked clicks are gameplay (shooting), never popup-opening intent.
  if (document.pointerLockElement) return;
  _lastPointerDown = Date.now();
}

function dismissPromos(): void {
  // A popup appearing right after a click was opened by the user, not pushed.
  if (Date.now() - _lastPointerDown < USER_INTENT_WINDOW_MS) return;
  const wh = document.getElementById('windowHolder');
  if (wh && wh.style.display && wh.style.display !== 'none') return;
  const bp = document.getElementById('bundlePop');
  const gp = document.getElementById('genericPop');
  if (!bp?.children.length && !gp?.classList.contains('claimPop')) return;
  (window as any).clearPops?.();
}

export function startHidePopups(): void {
  if (_hidePopupsStyle) return;
  _hidePopupsStyle = document.createElement('style');
  _hidePopupsStyle.id = 'krh-hideMenuPopups';
  _hidePopupsStyle.textContent = HIDE_POPUPS_CSS;
  document.head.appendChild(_hidePopupsStyle);

  document.addEventListener('pointerdown', notePointerDown, true);

  const bp = document.getElementById('bundlePop');
  if (bp) {
    const obs = new MutationObserver(dismissPromos);
    obs.observe(bp, { childList: true });
    _hidePopupsObservers.push(obs);
  }
  const gp = document.getElementById('genericPop');
  if (gp) {
    const obs = new MutationObserver(dismissPromos);
    obs.observe(gp, { attributes: true, attributeFilter: ['class'] });
    _hidePopupsObservers.push(obs);
  }
  dismissPromos(); // Catch popups already showing
}

export function stopHidePopups(): void {
  if (!_hidePopupsStyle) return;
  _hidePopupsStyle.remove();
  _hidePopupsStyle = null;
  document.removeEventListener('pointerdown', notePointerDown, true);
  for (const obs of _hidePopupsObservers) obs.disconnect();
  _hidePopupsObservers.length = 0;
}

// ── Classic Social ──
// Injects a second menu item below "Social" that opens the standalone
// /social.html page in a tab (pre-9.2 behaviour). Hidden by default;
// the setting toggles its visibility.
let _classicSocialPoll: number | null = null;

function injectClassicSocialBtn(): boolean {
  if (document.getElementById('krhClassicSocialBtn')) return true;
  const socialItem = document.getElementById('menuBtnSocial')?.closest('.menuItem');
  if (!socialItem || !socialItem.parentNode) return false;

  const scoped = Array.from(socialItem.classList).find((c) => c.startsWith('svelte-')) || '';
  const sfx = scoped ? ' ' + scoped : '';

  const btn = document.createElement('div');
  btn.id = 'krhClassicSocialBtn';
  btn.className = 'menuItem' + sfx;
  btn.setAttribute('onmouseenter', 'playTick()');
  btn.innerHTML =
    '<span class="material-icons-outlined menuItemIcon' + sfx + '">handshake</span>' +
    '<div class="menuItemTitle' + sfx + '">Classic Social</div>';
  btn.addEventListener('click', () => {
    (window as any).playSelect?.();
    window.open('https://krunker.io/social.html', '_blank');
  });

  socialItem.parentNode.insertBefore(btn, socialItem.nextSibling);
  return true;
}

function removeClassicSocialBtn(): void {
  document.getElementById('krhClassicSocialBtn')?.remove();
  if (_classicSocialPoll !== null) {
    clearInterval(_classicSocialPoll);
    _classicSocialPoll = null;
  }
}

export function setClassicSocial(enabled: boolean): void {
  if (!enabled) {
    removeClassicSocialBtn();
    return;
  }
  if (injectClassicSocialBtn()) return;
  if (_classicSocialPoll !== null) return;
  let attempts = 0;
  _classicSocialPoll = window.setInterval(() => {
    if (injectClassicSocialBtn() || ++attempts > 60) {
      if (_classicSocialPoll !== null) {
        clearInterval(_classicSocialPoll);
        _classicSocialPoll = null;
      }
    }
  }, 500);
}

// ── Mod Manager button (ranked menu) ──
// The ranked/comp menu (#mMenuHolComp) has no mod UI. This appends a button to
// its icon row (#compBtnLst) that opens the Mod Manager window (windows[3])
// via showWindow(4), matching the row's native buttons (Loadout/Customize/
// Settings are showWindow calls too). The row lives inside the comp holder, so
// Krunker shows/hides it with the rest of the ranked menu.
function injectModManagerBtn(): boolean {
  if (document.getElementById('krhModManagerBtn')) return true;
  const btnList = document.getElementById('compBtnLst');
  if (!btnList) return false;

  const btn = document.createElement('div');
  btn.id = 'krhModManagerBtn';
  btn.className = 'compMenBtnS';
  btn.title = 'Mod Manager';
  btn.style.backgroundColor = '#3489eb';
  btn.setAttribute('onmouseenter', 'SOUND.play("tick_0",.1)');
  btn.innerHTML =
    '<span class="material-icons" style="color:#fff;font-size:40px;vertical-align:middle;margin-bottom:12px">extension</span>';
  btn.addEventListener('click', () => {
    (window as any).playSelect?.();
    (window as any).showWindow?.(4);
  });

  btnList.appendChild(btn);
  return true;
}

export function initModManagerButton(): void {
  if (injectModManagerBtn()) return;
  let attempts = 0;
  const poll = window.setInterval(() => {
    if (injectModManagerBtn() || ++attempts > 60) clearInterval(poll);
  }, 500);
}

// ── Cleaner Menu + Selectable Chat (ported from Glorp) ──
function setStyleTag(id: string, css: string, on: boolean): void {
  const existing = document.getElementById(id);
  if (!on) { existing?.remove(); return; }
  if (existing) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  (document.head || document.documentElement).appendChild(el);
}

// Glorp's "Cleaner Menu" list, minus the Quick Match and Editor buttons (KRH keeps those reachable).
const CLEAN_MENU_CSS =
  '.settingsBtn[style*="width:auto;background-color:#994cd1"], .setSugBox2, .advancedSwitch, .menuSocialB, ' +
  '.serverHostOpH, .signup-rewards-container, #tlInfHold, #gameNameHolder, #termsInfo, #bubbleContainer, ' +
  '#instructions:only-child, #mapInfoHld, #krDiscountAd, #classPreviewCanvas, #menuClassSubtext, ' +
  '#settingsPreset, #menuClassName, #menuClassIcn, #streamContainerNew { display: none !important; } ' +
  '.verticalSeparator, .verticalSeparatorInline { visibility: hidden !important; } ' +
  '#mLevelCont { background-color: transparent !important; } ' +
  '#uiBase.onMenu #spectButton { top: 94% !important; } ' +
  '.headerBarRight { right: -23px !important; } ' +
  '.headerBarLeft, .headerBarRight, #menuItemContainer { background-color: transparent !important; }';

export function setCleanMenu(on: boolean): void {
  setStyleTag('krh-cleanMenu', CLEAN_MENU_CSS, on);
}

export function setSelectableChat(on: boolean): void {
  setStyleTag('krh-selectableChat', '#chatHolder * { user-select: text !important; }', on);
}

// ── Quick Class Picker ──
// Idea and CSS from WOK Client (https://github.com/Alx8g/wok-client, assets/quickClassPicker.css and
// hiddenClassesImages() in src/utils.ts), GPL-3.0-only. Adapted for KRH Client 1.0.1.
// Krunker already renders a hidden row of class pickers (#hiddenClasses); this just shows it above the
// play buttons with each class icon, so one click switches class.
const CLASS_COUNT = 16;

function quickClassPickerCss(classesCount: number): string {
  const gaps = 4 * (classesCount - 1);
  const buttonSize = Math.min(Math.round((810 - gaps) / classesCount), 50); // 810 = width of Krunker's middle element
  let css =
    '#hiddenClasses { display: flex !important; justify-content: space-evenly; align-items: center; column-gap: 4px; ' +
    'position: absolute; bottom: 300px; left: 50%; transform: translate(-50%, 0) scale(.95); pointer-events: all; ' +
    'min-width: 810px; width: min-content; } ' +
    '#hiddenClasses [id^="menuClassPicker"] { border-radius: 5px; display: block; pointer-events: all; ' +
    'background-position: center; background-repeat: no-repeat; image-rendering: pixelated; border: 2px solid transparent; ' +
    'cursor: pointer; transition: background-color 0.2s, border 0.2s; ' +
    `width: ${buttonSize}px; height: ${buttonSize}px; background-size: ${buttonSize - 6}px ${buttonSize - 6}px; } ` +
    '#hiddenClasses [id^="menuClassPicker"]:hover { background-color: #262626; border-color: #313131; } ' +
    '#hiddenClasses [id^="menuClassPicker"]:active { background-color: #393939; border-color: #a3a5aa; } ';
  for (let i = 0; i < classesCount; i++) {
    css += `#menuClassPicker${i} { background-image: url("https://assets.krunker.io/textures/classes/icon_${i}.png"); } `;
  }
  return css;
}

export function setQuickClassPicker(on: boolean): void {
  setStyleTag('krh-quickClassPicker', quickClassPickerCss(CLASS_COUNT), on);
}

// ── Classic Menu (Season 9 layout) ──
// CSS from Kute (https://github.com/NullDev/Kute, src/frontend/components/classicMenu.css), GPL-3.0.
// Adapted for KRH Client 1.0.1. Values come from Krunker's season 9 stylesheet, laid over the season 10 markup.
// Written as one string so it can be switched on and off at runtime.
const CLASSIC_MENU_CSS = `
#uiBase.onMenu #spectButton { top: calc(48% - 60px); }
#instructions { top: 50%; }
#subLogoButtons { right: auto; left: 50%; bottom: 139px; width: 950px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; transform: translate(-50%, 0) scale(0.95); transform-origin: bottom center; }
#matchInfoHolder { grid-column: 1 / -1; position: static; order: -2; box-sizing: border-box; width: 100%; flex-wrap: wrap; justify-content: flex-start; row-gap: 4px; transform: none; padding: 0 0 12px; margin-bottom: 10px; font-size: 20px; background: none; border: none; border-bottom: 5px solid #585858; border-radius: 0; box-shadow: none; backdrop-filter: none; }
#matchInfoHolder > .match-divider:has(+ .match-info-actions) { flex-basis: 100%; height: 0; margin: 0; border: none; background: none; }
#matchInfoHolder > .match-info-actions { padding-left: 7px; }
#mapInfo { font-size: 20px; }
#mapInfoHld { padding-left: 7px; }
#subLogoButtons > .actionCard { grid-column: span 2; justify-content: center; box-sizing: border-box; width: auto; height: auto; padding: 6px 18px; font-size: 27px; text-transform: none; background: rgba(0, 0, 0, 0.2); box-shadow: none; }
#subLogoButtons > .actionCard .cardIcon { display: none; }
#subLogoButtons > .actionCard .cardLabel { font-size: 27px; text-transform: none; letter-spacing: normal; }
#subLogoButtons > #menuBtnQuickMatch, #subLogoButtons > #menuBtnRanked { grid-column: span 3; }
#menuBtnHost, #menuBtnBrowser { border-color: #ed4242 !important; }
#subLogoButtons > .popRail { grid-column: 1 / -1; order: 1; margin-top: 10px; }
#menuClassContainer { left: auto; right: 21px; bottom: 80px; text-align: right; transform: scale(0.7); transform-origin: bottom right; }
#menuClassContainer::before { display: none; }
#menuClassFooter { flex-direction: column; align-items: flex-end; margin: 0 0 0 auto; }
#menuClassContainerInner { justify-content: flex-end; width: 449px; height: 85px; padding: 0; gap: 0; background: none; border: none; }
#menuClassContainerInner:hover { background: none; filter: brightness(1.15); }
#menuClassContainerInfo { height: 85px; justify-content: space-between; }
#menuClassIcn { width: 85px; height: 85px; margin-left: 10px; border: 4px solid #353534; border-radius: 4px; }
#menuClassName { font-size: 17px; }
#menuClassSubtext { font-size: 30px; margin-bottom: 0; }
#classPreviewCanvas { margin-bottom: -100px; margin-right: -113px; }
#customizeButton { box-sizing: border-box; width: 449px; padding: 15px; font-size: 27px !important; }
#bubbleContainer { right: 420px; }
body #uiBase.onMenu .spectateInfo { top: calc(48% - 150px); }
`;

export function setClassicMenu(on: boolean): void {
  setStyleTag('krh-classicMenu', CLASSIC_MENU_CSS, on);
}
