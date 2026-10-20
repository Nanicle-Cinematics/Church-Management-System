/* Moved out of lib/tenant-dashboard.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
(function () {
  var card = document.getElementById('pdGiving');
  card.querySelectorAll('[data-range]').forEach(function (b) {
    b.addEventListener('click', function () {
      card.querySelectorAll('[data-range]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      card.querySelectorAll('[data-chart]').forEach(function (c) { c.hidden = c.getAttribute('data-chart') !== b.getAttribute('data-range'); });
      card.querySelector('[data-total]').textContent = b.getAttribute('data-total');
      card.querySelector('[data-total-label]').textContent = b.getAttribute('data-label');
    });
  });
})();
