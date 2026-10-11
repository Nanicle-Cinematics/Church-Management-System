/* Material You theme engine (no dependencies).
 *
 * Generates the tonal colour roles from ONE seed hue, the way a Pixel derives
 * its palette from the wallpaper, and applies them as CSS custom properties.
 * Loaded synchronously in <head> on every page so there is no flash of the
 * wrong colours. Choices persist in localStorage ('mu-seed', 'theme').
 *
 * Roles are an HSL approximation of Material 3's tonal palettes, which is
 * plenty for an interface and needs no colour-science library.
 */
(function () {
  var SEEDS = [['Church blue', 222], ['Harvest gold', 42], ['Forest', 150], ['Rose', 340], ['Violet', 270], ['Teal', 185]];
  var root = document.documentElement;

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }

  function systemDark() { return !!(window.matchMedia && matchMedia('(prefers-color-scheme:dark)').matches); }
  function isDark() { return root.getAttribute('data-theme') === 'dark'; }
  function seed() { var s = parseInt(read('mu-seed'), 10); return isNaN(s) ? 222 : s; }
  function hsl(h, s, l) { return 'hsl(' + (((h % 360) + 360) % 360) + ' ' + s + '% ' + l + '%)'; }

  function palette(h, dark) {
    var t = dark ? {
      pri: hsl(h, 85, 80), onpri: hsl(h, 60, 16), pc: hsl(h, 50, 28), onpc: hsl(h, 90, 90),
      sc: hsl(h + 25, 22, 28), onsc: hsl(h + 25, 35, 90), tc: hsl(h + 65, 30, 28), ontc: hsl(h + 65, 60, 90),
      sf: hsl(h, 12, 11), lo: hsl(h, 10, 14), c: hsl(h, 10, 17), hi: hsl(h, 10, 21), bg: hsl(h, 14, 7),
      on: hsl(h, 15, 90), onv: hsl(h, 12, 76), out: hsl(h, 8, 56), outv: hsl(h, 8, 28),
      ok: '#7bd88f', okc: '#173d24', warn: '#f0b95a', warnc: '#3d2c0e', bad: '#ffb4ab', badc: '#4a1614'
    } : {
      pri: hsl(h, 60, 40), onpri: '#ffffff', pc: hsl(h, 90, 90), onpc: hsl(h, 95, 12),
      sc: hsl(h + 25, 32, 88), onsc: hsl(h + 25, 40, 14), tc: hsl(h + 65, 55, 89), ontc: hsl(h + 65, 60, 16),
      sf: hsl(h, 30, 98), lo: hsl(h, 25, 96), c: hsl(h, 22, 94), hi: hsl(h, 20, 90), bg: hsl(h, 35, 91),
      on: hsl(h, 15, 10), onv: hsl(h, 10, 30), out: hsl(h, 8, 50), outv: hsl(h, 14, 80),
      ok: '#1b6b3a', okc: '#c4f0cf', warn: '#8a5300', warnc: '#ffe3b3', bad: '#ba1a1a', badc: '#ffdad6'
    };
    return {
      '--pri': t.pri, '--on-pri': t.onpri, '--pri-c': t.pc, '--on-pri-c': t.onpc,
      '--sec-c': t.sc, '--on-sec-c': t.onsc, '--ter-c': t.tc, '--on-ter-c': t.ontc,
      '--sf': t.sf, '--sf-lo': t.lo, '--sf-c': t.c, '--sf-hi': t.hi, '--bg': t.bg,
      '--on-sf': t.on, '--on-sf-v': t.onv, '--out': t.out, '--out-v': t.outv,
      '--ok': t.ok, '--ok-c': t.okc, '--warn': t.warn, '--warn-c': t.warnc, '--bad': t.bad, '--bad-c': t.badc
    };
  }

  function apply() {
    var vars = palette(seed(), isDark());
    for (var k in vars) root.style.setProperty(k, vars[k]);
    root.style.colorScheme = isDark() ? 'dark' : 'light';
    try { document.dispatchEvent(new CustomEvent('mu:theme')); } catch (e) { /* old browser */ }
  }

  // Theme: saved choice wins, otherwise follow the system.
  var saved = read('theme');
  root.setAttribute('data-theme', saved === 'dark' || saved === 'light' ? saved : (systemDark() ? 'dark' : 'light'));
  apply();

  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme:dark)');
    var follow = function () {
      var s = read('theme');
      if (s === 'dark' || s === 'light') return;
      root.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
      apply();
    };
    if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
  }

  window.MU = {
    SEEDS: SEEDS,
    seed: seed,
    isDark: isDark,
    setSeed: function (h) { write('mu-seed', String(h)); apply(); },
    setDark: function (dark) { write('theme', dark ? 'dark' : 'light'); root.setAttribute('data-theme', dark ? 'dark' : 'light'); apply(); },
    toggle: function () { window.MU.setDark(!isDark()); },
    apply: apply
  };
})();
