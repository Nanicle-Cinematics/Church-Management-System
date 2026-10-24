'use strict';
// The page shell (full HTML document + client scripts) and the auth-screen
// shell. Built as a factory so the stateful dependencies are injected rather
// than reached for as module globals.
// Which stylesheets load, in what order, with a content-hash cache-buster —
// shared with the public landing page so the two cannot drift.
const { STYLE_TAGS, PUBLIC_TAG, APP_THEME_SCRIPT_TAG, UI_SCRIPT_TAG, PWA_HEAD_TAGS, pwaHeadTags, scriptTag } = require('./style-tags');
const { MARK_CROSS } = require('./brand');
const { icon: navIcon } = require('./icons');

module.exports.createShell = function createShell(deps) {
  const { CHURCH_NAME, NAV, esc, initials, flashHtml, scriptureOfDay, listBackups, deleteAllScopes = {} } = deps;
  // Light/dark (public/app-theme.js) is loaded in <head> before first paint
  // and follows OS changes by itself, for both templates below.
  const PASSWORD_TOGGLE_SCRIPT = `
${scriptTag('password-toggle')}`;

  function layout({ title, subtitle, subtitleHtml, body, active, flash, flashType, user, bare, noHeader, churchName, app, announcements = [], support = null, liturgical = null }) {
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
${UI_SCRIPT_TAG}
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
      { label: 'Ministry', hrefs: ['/events', '/preaching', '/almanac', '/communications'] },
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
<html lang="en"${liturgical ? ` data-liturgical="${esc(String(liturgical).toLowerCase())}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(displayChurchName)}</title>
${app ? pwaHeadTags(app) : PWA_HEAD_TAGS}
${APP_THEME_SCRIPT_TAG}
${UI_SCRIPT_TAG}
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
      ${support ? `<div class="pc-notice pc-notice-support" role="status"><span><b>Support view, read-only.</b> You are seeing ${esc(displayChurchName)} as its admins do. Nothing can be changed or exported. Allowed until ${esc(new Date(support.until).toISOString().slice(0, 16).replace('T', ' '))} UTC.</span><form method="post" action="/support/end"><button type="submit">End</button></form></div>` : ''}
      ${announcements.map((a) => `<div class="pc-notice pc-notice-${a.level === 'warning' ? 'warning' : 'info'}" data-notice="${a.id}" role="status" hidden><span>${esc(a.message)}</span><button type="button" class="pc-ib" data-notice-close aria-label="Dismiss">×</button></div>`).join('')}
      ${flashHtml(flash, flashType)}
      ${noHeader ? '' : `<h1>${esc(title)}</h1>${subtitleHtml ? `<p class="subtitle">${subtitleHtml}</p>` : (subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : '')}`}
      ${body}
      <div class="print-footer">
        Printed by <strong>${esc(userName)}</strong>
        · <span id="print-ts">${new Date().toLocaleString('en-GB')}</span>
        · ${esc(displayChurchName)}
      </div>
      ${scriptTag('app-shell')}
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
${scriptTag('palette')}
</body></html>`;
  }

  function authPage(title, body, flash, { churchName } = {}) {
    return layout({ title, body, bare: true, flash, active: null, user: null, churchName });
  }

  return { layout, authPage };
};
