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

  on('click', '[data-print]', function (event) { event.preventDefault(); window.print(); });
  on('click', '[data-reload]', function (event) { event.preventDefault(); window.location.reload(); });

  var refresh = document.querySelector('[data-refresh]');
  if (refresh) setTimeout(function () { window.location.reload(); }, Number(refresh.getAttribute('data-refresh')) || 4000);
  if (document.querySelector('[data-reload-on-online]')) window.addEventListener('online', function () { window.location.reload(); });
})();
