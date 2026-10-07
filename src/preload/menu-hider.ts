// ── Hide menu elements ──
// Pick which parts of the Krunker menu to hide. Elements with a known id are hidden with CSS; the main menu
// entries (Challenges, Leaderboards, ...) are found by their visible title, so this keeps working when
// Krunker reorders the menu (no position based selectors).
// Idea: the "customizations" list of the Water Client (https://github.com/ghostypostie/Water); written from scratch.

export interface HideItem { key: string; label: string; css?: string; title?: RegExp }

export const HIDE_ITEMS: HideItem[] = [
  { key: 'terms', label: 'Terms info', css: '#termsInfo' },
  { key: 'signup', label: 'Signup reward alerts', css: '#signupRewardsButton, .signup-rewards-container, .guest-earned-collect' },
  { key: 'doublexp', label: 'Double XP button', css: '#doubleXPButton, #doubleXPHolder' },
  { key: 'stream', label: 'Live streams panel', css: '.right-panel' },
  { key: 'guide', label: 'Guide', css: '.guideItem' },
  { key: 'quickmatch', label: 'Quick Match button', css: '#menuBtnQuickMatch' },
  { key: 'customgames', label: 'Custom Games button', css: '#menuBtnCustomGames' },
  { key: 'kpdphone', label: 'KPD phone popup', css: '#policePop, #policePopC' },
  { key: 'whatsnew', label: "What's New", title: /^what'?s new/i },
  { key: 'turfwars', label: 'Turf Wars', title: /^turf wars/i },
  { key: 'market', label: 'Market & Trading', title: /^market/i },
  { key: 'store', label: 'Store', title: /^store/i },
  { key: 'challenges', label: 'Challenges', title: /^challenges/i },
  { key: 'leaderboards', label: 'Leaderboards', title: /^leaderboards?/i },
  { key: 'social', label: 'Social', title: /^social/i },
  { key: 'community', label: 'Community & Events', title: /^community/i },
];

const STYLE_ID = 'krh-hide-menu-style';
let hidden = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

function applyCss(): void {
  let st = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement('style');
    st.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(st);
  }
  st.textContent = HIDE_ITEMS.filter((i) => i.css && hidden.has(i.key)).map((i) => `${i.css} { display: none !important; }`).join('\n');
}

function applyTitles(): void {
  const titled = HIDE_ITEMS.filter((i) => i.title);
  document.querySelectorAll<HTMLElement>('.menuItem').forEach((el) => {
    const t = (el.querySelector('.menuItemTitle')?.textContent || '').trim();
    if (!t) return;
    const rule = titled.find((i) => i.title!.test(t));
    if (rule) {
      const hide = hidden.has(rule.key);
      if (hide) { el.style.setProperty('display', 'none', 'important'); el.dataset.krhHidden = '1'; }
      else if (el.dataset.krhHidden) { el.style.removeProperty('display'); delete el.dataset.krhHidden; }
    }
  });
}

export function setHiddenMenu(keys: string[]): void {
  hidden = new Set(keys);
  applyCss();
  applyTitles();
  if (timer) { clearInterval(timer); timer = null; }
  if (hidden.size > 0 || document.querySelector('[data-krh-hidden]')) {
    // The menu is rebuilt by the game now and then: re-apply every couple of seconds, but never while aiming.
    timer = setInterval(() => { if (!document.pointerLockElement) applyTitles(); }, 2500);
  }
}
