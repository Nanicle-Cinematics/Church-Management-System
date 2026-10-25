/* Moved out of lib/shell.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
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
