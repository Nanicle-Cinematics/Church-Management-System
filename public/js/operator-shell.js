/* Moved out of lib/operator-shell.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
document.getElementById('opTheme').addEventListener('click', function () { if (window.AppTheme) AppTheme.toggle(); });
document.querySelectorAll('.toast-x').forEach(function (b) { b.addEventListener('click', function () { b.closest('.toast').remove(); }); });
