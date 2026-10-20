/* Moved out of routes-pg-html/allowances.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
(function () {
  var key = document.currentScript.dataset.key || null;
  var state = document.getElementById('pushState'), on = document.getElementById('pushOn'), off = document.getElementById('pushOff');
  // The theme sets display on buttons, so the hidden attribute alone does not hide them.
  function show(text, canOn, canOff) { state.textContent = text; on.style.display = canOn ? '' : 'none'; off.style.display = canOff ? '' : 'none'; }
  function b64(s) { var p = '='.repeat((4 - s.length % 4) % 4); var raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); var a = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); return a; }
  function post(url, body) { return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    show(ios && !standalone ? 'Add this app to your Home Screen to get notifications on this device.' : 'This browser cannot show notifications.', false, false);
    document.getElementById('pushIos').style.display = ios && !standalone ? '' : 'none';
    return;
  }
  navigator.serviceWorker.register('/sw.js').then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
    if (Notification.permission === 'denied') show('Notifications are blocked for this site. Allow them in your browser or phone settings, then reload.', false, false);
    else if (sub) { post('/api/push/subscribe', sub.toJSON()); show('Notifications are on for this device.', false, true); }
    else show('Get allowance alerts on this device, even when the app is closed.', true, false);
  });
  on.addEventListener('click', function () {
    on.disabled = true;
    Notification.requestPermission().then(function (p) {
      if (p !== 'granted') { on.disabled = false; return show('Notifications were not allowed.', true, false); }
      return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) }); })
        .then(function (sub) { return post('/api/push/subscribe', sub.toJSON()); })
        .then(function (r) { on.disabled = false; if (!r.ok) throw new Error(); show('Notifications are on for this device.', false, true); });
    }).catch(function () { on.disabled = false; show('Could not turn notifications on. Try again.', true, false); });
  });
  off.addEventListener('click', function () {
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      if (!sub) return;
      return post('/api/push/unsubscribe', { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); });
    }).then(function () { show('Notifications are off for this device.', true, false); });
  });
})();
