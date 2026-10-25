/* Moved out of lib/shell.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
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
