/* Light/dark for every page, signed in or not (no dependencies).
 *
 * Loaded synchronously in <head> so the first paint already has the right
 * theme. The saved choice ('theme' in localStorage) wins, otherwise the page
 * follows the system setting, live.
 */
(function () {
  var root = document.documentElement;
  function read() { try { return localStorage.getItem('theme'); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem('theme', v); } catch (e) { /* private mode */ } }
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;

  function set(theme) {
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    try { document.dispatchEvent(new CustomEvent('app:theme', { detail: theme })); } catch (e) { /* old browser */ }
  }
  var saved = read();
  set(saved === 'dark' || saved === 'light' ? saved : (mq && mq.matches ? 'dark' : 'light'));

  if (mq) {
    var follow = function () { var s = read(); if (s !== 'dark' && s !== 'light') set(mq.matches ? 'dark' : 'light'); };
    if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
  }

  window.AppTheme = {
    isDark: function () { return root.getAttribute('data-theme') === 'dark'; },
    toggle: function () { var next = this.isDark() ? 'light' : 'dark'; write(next); set(next); return next; },
  };
})();
