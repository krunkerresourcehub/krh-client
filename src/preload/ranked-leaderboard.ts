// ── Ranked leaderboard search ──
// Based on the "ranked_leaderboard.js" userscript by LombreScripts. On the social/leaderboard page it
//   1. asks the ranked API for the top 1000 players instead of 50, and
//   2. adds a "Search players..." box that filters the table (with the match highlighted).
// Changes from the original script: player names are never inserted as HTML (the original rebuilt rows
// with innerHTML, which would let a crafted player name inject markup), the page observer is debounced
// and no longer re-binds listeners on every DOM change, retries are capped, and the class selectors
// no longer depend on Svelte's generated hash suffixes (which change whenever Krunker rebuilds).
//
// Since Krunker season 9.1 the leaderboards also live inside the main game window, so this now runs on the
// game page too (not only /social.html). The URL / selector matching is deliberately loose, and on the game
// page a cheap 1s poll replaces the MutationObserver (observers on the main frame hang WebGL).

import { webFrame } from 'electron';

// Runs in the PAGE's JavaScript world (needed to wrap the page's own window.fetch).
// NOTE: no backticks or dollar-brace sequences in here, it is a plain string.
const PAGE_CODE = String.raw`(function () {
  if (window.__krhRankedLb) return;
  window.__krhRankedLb = true;

  var IS_GAME = location.pathname === '/' || location.pathname === '';
  var originalFetch = window.fetch;
  function isRankingUrl(u) {
    return /krunker\.io\/leaderboards?\//i.test(u) && /[?&]limit=\d+/.test(u);
  }

  window.fetch = function () {
    var args = Array.prototype.slice.call(arguments);
    var input = args[0];
    var url = typeof input === 'string' ? input : (input && input.url) || '';

    if (!isRankingUrl(url) || window.__krhRankedLbOff) return originalFetch.apply(this, args);

    var m = url.match(/([?&]limit=)(\d+)/);
    if (m && Number(m[2]) < 1000) {
      var bigger = url.replace(m[0], m[1] + '1000');
      args[0] = typeof input === 'string' ? bigger : new Request(bigger, input);
    }
    return originalFetch.apply(this, args).then(function (response) {
      response.clone().json().then(function () {
        var old = document.querySelector('.krunker-search-container');
        if (old) old.remove();
        setupSearchBar(0);
      }).catch(function () { /* not JSON / failed request: leave the page alone */ });
      return response;
    });
  };

  function setupSearchBar(attempt) {
    var existing = document.querySelector('.krunker-search-container');
    if (existing) existing.remove();

    var anchor = document.querySelector('.region-indicator') || document.querySelector('.data-table');
    if (!anchor || !anchor.parentNode) {
      if (attempt < 40) setTimeout(function () { setupSearchBar(attempt + 1); }, 500);
      return;
    }

    var box = document.createElement('div');
    box.className = 'krunker-search-container';
    box.style.cssText = 'position:relative;display:inline-flex;align-items:center;margin:0 8px;flex:0 1 170px;min-width:70px;max-width:170px;';

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search players...';
    input.className = 'krunker-search-input';
    input.setAttribute('autocomplete', 'off');
    input.style.cssText = 'padding:8px 12px;border:2px solid rgba(255,255,255,0.1);border-radius:8px;' +
      'background:rgba(0,0,0,0.3);color:#fff;font-family:inherit;font-size:14px;font-weight:500;outline:none;' +
      'transition:all 0.3s cubic-bezier(0.4,0,0.2,1);width:100%;min-width:0;box-sizing:border-box;backdrop-filter:blur(10px);' +
      'box-shadow:inset 0 1px 3px rgba(0,0,0,0.3);';
    box.appendChild(input);

    input.addEventListener('focus', function () {
      input.style.background = 'rgba(0,0,0,0.4)';
      input.style.borderColor = 'rgba(255,255,255,0.3)';
      input.style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.3), 0 0 0 3px rgba(255,255,255,0.05)';
    });
    input.addEventListener('blur', function () {
      input.style.background = 'rgba(0,0,0,0.3)';
      input.style.borderColor = 'rgba(255,255,255,0.1)';
      input.style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.3)';
    });

    if (!document.getElementById('krunker-search-style')) {
      var style = document.createElement('style');
      style.id = 'krunker-search-style';
      style.textContent = '.krunker-search-input::placeholder{color:rgba(255,255,255,0.4);}' +
        // keep the header row inside its panel: the region label never wraps / spills out
        '.region-indicator{white-space:nowrap;flex:0 0 auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;}';
      document.head.appendChild(style);
    }

    anchor.parentNode.insertBefore(box, anchor);
    bindSearch(input, 0);
  }

  var bound = { tbody: null, rows: -1 };

  function nameLink(row) {
    return row.querySelector('.name-cell a') || row.querySelector('td a');
  }

  function dataRows(tbody) {
    return Array.prototype.filter.call(tbody.querySelectorAll('tr'), function (r) {
      return !r.classList.contains('krunker-no-results');
    });
  }

  function bindSearch(input, attempt) {
    var tbody = document.querySelector('.data-table tbody');
    if (!tbody) {
      if (attempt < 40) setTimeout(function () { bindSearch(input, attempt + 1); }, 500);
      return;
    }
    var rows = dataRows(tbody);
    var names = rows.map(function (row) {
      var a = nameLink(row);
      return a ? a.textContent : '';
    });
    bound.tbody = tbody;
    bound.rows = rows.length;

    function filterRows(raw) {
      var term = raw.toLowerCase().trim();
      var visible = 0;

      rows.forEach(function (row, i) {
        var cell = nameLink(row);
        if (!cell) return;
        var name = names[i];
        var lower = name.toLowerCase();
        if (term === '' || lower.indexOf(term) !== -1) {
          row.style.display = '';
          visible++;
          cell.textContent = '';
          if (term === '') {
            cell.textContent = name;
          } else {
            var s = lower.indexOf(term), e = s + term.length;
            var mark = document.createElement('span');
            mark.style.cssText = 'background:rgba(255,215,0,0.3);color:#FFD700;font-weight:600;padding:2px 4px;border-radius:3px;';
            mark.textContent = name.substring(s, e);
            cell.appendChild(document.createTextNode(name.substring(0, s)));
            cell.appendChild(mark);
            cell.appendChild(document.createTextNode(name.substring(e)));
          }
        } else {
          row.style.display = 'none';
        }
      });

      var old = tbody.querySelector('.krunker-no-results');
      if (old) old.remove();
      if (visible === 0 && term !== '') {
        var tr = document.createElement('tr');
        tr.className = 'krunker-no-results';
        var td = document.createElement('td');
        var table = tbody.closest('table');
        td.colSpan = (table && table.querySelectorAll('thead th').length) || 5;
        td.style.cssText = 'text-align:center;padding:40px 20px;color:rgba(255,255,255,0.5);font-size:16px;';
        var hi = document.createElement('span');
        hi.style.color = '#FFD700';
        hi.textContent = raw;
        td.appendChild(document.createTextNode('No players found matching "'));
        td.appendChild(hi);
        td.appendChild(document.createTextNode('"'));
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    }

    // oninput/onkeydown (assignment) replaces the previous handler instead of stacking a new one.
    input.oninput = function (ev) { filterRows(ev.target.value); };
    input.onkeydown = function (ev) {
      ev.stopPropagation(); // keep typed letters away from page hotkeys
      if (ev.key === 'Escape') { input.value = ''; filterRows(''); input.blur(); }
    };
    if (input.value) filterRows(input.value);
  }

  // The table is re-rendered when the season/region/page changes: re-bind to the new rows.
  var timer = null;
  function onDomChange() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      var input = document.querySelector('.krunker-search-input');
      var tbody = document.querySelector('.data-table tbody');
      if (!input || !tbody) return;
      if (tbody !== bound.tbody || dataRows(tbody).length !== bound.rows) bindSearch(input, 0);
    }, 200);
  }
  function onPoll() {
    if (document.pointerLockElement) return; // aiming: nothing to do, skip the DOM reads
    var table = document.querySelector('.data-table tbody');
    if (!table) return;
    if (!document.querySelector('.krunker-search-input')) setupSearchBar(0);
    else onDomChange();
  }
  function startObserver() {
    if (IS_GAME) { setInterval(onPoll, 1000); return; }
    new MutationObserver(onDomChange).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);
})();`;

/** Install the leaderboard hook. Call as early as possible on social pages (before the page fetches). */
export function installRankedLeaderboardSearch(): void {
  void webFrame.executeJavaScript(PAGE_CODE).catch(() => { /* page not ready / CSP: ignore */ });
}

/** Turn the feature off for this page (used when the user disabled it in settings). */
export function disableRankedLeaderboardSearch(): void {
  void webFrame.executeJavaScript('window.__krhRankedLbOff = true;').catch(() => { /* ignore */ });
}
