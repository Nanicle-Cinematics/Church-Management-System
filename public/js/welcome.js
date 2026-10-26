/* The welcome screen (lib/welcome.js): show the church's logo for a few seconds, then go on to
   the dashboard. Any tap, click or key goes on at once. People who ask their device for less
   motion get a shorter, calmer screen (the CSS drops the movement; this shortens the wait). */
(function () {
  var screen = document.getElementById('welcome');
  if (!screen) return;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ms = Number(screen.getAttribute(reduced ? 'data-reduced-ms' : 'data-ms')) || 5000;
  var gone = false;
  try { window.sessionStorage.setItem('welcomed', '1'); } catch (e) { /* not remembered: nothing else changes */ }
  function go() {
    if (gone) return;
    gone = true;
    window.location.replace(screen.getAttribute('data-next') || '/');
  }
  setTimeout(go, ms);
  screen.addEventListener('click', go);
  document.addEventListener('keydown', go);
})();
