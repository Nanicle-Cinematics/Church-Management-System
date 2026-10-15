'use strict';
// The member profile page body, as a pure function of already-loaded data so
// the route (routes-pg-html/members.js) and the design preview
// (scripts/ui-preview.js) render the same markup.
//
// The page reads top-down like a record card: who this is, how to reach them,
// then history. Editing used to BE the page (a 20-field form beside a thin
// summary); it is now one deliberate action that opens a panel below, so
// people who only want a phone number or an emergency contact see them at once.

const { esc, fmtDate, fmtBirthday } = require('./format');
const { memberAvatar } = require('./views');

const STATUS_LABELS = { VISITOR: 'Visitor', REGULAR: 'Regular', MEMBER: 'Member', DISTANT: 'Distant', INACTIVE: 'Inactive', TRANSFERRED: 'Transferred', DECEASED: 'Deceased', OTHER: 'Other' };
const PREF_LABELS = { EITHER: 'SMS and email', SMS_ONLY: 'SMS only', EMAIL_ONLY: 'Email only', NONE: 'Do not contact' };
const MARITAL_LABELS = { SINGLE: 'Single', MARRIED: 'Married', DIVORCED: 'Divorced', WIDOWED: 'Widowed', SEPARATED: 'Separated', OTHER: 'Other' };
const GENDER_LABELS = { M: 'Male', F: 'Female', O: 'Other' };

const dateOf = (v) => (v ? esc(fmtDate(v instanceof Date ? v.toISOString() : v)) : '');

// One row of the facts list; rows with no value are left out rather than
// printing a column of dashes.
function fact(label, valueHtml) {
  return valueHtml ? `<div><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>` : '';
}

function section(title, inner, count) {
  return `<section class="profile-section">
    <h2>${esc(title)}${count != null ? ` <span class="muted-text">${count}</span>` : ''}</h2>
    ${inner}
  </section>`;
}

