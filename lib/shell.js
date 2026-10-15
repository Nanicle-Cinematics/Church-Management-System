'use strict';
// The page shell (full HTML document + client scripts) and the auth-screen
// shell. Built as a factory so the stateful dependencies are injected rather
// than reached for as module globals.
// Which stylesheets load, in what order, with a content-hash cache-buster —
// shared with the public landing page so the two cannot drift.
const { STYLE_TAGS, PUBLIC_TAG, APP_THEME_SCRIPT_TAG, PWA_HEAD_TAGS, pwaHeadTags } = require('./style-tags');
const { MARK_CROSS } = require('./brand');
const { icon: navIcon } = require('./icons');

module.exports.createShell = function createShell(deps) {
  const { CHURCH_NAME, NAV, esc, initials, flashHtml, scriptureOfDay, listBackups, deleteAllScopes = {} } = deps;
  // Light/dark (public/app-theme.js) is loaded in <head> before first paint
  // and follows OS changes by itself, for both templates below.
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

  function layout({ title, subtitle, subtitleHtml, body, active, flash, flashType, user, bare, noHeader, churchName, app, announcements = [] }) {
    const displayChurchName = churchName || CHURCH_NAME;
    if (bare) {
      // Signed-out pages carry the product name, or the church's own name
      // when the page belongs to one (check-in, RSVP, unsubscribe). Never the
      // CHURCH_NAME setting: it names one church, and every church sees these.
      const brandName = churchName || 'Church Manager';
      const tick = navIcon('check');
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(brandName)}</title>
${PWA_HEAD_TAGS}
${APP_THEME_SCRIPT_TAG}
${PUBLIC_TAG}
</head>
<body class="pa">
<div class="pa-grid">
  <aside class="pa-aside">
    <a class="pu-mark" href="/"><i>${MARK_CROSS}</i>${esc(brandName)}</a>
    <div class="pa-copy">
      <h2>Members, giving and attendance, kept in order.</h2>
      <p>One private workspace for your church office.</p>
      <div class="pa-preview" aria-hidden="true">
        <div><span>Sunday attendance</span><b>742</b></div>
        <div><span>Giving, this month</span><b>GH₵ 34,850</b></div>
        <div><span>Approvals waiting</span><b>3</b></div>
      </div>
    </div>
    <ul class="pa-notes" aria-label="Assurances">
      <li>${tick}Private to your church</li>
      <li>${tick}Every payout needs a second approver</li>
      <li>${tick}Backed up every night</li>
    </ul>
  </aside>
  <main class="pa-main">
    <div class="pa-card">
      <h1>${esc(title)}</h1>
      ${flashHtml(flash, flashType)}
      ${body}
    </div>
    <button class="pa-install" type="button" data-install-app hidden>${navIcon('download')}Install the app on this device</button>
  </main>
</div>
${PASSWORD_TOGGLE_SCRIPT}
</body></html>`;
    }
    const isAdmin = user && user.role === 'admin';
    // 'full' items need finance access: an admin or any finance role (lib/access.js).
    const fullAccess = Boolean(user && (isAdmin || (user.financeRole && user.financeRole !== 'NONE')));
    const visibleNav = NAV.filter((item) => !item[3] || (item[3] === 'admin' && isAdmin) || (item[3] === 'full' && fullAccess));
    const navSections = [
      { label: '', hrefs: ['/'] },
      { label: 'People', hrefs: ['/members', '/attendance', '/bible-classes', '/organizations'] },
      { label: 'Money', hrefs: ['/finance', '/inventory'] },
      { label: 'Ministry', hrefs: ['/events', '/preaching', '/communications'] },
      { label: 'Insights', hrefs: ['/reports', '/operations', '/tenant', '/backups', '/errors', '/security/audit'] },
      { label: 'Admin', hrefs: ['/users', '/settings', '/help'] },
    ];
    const activeItem = visibleNav.find(([href]) => href === active);
    const navHtml = navSections.map((section) => {
      const links = visibleNav.filter(([href]) => section.hrefs.includes(href));
      if (!links.length) return '';
      return `${section.label ? `<div class="pc-nav-label">${esc(section.label)}</div>` : ''}${links.map(([href, label, icon]) => `<a class="pc-item" href="${href}"${href === active ? ' aria-current="page"' : ''}>${icon}<span>${esc(label)}</span></a>`).join('')}`;
    }).join('');
    // Breadcrumb: church › section › page (the page only when it is not the section itself).
    const crumbParts = [`<a href="/">${esc(displayChurchName)}</a>`];
    if (activeItem && activeItem[0] !== '/' && activeItem[1] !== title) crumbParts.push(`<a href="${activeItem[0]}">${esc(activeItem[1])}</a>`);
    crumbParts.push(`<b>${esc(title)}</b>`);
    const crumbs = crumbParts.join(navIcon('chevronRight'));
    const verse = scriptureOfDay();
    const userName = user ? (user.display_name || user.username) : '';
    const userInitials = initials(userName);
    const roleLabel = user ? ({ admin: 'Administrator', editor: 'Editor', viewer: 'Viewer' }[user.role] || 'Viewer') : '';
    // What this person may start from the "New" menu and the command palette.
    // Mirrors the route guards (admin-only pages, finance write roles).
    const canFinanceWrite = Boolean(user && (user.role === 'admin' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(user.financeRole)));
    const quick = [];
    if (user && (user.role === 'admin' || user.role === 'editor')) {
      quick.push(['New member', '/members/new', 'Add someone to the roll', 'userPlus']);
      if (fullAccess) quick.push(['Schedule event', '/events/new', 'Service, meeting or rally', 'events']);
    }
    if (user && user.role === 'admin') {
      quick.push(['Send broadcast', '/communications/broadcast', 'SMS or email to a group', 'communications']);
    }
    if (canFinanceWrite) {
      quick.push(['Record income', '/finance/income', 'Offering, donation or other income', 'finance'],
        ['Record expense', '/finance/expenses', 'Submit an expense for approval', 'receipt'],
        ['Record tithe', '/finance/tithes', 'Add a member tithe', 'wallet']);
    }
    const quickHtml = quick.map(([label, href, hint, ic]) => `<a class="pc-mi" role="menuitem" href="${href}"><span class="ic">${navIcon(ic)}</span><span><b>${esc(label)}</b><small>${esc(hint)}</small></span></a>`).join('');
    // Phones: a floating glass tab bar instead of the sidebar. Four fixed
    // destinations plus More (every other section); New opens the same quick
    // actions as the top bar's menu. Tabs and tiles carry their section so
    // they pick up the sidebar's colours.
    const SECTION_OF = {};
    navSections.forEach((sec, i) => sec.hrefs.forEach((h) => { SECTION_OF[h] = ['home', 'people', 'money', 'ministry', 'insights', 'admin'][i]; }));
    const TAB_HREFS = ['/', '/members', '/finance', '/events'];
    const tabItems = TAB_HREFS.map((h) => visibleNav.find(([href]) => href === h)).filter(Boolean);
    const moreItems = visibleNav.filter(([href]) => !TAB_HREFS.includes(href));
    const moreActive = !tabItems.some(([href]) => href === active);
    const tabLabel = (href, label) => (href === '/' ? 'Home' : label);
    const phoneTabs = `<nav class="pc-tabbar" aria-label="Main">${tabItems.map(([href, label, icon]) => `<a href="${href}" data-sec="${SECTION_OF[href] || 'home'}"${href === active ? ' aria-current="page"' : ''}>${icon}<span>${esc(tabLabel(href, label))}</span></a>`).join('')}<button type="button" id="pcMoreBtn" data-sec="more" aria-haspopup="dialog" aria-controls="pcMore"${moreActive ? ' aria-current="page"' : ''}>${navIcon('more')}<span>More</span></button></nav>
${quickHtml ? `<button class="pc-fab" id="pcFab" type="button" aria-haspopup="dialog" aria-controls="pcCreate">${navIcon('plus')}<span>New</span></button>` : ''}
<div class="pc-sheet-scrim" id="pcSheetScrim" hidden></div>
<div class="pc-sheet" id="pcMore" role="dialog" aria-modal="true" aria-label="All sections" hidden><div class="pc-grab"></div>
  <div class="pc-sheet-h">All sections</div>
  <div class="pc-tiles">${moreItems.map(([href, label, icon]) => `<a class="pc-tile" href="${href}" data-sec="${SECTION_OF[href] || 'admin'}"${href === active ? ' aria-current="page"' : ''}><i>${icon}</i><span>${esc(label)}</span></a>`).join('')}
    <button class="pc-tile" type="button" data-sheet-cmd="search" data-sec="tool"><i>${navIcon('search')}</i><span>Search</span></button>
    <button class="pc-tile" type="button" data-sheet-cmd="theme" data-sec="tool"><i><span class="moon">${navIcon('moon')}</span><span class="sun">${navIcon('sun')}</span></i><span>Light / dark</span></button>
    <a class="pc-tile" href="/profile" data-sec="tool"><i>${navIcon('members')}</i><span>Profile</span></a>
    <button class="pc-tile" type="button" data-sheet-cmd="install" data-install-app hidden data-sec="tool"><i>${navIcon('download')}</i><span>Install app</span></button>
    <button class="pc-tile" type="button" data-sheet-cmd="signout" data-sec="tool"><i>${navIcon('logout')}</i><span>Sign out</span></button>
  </div></div>
${quickHtml ? `<div class="pc-sheet" id="pcCreate" role="dialog" aria-modal="true" aria-label="Create" hidden><div class="pc-grab"></div><div class="pc-sheet-h">Create</div><div class="pc-sheet-acts">${quickHtml}</div></div>` : ''}`;
    const paletteData = JSON.stringify({
      nav: visibleNav.map(([href, label, icon]) => ({ l: label, h: href, i: icon })),
      actions: quick.map(([label, href, hint]) => ({ l: label, h: href, s: hint })),
      icons: { plus: navIcon('plus'), event: navIcon('events'), theme: navIcon('moon'), logout: navIcon('logout') },
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
${app ? pwaHeadTags(app) : PWA_HEAD_TAGS}
${APP_THEME_SCRIPT_TAG}
${STYLE_TAGS}
</head>
<body class="pc">
<a class="skip-link" href="#main">Skip to content</a>
<div class="pc-app">
  <aside class="pc-side" id="app-nav" aria-label="Main navigation">
    <a class="pc-ws" href="/"><img src="/branding/logo" alt="" width="32" height="32"><span><b>${esc(displayChurchName)}</b><small>Church Manager</small></span></a>
    <button class="pc-search" id="pcSearch" type="button" aria-haspopup="dialog">${navIcon('search')}<span>Search or jump to…</span><kbd class="pc-k" id="pcKbd">Ctrl K</kbd></button>
    <nav class="pc-nav" aria-label="Sections">${navHtml}</nav>
    <div class="pc-grow"></div>
    <div class="pc-verse"><b>Scripture of the day</b><blockquote>“${esc(verse[0])}”</blockquote><cite>${esc(verse[1])}</cite></div>
    <button class="pc-item pc-install" type="button" data-install-app hidden>${navIcon('download')}<span>Install app</span></button>
    <a class="pc-me" href="/profile" title="Your profile"><span class="pc-av">${esc(userInitials)}</span><span><b>${esc(userName)}</b><small>${esc(roleLabel)}</small></span></a>
  </aside>
  <div class="pc-main">
    <header class="pc-top">
      <button class="pc-ib pc-hamb" id="pcHamb" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="app-nav">${navIcon('menu')}</button>
      <nav class="pc-crumbs" aria-label="Breadcrumb">${crumbs}</nav>
      <div class="pc-grow"></div>
      <button class="pc-ib pc-searchbtn" id="pcSearchBtn" type="button" aria-label="Search">${navIcon('search')}</button>
      ${deleteAllAction}
      ${quickHtml ? `<div class="pc-newwrap"><button class="pc-new" id="pcNew" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="pcNewMenu">${navIcon('plus')}<span>New</span>${navIcon('chevronDown')}</button><div class="pc-menu" id="pcNewMenu" role="menu" hidden>${quickHtml}</div></div>` : ''}
      <button class="pc-ib pc-theme" id="pcTheme" type="button" aria-label="Switch between light and dark" title="Light / dark"><span class="moon">${navIcon('moon')}</span><span class="sun">${navIcon('sun')}</span></button>
      <form class="pc-signout" method="post" action="/logout"><button class="pc-ib sign-out" type="submit" aria-label="Sign out" title="Sign out">${navIcon('logout')}</button></form>
    </header>
    <main class="page" id="main" tabindex="-1">
      ${announcements.map((a) => `<div class="pc-notice pc-notice-${a.level === 'warning' ? 'warning' : 'info'}" data-notice="${a.id}" role="status" hidden><span>${esc(a.message)}</span><button type="button" class="pc-ib" data-notice-close aria-label="Dismiss">×</button></div>`).join('')}
      ${flashHtml(flash, flashType)}
      ${noHeader ? '' : `<h1>${esc(title)}</h1>${subtitleHtml ? `<p class="subtitle">${subtitleHtml}</p>` : (subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : '')}`}
      ${body}
      <div class="print-footer">
        Printed by <strong>${esc(userName)}</strong>
        · <span id="print-ts">${new Date().toLocaleString('en-GB')}</span>
        · ${esc(displayChurchName)}
      </div>
      <script>
        // Platform notices: shown until dismissed, remembered on this device.
        (function () {
          var seen = []; try { seen = JSON.parse(localStorage.getItem('noticesSeen') || '[]'); } catch (e) {}
          document.querySelectorAll('[data-notice]').forEach(function (n) {
            var id = n.getAttribute('data-notice');
            if (seen.indexOf(id) === -1) n.hidden = false;
            n.querySelector('[data-notice-close]').addEventListener('click', function () {
              n.hidden = true; seen.push(id);
              try { localStorage.setItem('noticesSeen', JSON.stringify(seen.slice(-50))); } catch (e) {}
            });
          });
        })();
        window.addEventListener('beforeprint', function () {
          var el = document.getElementById('print-ts');
          if (el) el.textContent = new Date().toLocaleString('en-GB');
        });
        // Buttons like "＋ Add Bible Class" link to a form in a collapsed
        // <details> further down. Jumping there left it closed, so the button
        // seemed to do nothing: open it, scroll to it, and focus its first field.
        (function () {
          function openTarget(hash, focus) {
            if (!hash || hash.length < 2) return false;
            var el;
            try { el = document.querySelector(hash); } catch (e) { return false; }
            var box = el && (el.tagName === 'DETAILS' ? el : el.closest('details'));
            if (!box) return false;
            box.open = true;
            box.scrollIntoView({ behavior: 'smooth', block: 'start' });
            var field = focus && box.querySelector('input:not([type=hidden]), select, textarea');
            if (field) setTimeout(function () { field.focus({ preventScroll: true }); }, 300);
            return true;
          }
          document.addEventListener('click', function (e) {
            var a = e.target.closest && e.target.closest('a[href^="#"]');
            if (!a || a.hasAttribute('data-open-edit')) return;
            if (openTarget(a.getAttribute('href'), true)) {
              e.preventDefault();
              if (history.replaceState) history.replaceState(null, '', a.getAttribute('href'));
            }
          });
          openTarget(location.hash, false);
        })();
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
                  // Other parts of the page that describe the results (tabs,
                  // filter counts) opt in with data-live-sync and an id.
                  document.querySelectorAll('[data-live-sync][id]').forEach(function (el) {
                    var fresh = doc.getElementById(el.id);
                    if (fresh) el.replaceWith(fresh);
                  });
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
<div class="pc-scrim" id="pcScrim"></div>
${phoneTabs}
<div class="pc-pal-wrap" id="pcPal" hidden><div class="pc-pal" role="dialog" aria-modal="true" aria-label="Search and commands"><div class="pc-pal-in">${navIcon('search')}<input id="pcPalIn" placeholder="Search members, events, pages and actions…" aria-label="Search" autocomplete="off"><kbd class="pc-k">Esc</kbd></div><ul id="pcPalList" role="listbox"></ul><div class="pc-pal-ft"><span><kbd class="pc-k">↑</kbd><kbd class="pc-k">↓</kbd> move</span><span><kbd class="pc-k">↵</kbd> open</span><span><kbd class="pc-k">Esc</kbd> close</span></div></div></div>
<script type="application/json" id="pcData">${paletteData}</script>
<script>
(function () {
  var $ = function (s) { return document.querySelector(s); }, $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var data = {}; try { data = JSON.parse($('#pcData').textContent); } catch (e) {}
  var mac = /Mac|iPhone|iPad/.test(navigator.platform); $('#pcKbd').textContent = mac ? '⌘K' : 'Ctrl K';
  var body = document.body;

  // Off-canvas navigation on phones.
  function setNav(open) { body.classList.toggle('pc-nav-open', open); $('#pcHamb').setAttribute('aria-expanded', open); }
  $('#pcHamb').addEventListener('click', function () { setNav(!body.classList.contains('pc-nav-open')); });
  $('#pcScrim').addEventListener('click', function () { setNav(false); });
  $$('.pc-item').forEach(function (a) { a.addEventListener('click', function () { setNav(false); }); });

  // "New" menu.
  var newBtn = $('#pcNew'), newMenu = $('#pcNewMenu');
  function setMenu(open) { if (!newBtn) return; newMenu.hidden = !open; newBtn.setAttribute('aria-expanded', open); if (open) { var f = newMenu.querySelector('a'); if (f) f.focus(); } }
  if (newBtn) {
    newBtn.addEventListener('click', function (e) { e.stopPropagation(); setMenu(newMenu.hidden); });
    document.addEventListener('click', function (e) { if (!newMenu.hidden && !newMenu.contains(e.target)) setMenu(false); });
    newMenu.addEventListener('keydown', function (e) {
      var items = $$('#pcNewMenu a'), i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
  }

  $('#pcTheme').addEventListener('click', function () { if (window.AppTheme) AppTheme.toggle(); });

  // Phone tab bar sheets (More, Create).
  var sheetScrim = $('#pcSheetScrim'), openSheetEl = null, sheetOpener = null;
  function openSheet(el, opener) {
    if (!el) return;
    if (openSheetEl) closeSheet(true);
    openSheetEl = el; sheetOpener = opener || null;
    el.hidden = false; sheetScrim.hidden = false;
    requestAnimationFrame(function () { el.classList.add('on'); sheetScrim.classList.add('on'); });
    if (opener) opener.setAttribute('aria-expanded', 'true');
    var f = el.querySelector('a, button'); if (f) f.focus();
  }
  function closeSheet(instant) {
    var el = openSheetEl; if (!el) return;
    openSheetEl = null;
    el.classList.remove('on'); sheetScrim.classList.remove('on');
    if (sheetOpener) { sheetOpener.setAttribute('aria-expanded', 'false'); if (!instant) sheetOpener.focus(); }
    setTimeout(function () { if (!el.classList.contains('on')) { el.hidden = true; if (!openSheetEl) sheetScrim.hidden = true; } }, instant ? 0 : 260);
  }
  if ($('#pcMoreBtn')) $('#pcMoreBtn').addEventListener('click', function (e) { openSheet($('#pcMore'), e.currentTarget); });
  if ($('#pcFab')) $('#pcFab').addEventListener('click', function (e) { openSheet($('#pcCreate'), e.currentTarget); });
  sheetScrim.addEventListener('click', function () { closeSheet(); });
  $$('[data-sheet-cmd]').forEach(function (b) {
    b.addEventListener('click', function () {
      var cmd = b.getAttribute('data-sheet-cmd');
      if (cmd === 'theme') { if (window.AppTheme) AppTheme.toggle(); return; }
      closeSheet(true);
      if (cmd === 'search') openPal();
      if (cmd === 'signout') { var f = document.querySelector('.pc-signout'); if (f) f.submit(); }
      if (cmd === 'install' && window.PwaInstall) PwaInstall.start();
    });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openSheetEl) { e.stopPropagation(); closeSheet(); } }, true);

  // Command palette: pages and actions are known server-side (already filtered
  // by this person's role); members and events are searched live.
  var pal = $('#pcPal'), input = $('#pcPalIn'), list = $('#pcPalList');
  var items = [], sel = 0, token = 0, timer = null, ic = data.icons || {};
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function base(q) {
    var v = q.toLowerCase(), out = [];
    (data.actions || []).forEach(function (a) { if (!v || a.l.toLowerCase().indexOf(v) > -1) out.push({ g: 'Actions', l: a.l, r: a.s, h: a.h, svg: ic.plus }); });
    (data.nav || []).forEach(function (n) { if (!v || n.l.toLowerCase().indexOf(v) > -1) out.push({ g: 'Go to', l: n.l, h: n.h, svg: n.i }); });
    [['Switch light / dark', 'toggle', 'Appearance', ic.theme], ['Sign out', 'logout', 'Account', ic.logout]].forEach(function (c) { if (!v || c[0].toLowerCase().indexOf(v) > -1) out.push({ g: 'Settings', l: c[0], cmd: c[1], r: c[2], svg: c[3] }); });
    return out;
  }
  function render() {
    var g = '', h = '';
    items.forEach(function (x, i) {
      if (x.g !== g) { g = x.g; h += '<li class="grp" role="presentation">' + esc(g) + '</li>'; }
      h += '<li class="o" role="option" aria-selected="' + (i === sel) + '" data-i="' + i + '"><span class="ic">' + (x.svg ? x.svg : esc(x.i || '')) + '</span><span>' + esc(x.l) + '</span><span class="r">' + esc(x.r || '') + '</span></li>';
    });
    list.innerHTML = h || '<li class="empty">Nothing found</li>';
    var cur = list.querySelector('[aria-selected="true"]'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  list.addEventListener('mousemove', function (e) { var o = e.target.closest('.o'); if (o && +o.dataset.i !== sel) { sel = +o.dataset.i; render(); } });
  list.addEventListener('click', function (e) { var o = e.target.closest('.o'); if (o) run(+o.dataset.i); });
  function search(q) {
    var mine = ++token; items = base(q); sel = 0; render();
    if (q.length < 2) return;
    function add(group, rows) { if (mine !== token || !rows.length) return; items = items.concat(rows.map(function (r) { return Object.assign({ g: group }, r); })); render(); }
    fetch('/api/members?q=' + encodeURIComponent(q), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : { members: [] }; }).then(function (d) {
      add('Members', (d.members || []).slice(0, 6).map(function (m) { return { l: m.firstName + ' ' + m.lastName, r: m.bibleClass ? m.bibleClass.name : (m.externalId || ''), h: '/members/' + m.id, i: ((m.firstName || '')[0] || '') + ((m.lastName || '')[0] || '') }; }));
    }).catch(function () {});
    fetch('/api/events?q=' + encodeURIComponent(q), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : []; }).then(function (d) {
      add('Events', (Array.isArray(d) ? d : []).slice(0, 4).map(function (e) { return { l: e.title, r: String(e.startsAt || '').slice(0, 10), h: '/events/' + e.id, svg: ic.event }; }));
    }).catch(function () {});
  }
  function closePal() { pal.hidden = true; }
  function openPal() { setNav(false); setMenu(false); pal.hidden = false; input.value = ''; search(''); input.focus(); }
  function run(i) {
    var x = items[i]; if (!x) return;
    if (x.h) { window.location.href = x.h; return; }
    closePal();
    if (x.cmd === 'toggle' && window.AppTheme) AppTheme.toggle();
    if (x.cmd === 'logout') { var f = document.querySelector('.pc-signout'); if (f) f.submit(); }
  }
  $('#pcSearch').addEventListener('click', openPal); $('#pcSearchBtn').addEventListener('click', openPal);
  pal.addEventListener('mousedown', function (e) { if (e.target === pal) closePal(); });
  input.addEventListener('input', function (e) { clearTimeout(timer); var q = e.target.value.trim(); timer = setTimeout(function () { search(q); }, 140); });
  document.addEventListener('keydown', function (e) {
    var open = !pal.hidden;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (open) closePal(); else openPal(); return; }
    if (e.key === 'Escape') { if (open) closePal(); else if (newBtn && !newMenu.hidden) { setMenu(false); newBtn.focus(); } else setNav(false); return; }
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
      return;
    }
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (!typing && e.key === '/') { e.preventDefault(); openPal(); }
  });
})();
</script>
</body></html>`;
  }

  function authPage(title, body, flash, { churchName } = {}) {
    return layout({ title, body, bare: true, flash, active: null, user: null, churchName });
  }

  return { layout, authPage };
};
