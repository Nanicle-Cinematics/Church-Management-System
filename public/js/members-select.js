/* Moved out of routes-pg-html/members.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
// Selection survives paging and live filtering (kept for this tab in
// sessionStorage) and feeds the SMS composer and the CSV export.
(function () {
  var KEY = 'cm-members-selected', MAX = Number(document.currentScript.dataset.max), sel;
  try { sel = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (e) { sel = []; }
  sel = sel.filter(function (x) { return /^\d+$/.test(String(x)); }).map(String);
  var bar = document.getElementById('pmBulk');
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(sel)); } catch (e) { /* private mode */ } }
  function paint() {
    document.querySelectorAll('.pm-box').forEach(function (b) { b.checked = sel.indexOf(b.value) > -1; b.closest('tr').classList.toggle('is-selected', b.checked); });
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.pm-box')), all = document.querySelector('.pm-all');
    if (all) { var on = boxes.filter(function (b) { return b.checked; }).length; all.checked = boxes.length > 0 && on === boxes.length; all.indeterminate = on > 0 && on < boxes.length; }
    bar.hidden = !sel.length;
    document.body.classList.toggle('pm-bulk-on', sel.length > 0);
    document.getElementById('pmBulkN').textContent = sel.length;
    document.getElementById('pmBulkSms').href = '/communications/broadcast?member_ids=' + sel.join(',');
    document.getElementById('pmBulkCsv').href = '/members/export.csv?ids=' + sel.join(',');
  }
  function toggle(id, on) {
    var i = sel.indexOf(id);
    if (on && i < 0) { if (sel.length >= MAX) { alert('You can select up to ' + MAX + ' people at a time.'); return false; } sel.push(id); }
    if (!on && i > -1) sel.splice(i, 1);
    return true;
  }
  document.addEventListener('change', function (e) {
    if (e.target.classList.contains('pm-box')) { if (!toggle(e.target.value, e.target.checked)) e.target.checked = false; save(); paint(); e.stopPropagation(); }
    else if (e.target.classList.contains('pm-all')) { document.querySelectorAll('.pm-box').forEach(function (b) { toggle(b.value, e.target.checked); }); save(); paint(); e.stopPropagation(); }
  }, true);
  // Ticking a box is not a filter change: keep it from the live search's input listener.
  document.addEventListener('input', function (e) { if (e.target.classList.contains('pm-box') || e.target.classList.contains('pm-all')) e.stopPropagation(); }, true);
  document.getElementById('pmBulkClear').addEventListener('click', function () { sel = []; save(); paint(); });
  document.addEventListener('results:updated', paint);
  paint();
})();
