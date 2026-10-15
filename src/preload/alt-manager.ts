// ── Alt Manager ──
// Saved-account quick switching: the credential login flow, the shared IPC data
// operations, the settings-panel section, and the in-game header popup.

import { ipcRenderer } from 'electron';
import { escapeHtml, showToast } from './utils';
import { savedConsole as _console } from './saved-console';
import { showConfirm } from './confirm-dialog';
import { createRowShell } from './settings-controls';

// Tracks the open in-game Alt Manager modal so the header button can toggle it.
let altModalClose: (() => void) | null = null;

function submitLogin(account: { username: string; password: string }): void {
  (window as any).loginOrRegister();
  queueMicrotask(() => {
    const toggleBtn = document.querySelector('.auth-toggle-btn') as HTMLElement;
    if (toggleBtn && toggleBtn.textContent?.includes('username')) toggleBtn.click();
    queueMicrotask(() => {
      const nameInput = document.querySelector('#accName') as HTMLInputElement;
      const passInput = document.querySelector('#accPass') as HTMLInputElement;
      if (!nameInput || !passInput) return;
      nameInput.value = account.username;
      passInput.value = account.password;
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      const submitBtn = document.querySelector('.io-button') as HTMLElement;
      if (submitBtn) submitBtn.click();
    });
  });
}

// Krunker's API calls wait on an FRVR token; logoutAcc() deletes it and nothing on the page makes a new one.
async function ensureFrvrSession(): Promise<void> {
  const auth = (window as any).FRVR?.auth;
  if (typeof auth?.isLoggedIn === 'function' && !auth.isLoggedIn()) await auth.loginAsAnonymous();
}

// ── Shared alt-manager data operations ──
// Both the settings-panel section and the in-game popup drive the same IPC
// handlers; keeping the calls here means the contract lives in one place.
type AltAccount = { label: string; avatarUrl: string | null };

function altList(): Promise<AltAccount[]> {
  return ipcRenderer.invoke('alt-list').then((list: AltAccount[] | null) => list || []);
}

// Tell main which saved account is currently logged in so it can store that
// account's avatar for next time. We read the username plus the avatar Krunker
// itself rendered in the header — the custom picture for premium accounts, or
// Krunker's default avatar for non-premium ones — and main matches the decrypted
// username. Only the current login is read, never other accounts' details.
function linkCurrentAccount(): Promise<unknown> {
  let username = '';
  try {
    username = localStorage.getItem('krunker_username') || '';
  } catch { /* localStorage unavailable */ }
  const avatar = document.querySelector('.ph-avatar') as HTMLImageElement | null;
  const avatarUrl = avatar?.src || '';
  if (!username || !avatarUrl) return Promise.resolve(null);
  return ipcRenderer.invoke('alt-link-current', username, avatarUrl).catch(() => null);
}

// Avatar <img> when we have the account's captured URL, else an initial-letter
// circle. wireAvatarFallback swaps the img back to initials if it fails to load.
function avatarMarkup(label: string, avatarUrl: string | null): string {
  const initial = escapeHtml((label[0] || '?').toUpperCase());
  if (avatarUrl) {
    return '<img class="krh-acc-avatar krh-acc-avatar-img" data-initial="' + initial +
      '" src="' + escapeHtml(avatarUrl) + '">';
  }
  return '<div class="krh-acc-avatar">' + initial + '</div>';
}

function wireAvatarFallback(root: ParentNode): void {
  root.querySelectorAll('img.krh-acc-avatar-img').forEach((img) => {
    img.addEventListener('error', () => {
      const div = document.createElement('div');
      div.className = 'krh-acc-avatar';
      div.textContent = (img as HTMLElement).getAttribute('data-initial') || '?';
      img.replaceWith(div);
    }, { once: true });
  });
}

function altSave(label: string, username: string, password: string): Promise<unknown> {
  return ipcRenderer.invoke('alt-save', { label, username, password });
}

function altRemove(index: number): Promise<unknown> {
  return ipcRenderer.invoke('alt-remove', index);
}

const isSignedIn = (): boolean => !!document.querySelector('#signedInHeaderBar');

/** Krunker's own popup after a login with another account: "Different Account used this Session. Please refresh." */
function sessionTakenOver(): boolean {
  return (document.body?.textContent || '').toLowerCase().includes('different account used this session');
}

function lsGet(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

/** Poll until check() is true (checked right away, then every stepMs). Resolves false on timeout. */
async function waitFor(check: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= end) return false;
    await new Promise<void>((r) => setTimeout(r, stepMs));
  }
}

