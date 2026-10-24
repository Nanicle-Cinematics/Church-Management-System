'use strict';
// Markup for the Almanac: the colour chip, an entry, and the prompt an admin
// sees on the dashboard. Shared by routes-pg-html/almanac.js, the dashboard and
// the platform console. No inline script or style: colours are data-c attributes
// that public/liturgical.css (generated from lib/liturgical-palette.js) styles.

const { esc } = require('./format');
const { PALETTE, COLOURS, isColour, ymd } = require('./liturgical');

const dot = (colour) => `<span class="lit-dot" data-c="${esc(colour)}" aria-hidden="true"></span>`;
/** The colour as a dot and its NAME: the colour is never the only way to tell. */
const chip = (colour) => (isColour(colour) ? `<span class="lit-chip">${dot(colour)} ${esc(PALETTE[colour].label)}</span>` : '');

const longDate = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDate = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** One service: date, name, colour, theme, the readings and the hymns. */
function entryCard(e, { now = false, preachers = [] } = {}) {
  const label = e.serviceLabel ? ` <span class="muted-text">· ${esc(e.serviceLabel)}</span>` : '';
  const readings = [['Old Testament', e.oldTestament], ['Psalm', e.psalm], ['New Testament / Epistle', e.epistle], ['Gospel', e.gospel]].filter(([, v]) => v);
  const hymns = (e.hymns || []).filter(Boolean);
  const scripture = e.teachingService && !readings.length
    ? '<span class="muted-text">Teaching service: no readings set</span>'
    : (readings.length ? `<ul class="lit-readings">${readings.map(([k, v]) => `<li><b>${esc(k)}</b> ${esc(v)}</li>`).join('')}</ul>` : '<span class="muted-text">Not given</span>');
  return `<li class="almanac-entry${now ? ' is-now' : ''}" data-c="${esc(e.colour)}">
    <header>
      <h3>${esc(e.title)}${label}</h3>
      ${chip(e.colour)}${e.teachingService ? ' <span class="lit-badge">Teaching service</span>' : ''}
      <span class="when">${esc(longDate(e.serviceDate))}${now ? ' · this week' : ''}</span>
    </header>
    ${e.theme ? `<p class="theme">${esc(e.theme)}</p>` : ''}
    <dl>
      <div><dt>Scripture readings</dt><dd>${scripture}</dd></div>
      <div><dt>Hymns (MHB &amp; Canticles)</dt><dd>${hymns.length ? `<ol>${hymns.map((h) => `<li>${esc(h)}</li>`).join('')}</ol>` : '<span class="muted-text">Not given</span>'}</dd></div>
    </dl>
    ${preachers.length ? `<p class="preaching"><b>Preaching:</b> ${preachers.map(esc).join('; ')}</p>` : ''}
    ${e.notes ? `<p class="muted-text">${esc(e.notes)}</p>` : ''}
  </li>`;
}

/** <option>s for the colour pickers. */
const colourOptions = (selected) => COLOURS
  .map((k) => `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(PALETTE[k].label)}${PALETTE[k].note ? ` (${esc(PALETTE[k].note)})` : ''}</option>`)
  .join('');

/**
 * What an admin sees on the dashboard when this week's Almanac entry has a colour
 * and none is in force: one tap applies it to the whole church.
 */
function promptHtml(entry, returnTo = '/') {
  return `<div class="pd-callout lit-prompt" role="status" data-c="${esc(entry.colour)}">
    ${dot(entry.colour)}
    <span><b>This week's colour is ${esc(PALETTE[entry.colour].label)}</b> (${esc(entry.title)}, ${esc(shortDate(entry.serviceDate))}). Show it in the app for everyone in your church?</span>
    <form method="post" action="/almanac/colour">
      <input type="hidden" name="almanacId" value="${entry.id}">
      <input type="hidden" name="colour" value="${esc(entry.colour)}">
      <input type="hidden" name="return_to" value="${esc(returnTo)}">
      <button type="submit" name="scope" value="WEEK">This week</button>
      <button type="submit" name="scope" value="MONTH" class="ghost">This month</button>
      <button type="submit" formaction="/almanac/colour/later" class="ghost">Not now</button>
    </form>
    <a href="/almanac#colour">Choose another colour</a>
  </div>`;
}

module.exports = { dot, chip, longDate, shortDate, entryCard, colourOptions, promptHtml, ymd };
