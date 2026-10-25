'use strict';
// A drop-down for a field that used to be typed text. It offers the usual answers and an
// "Other…" choice that reveals a box for anything else, so nothing a church already
// records is ever refused. public/js/ui.js shows and hides the box (data-other-for) and,
// for a list that depends on another field, shows only that field's choices (data-group-from).
//
//   choiceField({ name: 'serviceLabel', label: 'Service', options: ['Sunday Service'], value })
//   readChoice(req.body, 'serviceLabel')   // the chosen option, or what was typed under Other…

const { esc } = require('./format');

const OTHER = '__other';

/** options: strings, or { value, label, group } (group = the controlling field's value it belongs to). */
function choiceField({ name, label, options, value = '', required = false, noneLabel = '— choose —', otherLabel = 'Other…', otherPlaceholder = 'Type it here', groupFrom = null, hint = '', wide = false }) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const current = String(value == null ? '' : value).trim();
  const known = opts.some((o) => o.value === current);
  const custom = current && !known;
  const selected = custom ? OTHER : current;
  const option = (v, l, group, sel) => `<option value="${esc(v)}"${group ? ` data-group="${esc(group)}"` : ''}${sel ? ' selected' : ''}>${esc(l)}</option>`;
  return `<label${wide ? ' class="wide"' : ''}>${esc(label)}
    <select name="${esc(name)}" data-other-for="${esc(name)}_other"${groupFrom ? ` data-group-from="${esc(groupFrom)}"` : ''}${required ? ' required data-required="1"' : ''}>
      ${option('', noneLabel, null, !selected)}${opts.map((o) => option(o.value, o.label, o.group, o.value === selected)).join('')}${option(OTHER, otherLabel, null, selected === OTHER)}
    </select>
    <input name="${esc(name)}_other" maxlength="120" placeholder="${esc(otherPlaceholder)}" value="${custom ? esc(current) : ''}"${custom ? '' : ' hidden'}>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
}

/** The answer to a choiceField: the option picked, or the text typed under "Other…"; '' when none. */
function readChoice(body, name, max = 120) {
  const picked = String((body && body[name]) == null ? '' : body[name]).trim();
  const text = picked === OTHER ? String((body && body[`${name}_other`]) == null ? '' : body[`${name}_other`]) : picked;
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = { OTHER, choiceField, readChoice };