async function altSwitch(index: number): Promise<void> {
  try {
    const creds: { username: string; password: string } | null = await ipcRenderer.invoke('alt-get-credentials', index);
    if (!creds) {
      _console.warn('[KRH-Alt] No stored credentials for account index ' + index);
      return;
    }
    const w = window as any;
    if (typeof w.loginOrRegister !== 'function') {
      _console.warn('[KRH-Alt] loginOrRegister unavailable; cannot switch account');
      return;
    }
    // What the page looked like before, so that the NEW login can be told apart from the old one.
    // (Values stay in memory only; they are compared and never logged or stored.)
    const target = creds.username.trim().toLowerCase();
    const userBefore = lsGet('krunker_username');
    const tokenBefore = lsGet('krunker_token');
    const popupBefore = sessionTakenOver(); // already on screen from earlier: then it says nothing about this switch
    const wasSignedIn = isSignedIn();
    const canLogout = typeof w.logoutAcc === 'function';
    if (wasSignedIn && canLogout) w.logoutAcc();
    // Krunker does not always redraw its header after an in-page login, so the header is only a backup signal
    const sawLoggedOut = wasSignedIn ? (canLogout && await waitFor(() => !isSignedIn(), 3000, 100)) : true;
    await ensureFrvrSession();
    submitLogin(creds);

    const onTarget = (): boolean => lsGet('krunker_username').trim().toLowerCase() === target;
    // Main signal: Krunker shows "Different Account used this Session. Please refresh." once the new login went through.
    // Backups: the page holds the target account's name and it changed since before (the name itself, or the session
    // token when switching to the very account that was already active), or the header came back after a logout.
    const switched = (): boolean =>
      (!popupBefore && sessionTakenOver())
      || (onTarget() && (lsGet('krunker_username') !== userBefore || lsGet('krunker_token') !== tokenBefore))
      || (sawLoggedOut && isSignedIn());

    let ok = await waitFor(switched, 20000);
    // Last chance: the page says it is the target account, even if we could not see it change.
    // Only reached after the full wait, so the login has had its time to finish.
    if (!ok && onTarget() && lsGet('krunker_username') !== '') ok = true;
    if (!ok) {
      _console.warn(`[KRH-Alt] Login not confirmed (popup: ${sessionTakenOver()}, name matches target: ${onTarget()}, header signed in: ${isSignedIn()})`);
      showToast('Could not confirm the login. Refresh the page if the account did not change.');
      return;
    }
    _console.log(`[KRH-Alt] Login confirmed (popup: ${sessionTakenOver()}, name matches target: ${onTarget()}, header signed in: ${isSignedIn()}), refreshing`);
    // The popup can arrive a moment before the page has stored the new login: let that finish before reloading
    await waitFor(onTarget, 3000);
    await new Promise<void>((r) => setTimeout(r, 120));
    // No avatar is saved here: the header is often still the old account's until the reload. It is saved
    // when the account list is opened after the reload (linkCurrentAccount), when the header is correct.
    location.reload();
  } catch (err) {
    _console.error('[KRH-Alt] Account switch failed:', err);
  }
}

// Quick alt login hotkeys (Ctrl+Alt+1/2/3), sent from the main process.
ipcRenderer.on('alt-quick-login', (_e, index: number) => { void altSwitch(index); });

