/* Page behaviour that used to be inline onclick / onsubmit / onchange
   attributes. The Content-Security-Policy (lib/tenant-http.js) forbids inline
   handlers, so a page asks for what it wants with a data- attribute and this
   file does it. One delegated listener per event covers forms and buttons that
   are on the page at load or added to it later.

     data-confirm="Question?"            on a <form> (asked on submit) or a button / link (asked on click)
     data-prompt="Question?"             on a <form>: asks for text on submit, cancels if empty,
       data-prompt-field="name"          and puts the answer in the form field with this name
     data-autosubmit                     on a <select> / input: submits its form when it changes
     data-disable-unless="field=VALUE"   on a <select>: disables the form field unless this one equals VALUE
     data-other-for="x_other"            on a <select>: shows the text box with that name only while "Other…" is chosen
     data-group-from="category"          on a <select>: offers only the options whose data-group matches that field's value
     data-sum-to="total"                 on a number input: adds up every input pointing at that field into it,
                                         until someone types a different figure there
     data-print                          on a link / button: opens the print dialog
     data-reload                         on a link / button: reloads the page
     data-refresh="4000"                 anywhere: reloads the page after that many milliseconds
     data-reload-on-online               anywhere: reloads the page when the device comes back online

   A message goes in the attribute as plain text, so a member's name inside it
   can never be run as code (the old inline handlers built JavaScript from it). */
(function () {
  function on(type, selector, handler) {
    document.addEventListener(type, function (event) {
      var el = event.target && event.target.closest ? event.target.closest(selector) : null;
      if (el) handler(event, el);
    });
  }

  on('submit', 'form[data-confirm]', function (event, form) {
    if (!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
  });
  on('click', 'a[data-confirm], button[data-confirm], input[data-confirm]', function (event, el) {
    if (!window.confirm(el.getAttribute('data-confirm'))) event.preventDefault();
  });

  on('submit', 'form[data-prompt]', function (event, form) {
    var answer = window.prompt(form.getAttribute('data-prompt'));
    if (!answer) { event.preventDefault(); return; }
    form.elements[form.getAttribute('data-prompt-field')].value = answer;
  });

  on('change', '[data-autosubmit]', function (event, el) { if (el.form) el.form.submit(); });
  on('change', '[data-disable-unless]', function (event, el) {
    var rule = el.getAttribute('data-disable-unless').split('=');
    if (el.form && el.form.elements[rule[0]]) el.form.elements[rule[0]].disabled = el.value !== rule[1];
  });

  // A drop-down with an "Other…" choice: the box for typing it appears only for that choice.
  function syncOther(sel) {
    var box = sel.form && sel.form.elements[sel.getAttribute('data-other-for')];
    if (!box) return;
    var other = sel.value === '__other';
    box.hidden = !other;
    box.required = other && sel.hasAttribute('data-required');
    return other ? box : null;
  }
  on('change', 'select[data-other-for]', function (event, sel) { var box = syncOther(sel); if (box) box.focus(); });
  // A drop-down whose choices depend on another field (an income subcategory follows its category).
  function syncGroup(sel) {
    var source = sel.form && sel.form.elements[sel.getAttribute('data-group-from')];
    if (!source) return;
    if (!sel._all) sel._all = Array.prototype.slice.call(sel.options).map(function (o) { return o.cloneNode(true); });
    var keep = sel.value;
    while (sel.options.length) sel.remove(0);
    sel._all.forEach(function (o) {
      var group = o.getAttribute('data-group');
      if (!group || group === source.value) sel.add(o.cloneNode(true));
    });
    sel.value = keep;
    if (sel.value !== keep) sel.selectedIndex = 0;
    syncOther(sel);
  }
  on('change', 'select', function (event, el) {
    if (!el.form || !el.name) return;
    Array.prototype.forEach.call(el.form.querySelectorAll('select[data-group-from]'), function (sel) {
      if (sel.getAttribute('data-group-from') === el.name) syncGroup(sel);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('select[data-group-from]'), syncGroup);
  // Men + Women + Children fill the Total as they are typed; typing in the Total itself takes over.
  function sumTargets(form, name) { return Array.prototype.slice.call(form.querySelectorAll('[data-sum-to="' + name + '"]')); }
  function sumTotal(total) {
    var parts = sumTargets(total.form, total.name), filled = false, sum = 0;
    parts.forEach(function (p) { if (p.value !== '') { filled = true; sum += Number(p.value) || 0; } });
    total.value = filled ? String(sum) : '';
  }
  on('input', '[data-sum-to]', function (event, el) {
    var total = el.form && el.form.elements[el.getAttribute('data-sum-to')];
    if (total && total.getAttribute('data-manual') !== '1') sumTotal(total);
  });
  on('input', 'input[data-sum-total]', function (event, total) { total.setAttribute('data-manual', total.value === '' ? '0' : '1'); });
  Array.prototype.forEach.call(document.querySelectorAll('input[data-sum-total]'), function (total) {
    var parts = sumTargets(total.form, total.name), sum = 0;
    parts.forEach(function (p) { sum += Number(p.value) || 0; });
    // an existing total that differs from the sum was typed by hand: leave it alone
    total.setAttribute('data-manual', total.value !== '' && Number(total.value) !== sum ? '1' : '0');
  });
  on('click', '[data-print]', function (event) { event.preventDefault(); window.print(); });
  on('click', '[data-reload]', function (event) { event.preventDefault(); window.location.reload(); });

  var refresh = document.querySelector('[data-refresh]');
  if (refresh) setTimeout(function () { window.location.reload(); }, Number(refresh.getAttribute('data-refresh')) || 4000);
  if (document.querySelector('[data-reload-on-online]')) window.addEventListener('online', function () { window.location.reload(); });
})();
