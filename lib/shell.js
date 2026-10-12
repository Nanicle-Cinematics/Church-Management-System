'use strict';
// The page shell (full HTML document + client scripts) and the auth-screen
// shell. Built as a factory so the stateful dependencies are injected rather
// than reached for as module globals.
// Which stylesheets load, in what order, with a content-hash cache-buster —
// shared with the public landing page so the two cannot drift.
const { STYLE_TAGS, EDITORIAL_TAG, THEME_SCRIPT_TAG } = require('./style-tags');
const { MARK } = require('./brand');
const { icon: navIcon } = require('./icons');

module.exports.createShell = function createShell(deps) {
  const { CHURCH_NAME, NAV, esc, initials, flashHtml, scriptureOfDay, listBackups, deleteAllScopes = {} } = deps;
  // Anti-flicker theme paint: applied inline in <head>, before first paint,
  // so the page never flashes the wrong theme. Shared by both templates
  // below instead of being duplicated verbatim — a prior version of this
  // file had two independent copies that silently diverged when only one
  // was updated.
  // Palette + light/dark engine (public/material-theme.js), loaded before first paint.
  const THEME_INIT_SCRIPT = THEME_SCRIPT_TAG;
  // The main app shell's body script (below) attaches its own system-preference
  // listener alongside the theme-toggle button, so it doesn't need this. The
  // bare/auth shell has no toggle button and no other script, so without this
  // it would never notice an OS theme change made while the tab stays open.
  const THEME_SYSTEM_SYNC_SCRIPT = `
<script>
(function () {
  try {
    var mq = window.matchMedia && matchMedia('(prefers-color-scheme:dark)');
    if (!mq) return;
    var sync = function () {
      try { if (localStorage.getItem('theme')) return; } catch (e) {}
      document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);
  } catch (e) {}
})();
</script>`;
  const PASSWORD_TOGGLE_SCRIPT = `
<script>
(function () {
  function enhancePasswordFields() {
    document.querySelectorAll('input[type="password"], input[data-password-toggle="1"]').forEach(function (input) {
      if (input.dataset.passwordToggle === '1') return;
      input.dataset.passwordToggle = '1';
      var wrap = document.createElement('span');
      wrap.className = 'password-field';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'password-toggle';
      btn.textContent = 'Show';
      btn.setAttribute('aria-label', 'Show password');
      btn.addEventListener('click', function () {
        var hidden = input.type === 'password';
        input.type = hidden ? 'text' : 'password';
        btn.textContent = hidden ? 'Hide' : 'Show';
        btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      });
      wrap.appendChild(btn);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhancePasswordFields);
  else enhancePasswordFields();
})();
</script>`;

  function layout({ title, subtitle, subtitleHtml, body, active, flash, flashType, user, bare, noHeader, churchName }) {
    const displayChurchName = churchName || CHURCH_NAME;
    if (bare) {
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(displayChurchName)}</title>
${THEME_INIT_SCRIPT}
${EDITORIAL_TAG}
</head>
<body class="ed-auth">
<div class="ed-auth-grid">
  <aside class="ed-auth-aside">
    <a class="ed-wordmark" href="/">${MARK}${esc(displayChurchName)}</a>
    <div class="ed-auth-copy">
      <h2>Members, giving and attendance, <em>kept in order.</em></h2>
      <p>One private workspace for your church office.</p>
    </div>
    <ul class="ed-auth-notes" aria-label="Assurances">
      <li>Private to your church</li>
      <li>Every payout needs a second approver</li>
      <li>Backed up every night</li>
    </ul>
  </aside>
  <main class="ed-auth-main">
    <div class="ed-auth-card">
      <h1>${esc(title)}</h1>
      ${flashHtml(flash, flashType)}
      ${body}
    </div>
  </main>
</div>
${PASSWORD_TOGGLE_SCRIPT}
${THEME_SYSTEM_SYNC_SCRIPT}
</body></html>`;
    }
    const isAdmin = user && user.role === 'admin';
    const visibleNav = NAV.filter((item) => !item[3] || (item[3] === 'admin' && isAdmin) || (item[3] === 'platform' && user && user.isPlatformAdmin));
    const navSections = [
      { label: 'Dashboard', hrefs: ['/'] },
      { label: 'Members', hrefs: ['/members', '/attendance', '/bible-classes', '/organizations'] },
      { label: 'Finance', hrefs: ['/finance', '/inventory'] },
      { label: 'Services / Events', hrefs: ['/events', '/preaching', '/communications'] },
      { label: 'Reports', hrefs: ['/reports', '/operations', '/tenant', '/backups', '/errors', '/security/audit'] },
      { label: 'Settings', hrefs: ['/users', '/settings', '/help'] },
    ];
    const activeItem = visibleNav.find(([href]) => href === active);
    const breadcrumb = activeItem ? activeItem[1] : title;
    const navHtml = navSections.map((section) => {
      const links = visibleNav.filter(([href]) => section.hrefs.includes(href));
      if (!links.length) return '';
      return `<div class="mu-label">${esc(section.label)}</div>${links.map(([href, label, icon]) => `<a class="mu-item" href="${href}" title="${esc(label)}"${href === active ? ' aria-current="page"' : ''}><span class="ico">${icon}</span><span class="t">${esc(label)}</span></a>`).join('')}`;
    }).join('');
    const verse = scriptureOfDay();
    const userName = user ? (user.display_name || user.username) : '';
    const userInitials = initials(userName);
    const roleLabel = user ? ({ admin: 'Administrator', editor: 'Editor', viewer: 'Viewer' }[user.role] || 'Viewer') : '';
    const roleShort = user ? ({ admin: 'Owner', editor: 'Editor', viewer: 'Viewer' }[user.role] || 'Viewer') : '';
    // What this person may start from the "Add" button and the command palette.
    // Mirrors the route guards (admin-only pages, finance write roles).
    const canFinanceWrite = Boolean(user && (user.role === 'admin' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(user.financeRole)));
    const quick = [];
    if (user && user.role === 'admin') {
      quick.push(['New member', '/members/new', 'Add someone to the roll', 'members'],
        ['Schedule event', '/events/new', 'Service, meeting or rally', 'events'],
        ['Send broadcast', '/communications/broadcast', 'SMS or email to a group', 'communications']);
    }
    if (canFinanceWrite) {
      quick.push(['Record income', '/finance/income', 'Offering, donation or other income', 'finance'],
        ['Record expense', '/finance/expenses', 'Submit an expense for approval', 'finance'],
        ['Record tithe', '/finance/tithes', 'Add a member tithe', 'finance']);
    }
    const quickHtml = quick.map(([label, href, hint, ic]) => `<a class="mu-act" href="${href}"><span class="ic">${navIcon(ic)}</span><span><b>${esc(label)}</b><small>${esc(hint)}</small></span></a>`).join('');
    const paletteData = JSON.stringify({
      nav: visibleNav.map(([href, label, icon]) => ({ l: label, h: href, i: icon })),
      actions: quick.map(([label, href, hint]) => ({ l: label, h: href, s: hint })),
    }).replace(/</g, '\\u003c');
    const deleteScope = user && user.canPermanentDeleteAll
      ? Object.entries(deleteAllScopes).find(([, scope]) => (scope.active || []).includes(active))
      : null;
    const deleteAllAction = deleteScope
      ? `<a class="delete-all-action" href="/delete-all/${encodeURIComponent(deleteScope[0])}" title="Permanently delete all ${esc(deleteScope[1].label)} data">Delete all</a>`
      : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(displayChurchName)}</title>
${THEME_INIT_SCRIPT}
${STYLE_TAGS}
</head>
<body class="mu">
<a class="skip-link" href="#main">Skip to content</a>
<div class="mu-app" id="muApp">
  <aside class="mu-rail" id="app-nav" aria-label="Main navigation">
    <button class="mu-menu" id="muMenu" type="button" aria-label="Expand navigation" aria-expanded="false">${navIcon('menu').replace('<svg', '<svg class="mu-i"')}</button>
    <a class="mu-brand" href="/"><img src="/branding/logo" alt="" width="36" height="36"><b>${esc(displayChurchName)}</b></a>
    ${quickHtml ? `<button class="mu-fab" id="muFab" type="button" aria-haspopup="dialog">${navIcon('plus').replace('<svg', '<svg class="mu-i"')}<span>Add</span></button>` : ''}
    <nav class="mu-nav" aria-label="Sections">${navHtml}</nav>
    <div class="mu-grow"></div>
    <div class="mu-scripture"><b>Scripture of the day</b><blockquote>“${esc(verse[0])}”</blockquote><cite>${esc(verse[1])}</cite></div>
  </aside>
  <div class="mu-main">
    <div class="mu-top">
      <button class="mu-iconbtn mu-hamburger" id="muHamburger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="app-nav">${navIcon('menu').replace('<svg', '<svg class="mu-i"')}</button>
      <div class="mu-title">${esc(title)}</div>
      <button class="mu-search" id="muSearch" type="button" aria-haspopup="dialog" aria-label="Search or jump to anything">${navIcon('search').replace('<svg', '<svg class="mu-i"')}<span>Search members, events, pages</span><kbd class="mu-k" id="muKbd">Ctrl K</kbd></button>
      <div class="mu-spacer"></div>
      <button class="mu-iconbtn mu-searchbtn" id="muSearchBtn" type="button" aria-label="Search">${navIcon('search').replace('<svg', '<svg class="mu-i"')}</button>
      ${deleteAllAction}
      <button class="mu-iconbtn" id="muThemeBtn" type="button" aria-label="Colour and theme" title="Colour and theme">${navIcon('palette').replace('<svg', '<svg class="mu-i"')}</button>
      <form class="mu-signout" method="post" action="/logout"><button type="submit">Sign out</button></form>
      <a class="mu-avatar" href="/profile" title="${esc(userName)} · ${esc(roleLabel)}">${esc(userInitials)}</a>
    </div>
    <div class="mu-panel" id="muPanel">
    <main class="page" id="main" tabindex="-1">
      ${flashHtml(flash, flashType)}
      ${noHeader ? '' : `<h1>${esc(title)}</h1>${subtitleHtml ? `<p class="subtitle">${subtitleHtml}</p>` : (subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : '')}`}
      ${body}
      <div class="print-footer">
        Printed by <strong>${esc(userName)}</strong>
        · <span id="print-ts">${new Date().toLocaleString('en-GB')}</span>
        · ${esc(displayChurchName)}
      </div>
      <script>
        window.addEventListener('beforeprint', function () {
          var el = document.getElementById('print-ts');
          if (el) el.textContent = new Date().toLocaleString('en-GB');
        });
        // Mark every required field with a red asterisk right after its label text.
        document.querySelectorAll('[required]').forEach(function (r) {
          var lbl = r.closest('label');
          if (!lbl || lbl.querySelector('.req-star')) return;
          var star = document.createElement('span');
          star.className = 'req-star';
          star.textContent = ' *';
          var firstText = null;
          for (var i = 0; i < lbl.childNodes.length; i++) {
            var n = lbl.childNodes[i];
            if (n.nodeType === 3 && n.textContent.trim()) { firstText = n; break; }
          }
          if (firstText) lbl.insertBefore(star, firstText.nextSibling);
          else r.parentNode.insertBefore(star, r);
        });
        (function () {
          function enhancePasswordFields() {
            document.querySelectorAll('input[type="password"], input[data-password-toggle="1"]').forEach(function (input) {
              if (input.dataset.passwordToggle === '1') return;
              input.dataset.passwordToggle = '1';
              var wrap = document.createElement('span');
              wrap.className = 'password-field';
              input.parentNode.insertBefore(wrap, input);
              wrap.appendChild(input);
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'password-toggle';
              btn.textContent = 'Show';
              btn.setAttribute('aria-label', 'Show password');
              btn.addEventListener('click', function () {
                var hidden = input.type === 'password';
                input.type = hidden ? 'text' : 'password';
                btn.textContent = hidden ? 'Hide' : 'Show';
                btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
              });
              wrap.appendChild(btn);
            });
          }
          enhancePasswordFields();
        })();
        // Confirm before saving on every create/edit form (class="form").
        // Forms that already have an onsubmit confirm (e.g. archive) opt out.
        document.querySelectorAll('form.form').forEach(function (f) {
          if (f.getAttribute('onsubmit')) return;
          if (f.dataset.noConfirm === '1') return;
          f.addEventListener('submit', function (e) {
            if (!window.confirm('Save these changes?')) e.preventDefault();
          });
        });

        // Clickable dashboard cards. Native controls and inner links keep their own behavior.
        (function () {
          document.querySelectorAll('[data-card-href]').forEach(function (card) {
            if (card.dataset.cardInit === '1') return;
            card.dataset.cardInit = '1';
            if (!card.hasAttribute('role')) card.setAttribute('role', 'link');
            if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '0');
            function shouldIgnore(target) {
              return !!target.closest('a, button, input, select, textarea, label, summary, form, [data-no-card-click]');
            }
            function go() {
              var href = card.getAttribute('data-card-href');
              if (href) window.location.href = href;
            }
            card.addEventListener('click', function (e) {
              if (shouldIgnore(e.target)) return;
              if (e.target.closest('[data-card-href]') !== card) return;
              go();
            });
            card.addEventListener('keydown', function (e) {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              if (shouldIgnore(e.target)) return;
              if (e.target.closest('[data-card-href]') !== card) return;
              e.preventDefault();
              go();
            });
          });
        })();

        // On phones, collapse wide tables to key fields with a per-row toggle.
        // A table can override how many leading columns count as "key" via
        // data-key-cols (see lib/views.js's table() helper) — the default of
        // 2 is wrong for tables where the decision-relevant fields (e.g.
        // amount, status) aren't in the first two columns.
        (function () {
          var DEFAULT_KEY_COLS = 2;
          var mq = window.matchMedia('(max-width: 640px)');
          function enhance() {
            if (!mq.matches) return;
            document.querySelectorAll('table.data-table:not(.members-table)').forEach(function (table) {
              var keyCols = Number(table.dataset.keyCols) || DEFAULT_KEY_COLS;
              table.querySelectorAll('tbody tr').forEach(function (tr) {
                if (tr.dataset.rEnhanced) return;
                var tds = tr.querySelectorAll('td');
                if (tds.length <= keyCols) { tr.dataset.rEnhanced = '1'; return; }
                var hasExtra = false;
                for (var i = keyCols; i < tds.length; i++) {
                  if (tds[i].textContent.trim() !== '') hasExtra = true;
                  tds[i].classList.add('td-extra');
                }
                tr.dataset.rEnhanced = '1';
                if (!hasExtra) return;
                var cell = document.createElement('td');
                cell.className = 'row-expand-cell';
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'row-expand';
                btn.textContent = 'Show details';
                btn.addEventListener('click', function () {
                  var open = tr.classList.toggle('is-open');
                  btn.textContent = open ? 'Hide details' : 'Show details';
                });
                cell.appendChild(btn);
                tr.appendChild(cell);
              });
            });
          }
          enhance();
          if (mq.addEventListener) mq.addEventListener('change', enhance);
          window.addEventListener('resize', enhance);
          document.addEventListener('results:updated', enhance);
        })();

        // Toast notifications: auto-dismiss + manual close.
        function initToasts() {
          document.querySelectorAll('.toast:not([data-init])').forEach(function (t) {
            t.setAttribute('data-init', '1');
            var x = t.querySelector('.toast-x');
            function dismiss() { t.classList.add('toast-hide'); setTimeout(function () { t.remove(); }, 250); }
            if (x) x.addEventListener('click', dismiss);
            setTimeout(dismiss, 5000);
          });
        }
        initToasts();

        // Live search: debounce GET filter forms and swap the results region.
        (function () {
          document.querySelectorAll('form[data-live-search]').forEach(function (form) {
            var timer;
            function run() {
              var params = new URLSearchParams(new FormData(form));
              var url = (form.getAttribute('action') || location.pathname) + '?' + params.toString();
              var cur = document.querySelector('[data-results]');
              if (cur) cur.classList.add('is-loading');
              fetch(url, { headers: { 'X-Requested-With': 'fetch' } })
                .then(function (r) { return r.text(); })
                .then(function (html) {
                  var doc = new DOMParser().parseFromString(html, 'text/html');
                  var next = doc.querySelector('[data-results]');
                  var now = document.querySelector('[data-results]');
                  if (next && now) now.replaceWith(next);
                  history.replaceState(null, '', url);
                  document.dispatchEvent(new Event('results:updated'));
                })
                .catch(function () { if (cur) cur.classList.remove('is-loading'); });
            }
            form.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300); });
            form.addEventListener('change', function () { clearTimeout(timer); timer = setTimeout(run, 120); });
          });
        })();

        // Bulk selection (Members). Re-binds after live-search swaps.
        function initBulk() {
          var table = document.querySelector('table[data-bulk]');
          var bar = document.querySelector('.bulk-bar');
          if (!table || !bar) return;
          var idsField = bar.querySelector('input[name="member_ids"]');
          var countEl = bar.querySelector('.bulk-count');
          var all = table.querySelector('.bulk-all');
          function boxes() { return Array.prototype.slice.call(table.querySelectorAll('.bulk-box')); }
          function update() {
            var ids = boxes().filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
            idsField.value = ids.join(',');
            countEl.textContent = ids.length;
            bar.classList.toggle('show', ids.length > 0);
          }
          if (all && !all.dataset.init) {
            all.dataset.init = '1';
            all.addEventListener('change', function () {
              boxes().forEach(function (b) { b.checked = all.checked; });
              update();
            });
          }
          if (!table.dataset.bulkInit) {
            table.dataset.bulkInit = '1';
            table.addEventListener('change', function (e) {
              if (e.target.classList && e.target.classList.contains('bulk-box')) update();
            });
          }
          update();
        }
        initBulk();
        document.addEventListener('results:updated', function () { initBulk(); initToasts(); });
      </script>
    </main>
    <footer class="footer">
      <div>© ${new Date().getFullYear()} ${esc(displayChurchName)}. All rights reserved.</div>
    </footer>
    </div>
  </div>
</div>
${quickHtml ? `<div class="mu-scrim center" id="muAdd"><div class="mu-dlg" role="dialog" aria-label="Add"><h2>Add</h2><p>What would you like to do?</p>${quickHtml}</div></div>` : ''}
<div class="mu-scrim center" id="muTheme"><div class="mu-dlg" role="dialog" aria-label="Colour and theme"><h2>Make it yours</h2><p>Pick a colour and the whole app follows it, like your Pixel wallpaper.</p>
  <div class="mu-swrow" id="muSwatches"></div>
  <div class="mu-srow"><div><b style="font-weight:500">Dark theme</b><div style="font-size:13px;color:var(--on-sf-v)">Easier on the eyes at night</div></div><label class="mu-switch"><input type="checkbox" id="muDark" aria-label="Dark theme"><span></span></label></div>
  <div class="done"><button class="btn" type="button" data-mu-close>Done</button></div></div></div>
<div class="mu-scrim" id="muPal"><div class="mu-pal" role="dialog" aria-label="Command palette"><div class="in">${navIcon('search').replace('<svg', '<svg class="mu-i"')}<input id="muPalIn" placeholder="Search members, events, pages, or type a command" aria-label="Command" autocomplete="off"><kbd class="mu-k">esc</kbd></div><ul id="muPalList" role="listbox"></ul><div class="ft"><span>↑ ↓ to move</span><span>↵ to open</span><span>esc to close</span></div></div></div>
<script type="application/json" id="muData">${paletteData}</script>
<script>
(function () {
  var $ = function (s) { return document.querySelector(s); }, $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var app = $('#muApp'), data = {}; try { data = JSON.parse($('#muData').textContent); } catch (e) {}
  var mac = /Mac|iPhone|iPad/.test(navigator.platform); $('#muKbd').textContent = mac ? '⌘ K' : 'Ctrl K';

  // Rail <-> drawer on desktop (remembered), off-canvas drawer on phones.
  var narrow = function () { return window.matchMedia('(max-width: 900px)').matches; };
  try { if (localStorage.getItem('mu-drawer') === '1' && !narrow()) app.classList.add('drawer'); } catch (e) {}
  function setNav(open) {
    if (narrow()) { app.classList.toggle('nav-open', open); $('#muHamburger').setAttribute('aria-expanded', open); document.body.style.overflow = open ? 'hidden' : ''; }
    else { app.classList.toggle('drawer', open); $('#muMenu').setAttribute('aria-expanded', open); try { localStorage.setItem('mu-drawer', open ? '1' : '0'); } catch (e) {} }
  }
  $('#muMenu').addEventListener('click', function () { setNav(!app.classList.contains('drawer')); });
  $('#muHamburger').addEventListener('click', function () { setNav(!app.classList.contains('nav-open')); });
  $$('.mu-item').forEach(function (a) { a.addEventListener('click', function () { if (narrow()) setNav(false); }); });

  // Dialogs
  function openScrim(id) { var el = $(id); if (el) { el.classList.add('on'); var f = el.querySelector('input,a,button'); if (f && id !== '#muPal') f.focus(); } }
  function closeAll() { $$('.mu-scrim').forEach(function (s) { s.classList.remove('on'); }); app.classList.remove('nav-open'); document.body.style.overflow = ''; }
  $$('.mu-scrim').forEach(function (s) { s.addEventListener('mousedown', function (e) { if (e.target === s) closeAll(); }); });
  $$('[data-mu-close]').forEach(function (b) { b.addEventListener('click', closeAll); });
  if ($('#muFab')) $('#muFab').addEventListener('click', function () { openScrim('#muAdd'); });

  // Colour + theme dialog
  var sw = $('#muSwatches');
  function paintSwatches() {
    sw.innerHTML = MU.SEEDS.map(function (x) { return '<button class="mu-sw" type="button" style="background:hsl(' + x[1] + ' 60% 45%)" aria-label="' + x[0] + '" aria-pressed="' + (x[1] === MU.seed()) + '" data-h="' + x[1] + '"><svg class="mu-i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>'; }).join('');
    $$('.mu-sw').forEach(function (b) { b.addEventListener('click', function () { MU.setSeed(+b.dataset.h); paintSwatches(); }); });
    $('#muDark').checked = MU.isDark();
  }
  $('#muThemeBtn').addEventListener('click', function () { paintSwatches(); openScrim('#muTheme'); });
  $('#muDark').addEventListener('change', function (e) { MU.setDark(e.target.checked); });

  // Command palette: pages and actions are known server-side (already filtered
  // by this person's role); members and events are searched live.
  var items = [], sel = 0, token = 0, timer = null;
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function base(q) {
    var v = q.toLowerCase(), out = [];
    (data.actions || []).forEach(function (a) { if (!v || a.l.toLowerCase().indexOf(v) > -1) out.push({ g: 'Actions', l: a.l, r: a.s, h: a.h, i: '+' }); });
    (data.nav || []).forEach(function (n) { if (!v || n.l.toLowerCase().indexOf(v) > -1) out.push({ g: 'Go to', l: n.l, h: n.h, svg: n.i }); });
    [['Switch dark / light', 'toggle', 'Theme'], ['Change colour', 'theme', 'Theme'], ['Sign out', 'logout', 'Account']].forEach(function (c) { if (!v || c[0].toLowerCase().indexOf(v) > -1) out.push({ g: 'Settings', l: c[0], cmd: c[1], r: c[2], i: '•' }); });
    return out;
  }
  function render() {
    var g = '', h = '';
    items.forEach(function (x, i) {
      if (x.g !== g) { g = x.g; h += '<li class="grp">' + esc(g) + '</li>'; }
      h += '<li class="o" role="option" aria-selected="' + (i === sel) + '" data-i="' + i + '"><span class="ic">' + (x.svg ? x.svg : esc(x.i || '')) + '</span><span>' + esc(x.l) + '</span><span class="r">' + esc(x.r || '') + '</span></li>';
    });
    $('#muPalList').innerHTML = h || '<li class="empty">Nothing found</li>';
    $$('#muPalList .o').forEach(function (o) {
      o.addEventListener('mouseenter', function () { sel = +o.dataset.i; $$('#muPalList .o').forEach(function (z) { z.setAttribute('aria-selected', z === o); }); });
      o.addEventListener('click', function () { run(+o.dataset.i); });
    });
  }
  function search(q) {
    var mine = ++token; items = base(q); sel = 0; render();
    if (q.length < 2) return;
    function add(group, rows) { if (mine !== token || !rows.length) return; items = items.concat(rows.map(function (r) { return Object.assign({ g: group }, r); })); render(); }
    fetch('/api/members?q=' + encodeURIComponent(q), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : { members: [] }; }).then(function (d) {
      add('Members', (d.members || []).slice(0, 6).map(function (m) { return { l: m.firstName + ' ' + m.lastName, r: m.bibleClass ? m.bibleClass.name : (m.externalId || ''), h: '/members/' + m.id, i: ((m.firstName || '')[0] || '') + ((m.lastName || '')[0] || '') }; }));
    }).catch(function () {});
    fetch('/api/events?q=' + encodeURIComponent(q), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : []; }).then(function (d) {
      add('Events', (Array.isArray(d) ? d : []).slice(0, 4).map(function (e) { return { l: e.title, r: String(e.startsAt || '').slice(0, 10), h: '/events/' + e.id, i: '◷' }; }));
    }).catch(function () {});
  }
  function run(i) {
    var x = items[i]; if (!x) return;
    if (x.h) { window.location.href = x.h; return; }
    closeAll();
    if (x.cmd === 'toggle') MU.toggle();
    if (x.cmd === 'theme') { paintSwatches(); openScrim('#muTheme'); }
    if (x.cmd === 'logout') { var f = document.querySelector('.mu-signout'); if (f) f.submit(); }
  }
  function openPalette() { openScrim('#muPal'); var inp = $('#muPalIn'); inp.value = ''; search(''); inp.focus(); }
  $('#muSearch').addEventListener('click', openPalette); $('#muSearchBtn').addEventListener('click', openPalette);
  $('#muPalIn').addEventListener('input', function (e) { clearTimeout(timer); var q = e.target.value.trim(); timer = setTimeout(function () { search(q); }, 140); });
  document.addEventListener('keydown', function (e) {
    var open = $('#muPal').classList.contains('on');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (open) closeAll(); else openPalette(); return; }
    if (e.key === 'Escape') { closeAll(); return; }
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
      return;
    }
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (!typing && e.key === '/') { e.preventDefault(); openPalette(); }
  });
})();
</script>
<script>
(function () {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('.hs-value').forEach(function (el) {
    var txt = el.textContent.trim();
    if (!/^[0-9][0-9,]*$/.test(txt)) return;
    var to = parseInt(txt.replace(/,/g, ''), 10), t0 = null;
    function step(t) {
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / 800), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(to * e).toLocaleString();
      if (p < 1) requestAnimationFrame(step); else el.textContent = txt;
    }
    requestAnimationFrame(step);
  });
})();
</script>
</body></html>`;
  }

  function authPage(title, body, flash) {
    return layout({ title, body, bare: true, flash, active: null, user: null });
  }

  return { layout, authPage };
};
