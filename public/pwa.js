/* Installable app on every platform (no dependencies).
 *
 * Registers the service worker (public/sw.js: offline page and device
 * notifications) and offers "Install app" wherever a page has an element
 * marked data-install-app (the sidebar, the phone's More sheet, the sign-in
 * page). Those elements start hidden and are shown only when installing is
 * possible here:
 *  - Chrome, Edge and Samsung Internet (Android, Windows, macOS, Linux,
 *    ChromeOS) have an install prompt, which the button opens.
 *  - Safari on iPhone, iPad and Mac, and Firefox on Android, have no prompt,
 *    so the button shows the steps for that browser instead.
 * Nothing shows inside the installed app itself.
 */
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* unsupported or blocked: the site still works */ });
    });
  }

  var ua = navigator.userAgent;
  var mm = function (q) { return window.matchMedia ? matchMedia(q).matches : false; };
  var installed = mm('(display-mode: standalone)') || mm('(display-mode: window-controls-overlay)') || navigator.standalone === true;
  var ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var android = /Android/.test(ua);
  var safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\/|SamsungBrowser/.test(ua);
  var firefox = /Firefox\/|FxiOS/.test(ua);
  var deferred = null;

  // Steps for browsers without an install prompt; null when there are none.
  function manualSteps() {
    if (ios) {
      return [
        'Tap the <b>Share</b> button (the square with an arrow) in the toolbar.',
        'Scroll down and tap <b>Add to Home Screen</b>.',
        'Tap <b>Add</b>. Church Manager now opens from your Home Screen.',
      ];
    }
    if (safari) {
      return [
        'In the menu bar, choose <b>File</b> › <b>Add to Dock</b> (macOS Sonoma or later).',
        'Click <b>Add</b>. Church Manager now opens from the Dock and Launchpad.',
      ];
    }
    if (firefox && android) {
      return [
        'Tap the menu <b>⋮</b>.',
        'Tap <b>Add app to Home screen</b> (or <b>Install</b>).',
      ];
    }
    return null;
  }

  function available() { return !installed && Boolean(deferred || manualSteps()); }

  function sync() {
    var show = available();
    document.querySelectorAll('[data-install-app]').forEach(function (el) { el.hidden = !show; });
  }

  var STYLE = '.pwa-help{width:min(420px,calc(100vw - 32px));padding:22px 22px 18px;border:1px solid var(--pc-line,#e3e3ea);border-radius:16px;'
    + 'background:var(--pc-panel,#fff);color:var(--pc-text,#16161d);box-shadow:0 24px 70px rgba(0,0,0,.28);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}'
    + '.pwa-help::backdrop{background:rgba(10,10,20,.45)}'
    + '.pwa-help h2{margin:0 0 4px;font-size:19px;font-weight:650}'
    + '.pwa-help p{margin:0 0 12px;color:var(--pc-text-2,#5b5b6b);font-size:14px}'
    + '.pwa-help ol{margin:0 0 16px;padding-left:20px;display:grid;gap:8px}'
    + '.pwa-help .pwa-row{display:flex;justify-content:flex-end}'
    + '.pwa-help button{min-height:38px;padding:0 16px;border:0;border-radius:10px;background:var(--pc-accent,#5b4cff);color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer}';

  function showSteps(steps) {
    var dlg = document.getElementById('pwaHelp');
    if (!dlg) {
      var style = document.createElement('style');
      style.textContent = STYLE;
      document.head.appendChild(style);
      dlg = document.createElement('dialog');
      dlg.id = 'pwaHelp';
      dlg.className = 'pwa-help';
      dlg.setAttribute('aria-labelledby', 'pwaHelpTitle');
      dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = '<h2 id="pwaHelpTitle">Install Church Manager</h2>'
      + '<p>Add it to this device to open it like any other app, full screen and without the browser bar.</p>'
      + '<ol>' + steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>'
      + '<p>You sign in once inside the installed app.</p>'
      + '<div class="pwa-row"><button type="button">Got it</button></div>';
    dlg.querySelector('button').addEventListener('click', function () { dlg.close(); });
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function start() {
    if (deferred) {
      var p = deferred;
      deferred = null;
      p.prompt();
      (p.userChoice || Promise.resolve()).then(sync, sync);
      return;
    }
    var steps = manualSteps();
    if (steps) showSteps(steps);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    sync();
  });
  window.addEventListener('appinstalled', function () {
    deferred = null;
    installed = true;
    sync();
  });

  // Keep the installed app's title bar the same colour as the page, including
  // when someone picks light or dark by hand (public/app-theme.js).
  function syncThemeColor(theme) {
    var color = theme === 'dark' ? '#0b0b0f' : '#f6f6f8';
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.setAttribute('content', color);
      m.removeAttribute('media');
    });
  }
  document.addEventListener('app:theme', function (e) { syncThemeColor(e.detail); });

  function init() {
    syncThemeColor(document.documentElement.getAttribute('data-theme'));
    sync();
    document.querySelectorAll('[data-install-app]:not([data-sheet-cmd])').forEach(function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); start(); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PwaInstall = { start: start, available: available };
})();
