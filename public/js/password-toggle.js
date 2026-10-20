/* Moved out of lib/shell.js so the page carries no inline script (see the
   Content-Security-Policy in lib/tenant-http.js). Loaded with defer. */
(function () {
  function enhancePasswordFields() {
    document.querySelectorAll('input[type="password"], input[data-password-toggle="1"]').forEach(function (input) {
      if (input.dataset.passwordToggle === '1') return;
      input.dataset.passwordToggle = '1';
      var wrap = document.createElement('span');
      wrap.className = 'password-field';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'password-toggle';
      btn.textContent = 'Show';
      btn.setAttribute('aria-label', 'Show password');
      btn.addEventListener('click', function () {
        var hidden = input.type === 'password';
        input.type = hidden ? 'text' : 'password';
        btn.textContent = hidden ? 'Hide' : 'Show';
        btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      });
      wrap.appendChild(btn);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhancePasswordFields);
  else enhancePasswordFields();
})();
