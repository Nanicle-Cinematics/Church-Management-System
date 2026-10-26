/* Relaunch welcome: when the app is opened afresh (a new app window or browser tab, from the home
   screen, a bookmark or a typed address) and the church has its welcome animation on, show it first
   and then carry on to the page that was asked for. Runs in the <head>, before the page paints, so
   there is no flash of the page first. Not for moving around inside the app (the referrer is the app
   itself), for reloads (the tab already remembers it ran), or for the welcome page. The server checks
   the church's setting again and skips the screen if the church turned it off. */
(function () {
  try {
    if (window.sessionStorage.getItem('welcomed')) return;
    window.sessionStorage.setItem('welcomed', '1');
    if (location.pathname === '/welcome') return;
    if (document.referrer && new URL(document.referrer).origin === location.origin) return;
    location.replace('/welcome?launch=1&next=' + encodeURIComponent(location.pathname + location.search + location.hash));
  } catch (e) { /* storage unavailable (private mode, blocked): no relaunch screen, nothing else changes */ }
})();