// ── Settings-panel section ──
export function buildAccountsSection(body: HTMLElement, onPopulated?: () => void): void {
  // Labels only — fetched via alt-list (never the generic config getter, which
  // no longer exposes the 'accounts' key). Indices line up with the stored array.
  const accounts: AltAccount[] = [];

  const { row: addBtn, control: addControl } = createRowShell('Add Account', 'Save a Krunker account for quick switching');
  const addToggleBtn = document.createElement('button');
  addToggleBtn.className = 'krh-acc-add-toggle';
  addToggleBtn.textContent = '+ Add';
  addControl.appendChild(addToggleBtn);
  body.appendChild(addBtn);

  const form = document.createElement('div');
  form.className = 'krh-acc-form';
  form.style.display = 'none';
  form.innerHTML =
    '<input type="text" placeholder="Label (e.g. Main, Alt1)" class="krh-acc-label">' +
    '<input type="text" placeholder="Krunker Username" class="krh-acc-user">' +
    '<input type="password" placeholder="Krunker Password" class="krh-acc-pass">' +
    '<div class="krh-acc-form-buttons">' +
      '<button class="krh-acc-cancel">Cancel</button>' +
      '<button class="krh-acc-save">Save</button>' +
    '</div>';
  body.appendChild(form);

  const labelIn = form.querySelector('.krh-acc-label') as HTMLInputElement;
  const userIn = form.querySelector('.krh-acc-user') as HTMLInputElement;
  const passIn = form.querySelector('.krh-acc-pass') as HTMLInputElement;

  // Stop Krunker's global keydown handler from eating keystrokes in our inputs
  form.querySelectorAll('input').forEach(input => {
    input.addEventListener('keydown', (e) => e.stopPropagation());
  });

  addToggleBtn.addEventListener('click', () => {
    form.style.display = form.style.display === 'none' ? '' : 'none';
  });

  form.querySelector('.krh-acc-cancel')!.addEventListener('click', () => {
    form.style.display = 'none';
  });

  const listEl = document.createElement('div');
  body.appendChild(listEl);

  function renderList(): void {
    listEl.innerHTML = '';
    if (accounts.length === 0) {
      listEl.innerHTML = '<div class="krh-acc-empty">No saved accounts</div>';
      onPopulated?.();
      return;
    }
    accounts.forEach((acc, i) => {
      const row = document.createElement('div');
      row.className = 'krh-acc-item';
      row.innerHTML =
        avatarMarkup(acc.label, acc.avatarUrl) +
        '<span class="krh-acc-item-label">' + escapeHtml(acc.label) + '</span>' +
        '<div class="krh-acc-item-actions">' +
          '<button class="krh-acc-switch">Switch</button>' +
          '<button class="krh-acc-delete">Delete</button>' +
        '</div>';
      wireAvatarFallback(row);
      row.querySelector('.krh-acc-switch')!.addEventListener('click', () => {
        altSwitch(i);
      });
      row.querySelector('.krh-acc-delete')!.addEventListener('click', () => {
        showConfirm({
          title: 'Delete Account',
          message: 'Delete the saved account "' + (acc.label || '') + '"?',
          confirmLabel: 'Delete', danger: true,
        }).then((ok) => {
          if (!ok) return;
          altRemove(i).then(() => {
            accounts.splice(i, 1);
            renderList();
          });
        });
      });
      listEl.appendChild(row);
    });
    onPopulated?.();
  }
  linkCurrentAccount().then(altList).then((list) => {
    accounts.push(...list);
    renderList();
  });

  form.querySelector('.krh-acc-save')!.addEventListener('click', () => {
    const label = labelIn.value.trim();
    const user = userIn.value.trim();
    const pass = passIn.value;
    if (!label || !user || !pass) return;
    altSave(label, user, pass).then(() => {
      accounts.push({ label, avatarUrl: null });
      labelIn.value = '';
      userIn.value = '';
      passIn.value = '';
      form.style.display = 'none';
      renderList();
    }).catch((err) => _console.error('[KRH-Alt] Failed to save account:', err));
  });
}