function simpleTable(headers, rows) {
  return `<table class="data-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(headers[i])}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/**
 * @param {object} p
 * @param {object} p.m               member row (with bibleClass)
 * @param {Array}  p.orgs            [{ organization: { id, name } }]
 * @param {Array}  p.ministries      [{ ministry: { name }, role, joinedDate }]
 * @param {Array}  p.sacraments      [{ sacramentType, occurredOn, location }]
 * @param {Array}  p.attendance      [{ event: { title, startsAt } }]
 * @param {boolean} p.isAdmin   archive
 * @param {boolean} [p.canEdit] edit details, contact, photo (admins and editors; defaults to isAdmin)
 * @param {string} p.akanName        e.g. "Akosua / Kwasi" for the day born, or ''
 * @param {string} p.photoControlsHtml  admin-only upload/remove forms
 * @param {string} p.editFormHtml       admin-only edit form
 */
function renderMemberProfile({ m, orgs, ministries, sacraments, attendance, isAdmin, canEdit = isAdmin, akanName, photoControlsHtml, editFormHtml }) {
  const id = m.id;
  const fullName = `${m.firstName} ${m.lastName}`;
  const avatar = memberAvatar({ photo_filename: m.photoFilename, first_name: m.firstName, last_name: m.lastName });
  const status = STATUS_LABELS[m.membershipStatus] || m.membershipStatus;

  const sub = [
    m.externalId ? esc(m.externalId) : '',
    m.bibleClass ? esc(m.bibleClass.name) : '',
    m.joinDate ? `Joined ${dateOf(m.joinDate)}` : '',
  ].filter(Boolean).join(' · ');

  const actions = canEdit ? `
    <div class="profile-actions">
      <a class="btn" href="#edit" data-open-edit>Edit details</a>
      ${isAdmin ? `<form method="post" action="/members/${id}/delete" onsubmit="return confirm('Archive this member? They will be hidden but not permanently deleted.')">
        <button class="ghost" type="submit">Archive</button>
      </form>` : ''}
    </div>` : '';

  const hasContact = Boolean(m.mobilePhone || m.email);
  const contact = hasContact ? `<ul class="profile-contact">
    ${m.mobilePhone ? `<li><span>Mobile</span><a href="tel:${esc(m.mobilePhone)}">${esc(m.mobilePhone)}</a></li>` : ''}
    ${m.email ? `<li><span>Email</span><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></li>` : ''}
  </ul>` : `<p class="muted-text">No phone or email on file.${canEdit ? ' <a href="#edit" data-open-edit>Add contact details</a>' : ''}</p>`;

  const facts = [
    fact('Date of birth', esc(fmtBirthday(m.dateOfBirth))),
    fact('Day born', m.dayBorn ? `${esc(m.dayBorn)}${akanName ? ` <span class="muted-text">(${esc(akanName)})</span>` : ''}` : ''),
    fact('Gender', esc(GENDER_LABELS[m.gender] || '')),
    fact('Marital status', esc(MARITAL_LABELS[m.maritalStatus] || '')),
    fact('Baptised', dateOf(m.baptismDate)),
    fact('Confirmed', dateOf(m.confirmationDate)),
    fact('Organizations', orgs.map((o) => `<a href="/organizations/${o.organization.id}">${esc(o.organization.name)}</a>`).join(', ')),
    fact('Messages', esc(PREF_LABELS[m.preferredChannel] || '')),
  ].join('');
  const details = `<dl class="facts">${facts || '<div><dd class="muted-text">No further details recorded.</dd></div>'}</dl>
    ${m.notes ? `<div class="profile-notes"><h3>Notes</h3><p>${esc(m.notes)}</p></div>` : ''}`;

  const attendanceBlock = section('Recent attendance', attendance.length
    ? simpleTable(['Event', 'When'], attendance.map((r) => [esc(r.event.title), esc(fmtDate(r.event.startsAt))]))
    : '<p class="muted-text">No attendance recorded yet.</p>');

  const sacramentsBlock = sacraments.length
    ? section('Sacraments', simpleTable(['Type', 'Date', 'Where'], sacraments.map((r) => [esc(r.sacramentType), esc(fmtDate(r.occurredOn)), esc(r.location)]))) : '';
  const ministriesBlock = ministries.length
    ? section('Ministries', simpleTable(['Ministry', 'Role', 'Since'], ministries.map((r) => [esc(r.ministry.name), esc(r.role), esc(fmtDate(r.joinedDate))]))) : '';

  const emergency = (m.emergencyContactName || m.emergencyContactPhone || m.emergencyContactRelation)
    ? `<div class="side-card emergency">
        <h3>Emergency contact</h3>
        <p class="e-name">${esc(m.emergencyContactName) || '—'}${m.emergencyContactRelation ? ` <span class="muted-text">(${esc(m.emergencyContactRelation)})</span>` : ''}</p>
        ${m.emergencyContactPhone ? `<p><a href="tel:${esc(m.emergencyContactPhone)}">${esc(m.emergencyContactPhone)}</a></p>` : ''}
      </div>`
    : `<div class="side-card"><h3>Emergency contact</h3><p class="muted-text">None on file.${canEdit ? ' <a href="#edit" data-open-edit>Add one</a>' : ''}</p></div>`;

  const photo = canEdit && photoControlsHtml ? `<div class="side-card"><h3>Photo</h3>${photoControlsHtml}</div>` : '';

  const editPanel = canEdit ? `
    <details class="edit-panel" id="edit">
      <summary>Edit details</summary>
      ${editFormHtml}
    </details>
    <script>
      (function () {
        var panel = document.getElementById('edit');
        function open() { if (panel) { panel.open = true; panel.scrollIntoView({ block: 'start' }); } }
        if (location.hash === '#edit') panel.open = true;
        document.querySelectorAll('[data-open-edit]').forEach(function (a) { a.addEventListener('click', function () { if (panel) panel.open = true; }); });
      })();
    </script>` : '';

  return `<article class="profile">
    <header class="profile-head">
      <div class="profile-id">
        <span class="profile-avatar">${avatar}</span>
        <div>
          <h1 class="profile-name">${esc(fullName)}</h1>
          <p class="profile-sub"><span class="pill pill-${esc(String(m.membershipStatus).toLowerCase())}">${esc(status)}</span>${sub ? ` <span>${sub}</span>` : ''}</p>
        </div>
      </div>
      ${actions}
    </header>
    <div class="profile-grid">
      <div class="profile-main">
        ${section('Contact', contact)}
        ${section('Details', details)}
        ${attendanceBlock}
        ${sacramentsBlock}
        ${ministriesBlock}
      </div>
      <aside class="profile-side">${emergency}${photo}</aside>
    </div>
    ${editPanel}
  </article>`;
}

module.exports = { renderMemberProfile };
