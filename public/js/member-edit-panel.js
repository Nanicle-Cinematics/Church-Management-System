/* Moved out of lib/member-profile.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
(function () {
  var panel = document.getElementById('edit');
  function open() { if (panel) { panel.open = true; panel.scrollIntoView({ block: 'start' }); } }
  if (location.hash === '#edit') panel.open = true;
  document.querySelectorAll('[data-open-edit]').forEach(function (a) { a.addEventListener('click', function () { if (panel) panel.open = true; }); });
})();