// ── In-game header popup (the "Accounts" button + Alt Manager window) ──
export function initAltManagerButton(): void {
  altList().then(() => {
    const altBtn = document.createElement('div');
    altBtn.id = 'krhAltBtn';
    altBtn.setAttribute('onmouseenter', 'playTick()');

    function showAltManager(): void {
      // Toggle: clicking the header button again closes the open modal.
      if (altModalClose) { altModalClose(); return; }

      const backdrop = document.createElement('div');
      backdrop.id = 'krhAltModal';
      backdrop.className = 'krh-alt-backdrop';
      const modal = document.createElement('div');
      modal.className = 'krh-alt-modal';
      backdrop.appendChild(modal);

      function close(): void {
        document.removeEventListener('keydown', onKey, true);
        ipcRenderer.send('keybind-capture', false);
        backdrop.remove();
        altModalClose = null;
      }
      function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      }

      function headerHtml(title: string, withBack: boolean): string {
        return '<div class="krh-alt-header">' +
          '<div class="krh-alt-header-left">' +
            (withBack ? '<div class="krh-alt-back" title="Back">‹</div>' : '') +
            '<h2>' + title + '</h2>' +
          '</div>' +
          '<div class="krh-alt-close" title="Close">✕</div>' +
        '</div>';
      }

      function renderList(): void {
        linkCurrentAccount().then(altList).then((accs) => {
          let rows = '';
          if (!accs || accs.length === 0) {
            rows = '<div class="krh-acc-empty">No saved accounts</div>';
          } else {
            accs.forEach((acc, i) => {
              rows +=
                '<div class="krh-acc-item">' +
                  avatarMarkup(acc.label, acc.avatarUrl) +
                  '<span class="krh-acc-item-label">' + escapeHtml(acc.label) + '</span>' +
                  '<div class="krh-acc-item-actions">' +
                    '<button class="krh-acc-switch" data-idx="' + i + '">Switch</button>' +
                    '<button class="krh-acc-delete" data-idx="' + i + '">Delete</button>' +
                  '</div>' +
                '</div>';
            });
          }
          modal.innerHTML = headerHtml('Alt Manager', false) +
            '<div class="krh-alt-body">' +
              '<button class="krh-acc-add-btn">+ Add Account</button>' +
              rows +
            '</div>';
          wireAvatarFallback(modal);

          (modal.querySelector('.krh-alt-close') as HTMLElement).addEventListener('click', close);
          (modal.querySelector('.krh-acc-add-btn') as HTMLElement).addEventListener('click', renderForm);
          modal.querySelectorAll('.krh-acc-switch').forEach((el) => {
            el.addEventListener('click', () => {
              const idx = parseInt((el as HTMLElement).dataset.idx || '0', 10);
              if (accs[idx]) { close(); altSwitch(idx); }
            });
          });
          modal.querySelectorAll('.krh-acc-delete').forEach((el) => {
            el.addEventListener('click', () => {
              const idx = parseInt((el as HTMLElement).dataset.idx || '0', 10);
              showConfirm({
                title: 'Delete Account',
                message: 'Delete the saved account "' + (accs[idx]?.label || '') + '"?',
                confirmLabel: 'Delete', danger: true,
              }).then((ok) => { if (ok) altRemove(idx).then(() => renderList()); });
            });
          });
        });
      }

      function renderForm(): void {
        modal.innerHTML = headerHtml('Add Account', true) +
          '<div class="krh-alt-body">' +
            '<div class="krh-acc-form">' +
              '<input type="text" class="krh-acc-label" placeholder="Label (e.g. Main, Alt1)">' +
              '<input type="text" class="krh-acc-user" placeholder="Krunker Username">' +
              '<input type="password" class="krh-acc-pass" placeholder="Krunker Password">' +
              '<div class="krh-acc-form-buttons">' +
                '<button class="krh-acc-cancel">Cancel</button>' +
                '<button class="krh-acc-save">Add Account</button>' +
              '</div>' +
            '</div>' +
          '</div>';

        (modal.querySelector('.krh-alt-close') as HTMLElement).addEventListener('click', close);
        (modal.querySelector('.krh-alt-back') as HTMLElement).addEventListener('click', renderList);
        (modal.querySelector('.krh-acc-cancel') as HTMLElement).addEventListener('click', renderList);

        const labelIn = modal.querySelector('.krh-acc-label') as HTMLInputElement;
        const userIn = modal.querySelector('.krh-acc-user') as HTMLInputElement;
        const passIn = modal.querySelector('.krh-acc-pass') as HTMLInputElement;
        // Stop Krunker's global keydown handler from eating keystrokes in our inputs
        modal.querySelectorAll('input').forEach((input) => {
          input.addEventListener('keydown', (e) => e.stopPropagation());
        });

        (modal.querySelector('.krh-acc-save') as HTMLElement).addEventListener('click', () => {
          const label = labelIn.value.trim();
          const user = userIn.value.trim();
          const pass = passIn.value;
          if (!label || !user || !pass) return;
          altSave(label, user, pass).then(() => renderList()).catch((err) => _console.error('[KRH-Alt] Failed to save account:', err));
        });
      }

      document.addEventListener('keydown', onKey, true);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
      document.body.appendChild(backdrop);
      ipcRenderer.send('keybind-capture', true);
      altModalClose = close;
      renderList();
    }

    altBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      (window as any).playSelect?.();
      showAltManager();
    });

    function injectAltBtn(): boolean {
      if (document.getElementById('krhAltBtn')) return true;
      const headerRight = document.querySelector('.headerBarRight');
      if (!headerRight) return false;

      // Krunker's header items use Svelte-scoped classes (e.g. svelte-11p80bh).
      // Copy the hash off a sibling so our button picks up the same styles.
      const ref = headerRight.querySelector('.nav-item');
      const scoped = ref
        ? Array.from(ref.classList).find((c) => c.startsWith('svelte-')) || ''
        : '';
      const sfx = scoped ? ' ' + scoped : '';
      altBtn.className = 'nav-item' + sfx;
      altBtn.setAttribute('role', 'button');
      altBtn.setAttribute('tabindex', '0');
      altBtn.innerHTML =
        '<span class="material-icons nav-mat-icon' + sfx + '" style="color:#4fc3f7">people</span>' +
        '<span class="nav-label' + sfx + '">Accounts</span>';

      const sep = document.createElement('div');
      sep.id = 'krhAltBtnSep';
      sep.className = 'verticalSeparator';
      sep.setAttribute('style', 'height:35px;');

      headerRight.insertBefore(altBtn, headerRight.firstChild);
      headerRight.insertBefore(sep, altBtn.nextSibling);
      return true;
    }

    if (!injectAltBtn()) {
      let attempts = 0;
      const poll = setInterval(() => {
        if (injectAltBtn() || ++attempts > 60) clearInterval(poll);
      }, 500);
    }
  });
}
