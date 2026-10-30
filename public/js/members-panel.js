/* Moved out of routes-pg-html/members.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
// Slide-in profile: clicking a name or row opens a summary without
// leaving the list. ?open=ID keeps it in the address bar, so Back
// closes it and the link can be shared. Ctrl/Cmd-click still opens
// the full profile as a normal link.
(function () {
  var drawer = document.getElementById('ppDrawer'), scrim = document.getElementById('ppScrim'), bodyEl = document.getElementById('ppBody'), full = document.getElementById('ppFull');
  var lastFocus = null, token = 0;
  function urlWith(id) { var u = new URL(location.href); if (id) u.searchParams.set('open', id); else u.searchParams.delete('open'); return u.pathname + u.search; }
  function show(id) {
    var mine = ++token;
    full.href = '/members/' + id;
    bodyEl.innerHTML = '<div class="pp-loading">Loading…</div>';
    drawer.setAttribute('aria-hidden', 'false'); drawer.classList.add('on'); scrim.hidden = false; document.body.classList.add('pp-open');
    document.getElementById('ppClose').focus();
    fetch('/members/' + id + '/panel', { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, t: t }; }); })
      .then(function (r) { if (mine !== token) return; bodyEl.innerHTML = r.ok ? r.t : '<div class="pp-loading">' + r.t.replace(/</g, '&lt;') + '</div>'; })
      .catch(function () { if (mine === token) bodyEl.innerHTML = '<div class="pp-loading">Could not load this member. Check your connection and try again.</div>'; });
  }
  function hide() {
    drawer.classList.remove('on'); drawer.setAttribute('aria-hidden', 'true'); scrim.hidden = true; document.body.classList.remove('pp-open');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
  function open(id) { if (!lastFocus) lastFocus = document.activeElement; history.pushState({ open: id }, '', urlWith(id)); show(id); }
  function close() { if (new URL(location.href).searchParams.get('open')) history.back(); else hide(); }
  document.addEventListener('click', function (e) {
    var row = e.target.closest('.members-table tbody tr');
    if (!row || e.target.closest('.row-actions, .pm-sel, button, input, select') || (e.target.closest('a') && !e.target.closest('a.m-name'))) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    var link = row.querySelector('a.m-name'), m = link && link.getAttribute('href').match(/\/members\/(\d+)/);
    if (!m) return;
    e.preventDefault(); lastFocus = link; open(m[1]);
  });
  document.getElementById('ppClose').addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawer.classList.contains('on')) { e.stopPropagation(); close(); } }, true);
  window.addEventListener('popstate', function () { var id = new URL(location.href).searchParams.get('open'); if (id) show(id); else hide(); });
  var first = new URL(location.href).searchParams.get('open');
  // Opened from a shared link: put the plain list underneath, so Back closes the panel instead of leaving.
  if (/^\d+$/.test(first || '')) { history.replaceState(null, '', urlWith(null)); history.pushState({ open: first }, '', urlWith(first)); show(first); }
})();
(function () {
  var btn = document.querySelector('.pm-fbtn'), body = document.body;
  function set(open) { body.classList.toggle('pm-sheet-open', open); btn.setAttribute('aria-expanded', open); }
  btn.addEventListener('click', function () { set(!body.classList.contains('pm-sheet-open')); });
  document.addEventListener('click', function (e) { if (body.classList.contains('pm-sheet-open') && !e.target.closest('#pmFacets') && !e.target.closest('.pm-fbtn')) set(false); });
  document.querySelector('.pm-sheet-foot button').addEventListener('click', function (e) { if (window.matchMedia('(max-width: 900px)').matches) { e.preventDefault(); set(false); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
})();
// Bible class and day born filter one at a time: ticking a box unticks the
// others in its group, and ticking it again clears it. Runs before the live
// search reads the form, which waits for the change to settle.
document.getElementById('pmFacets').addEventListener('change', function (e) {
  var box = e.target, group = box.closest && box.closest('[data-pick-one]');
  if (!group || !box.checked) return;
  group.querySelectorAll('input[type="checkbox"]').forEach(function (other) { if (other !== box) other.checked = false; });
});
