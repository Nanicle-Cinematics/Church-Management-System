'use strict';
// Members > Import: upload a CSV or Excel file, check how its columns were
// matched and preview the result, then import. Admins only, like Export.
// The parsed file is kept in member_imports between the steps (deleted once
// imported, or after a day by lib/operations-scheduler.js). Parsing and
// cleaning live in lib/member-import.js.

const crypto = require('crypto');
const multer = require('multer');
const asyncHandler = require('../lib/async-handler');
const { esc, fmtBirthday } = require('../lib/format');
const { pageHero, statsRow, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const { icon } = require('../lib/icons');
const { csrfValid } = require('../lib/tenant-csrf');
const imp = require('../lib/member-import');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: imp.MAX_FILE_BYTES, files: 1 } });
const PREVIEW_ROWS = 15;
const LIST_LIMIT = 200;
const STATUS_LABELS = { VISITOR: 'Visitor', REGULAR: 'Regular', MEMBER: 'Member', DISTANT: 'Distant', INACTIVE: 'Inactive', TRANSFERRED: 'Transferred', DECEASED: 'Deceased', OTHER: 'Other' };
const CHANNEL_LABELS = { EITHER: 'SMS and email', SMS_ONLY: 'SMS only', EMAIL_ONLY: 'Email only', NONE: 'Do not contact' };

function requireAdmin(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

/** The column mapping and options from a query string or form, falling back to the guesses. */
function readChoices(src, headers) {
  const guessed = imp.guessMapping(headers);
  const has = Object.keys(src).some((k) => /^map\d+$/.test(k));
  const mapping = headers.map((_, i) => {
    if (!has) return guessed[i];
    const v = String(src[`map${i}`] || '');
    return imp.FIELD_KEYS.includes(v) ? v : '';
  });
  return {
    mapping,
    defaultStatus: imp.STATUSES.includes(src.status) ? src.status : 'MEMBER',
    defaultChannel: imp.CHANNELS.includes(src.channel) ? src.channel : 'EITHER',
    createGroups: has ? src.createGroups === '1' : true,
  };
}

/** Run every row through the cleaning and duplicate checks. Nothing is written. */
async function plan(db, rows, choices) {
  const existing = await imp.existingKeys(db);
  const inFile = { phone: new Set(), email: new Set(), name: new Set() };
  const out = [];
  rows.forEach((row, i) => {
    const r = imp.rowToMember(row, choices.mapping, choices);
    const line = i + 2; // the header is row 1
    if (r.error) { out.push({ line, kind: 'error', reason: r.error, row }); return; }
    const already = imp.duplicateReason(existing, r.data);
    const repeat = already ? null : imp.duplicateReason(inFile, r.data);
    if (already) { out.push({ line, kind: 'duplicate', reason: `already in the church (${already})`, data: r.data }); return; }
    if (repeat) { out.push({ line, kind: 'duplicate', reason: `repeats an earlier row (${repeat})`, data: r.data }); return; }
    imp.addKeys(inFile, r.data);
    out.push({ line, kind: 'ok', data: r.data, names: r.names, problems: r.problems });
  });
  return out;
}

function mappingForm(id, headers, rows, choices) {
  const sample = (i) => rows.map((r) => r[i]).filter(Boolean).slice(0, 3).map((v) => esc(v.length > 30 ? `${v.slice(0, 30)}…` : v)).join(', ');
  const opts = (sel) => `<option value="">Don't import</option>${imp.FIELDS.map(([k, label]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}`;
  return `<form method="get" action="/members/import/${id}" class="mi-map">
      ${table(['Column in your file', 'Examples', 'Import as'], headers.map((h, i) => [
        `<b>${esc(h)}</b>`, `<span class="muted-text">${sample(i) || '—'}</span>`,
        `<select name="map${i}" aria-label="Import ${esc(h)} as">${opts(choices.mapping[i])}</select>`,
      ]))}
      <div class="form" style="margin-top:12px">
        <label>Status when the file has none<select name="status">${imp.STATUSES.map((s) => `<option value="${s}" ${choices.defaultStatus === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}</select></label>
        <label>Contact preference when the file has none<select name="channel">${imp.CHANNELS.map((c) => `<option value="${c}" ${choices.defaultChannel === c ? 'selected' : ''}>${CHANNEL_LABELS[c]}</option>`).join('')}</select></label>
        <label class="wide mi-check"><input type="checkbox" name="createGroups" value="1" ${choices.createGroups ? 'checked' : ''}> Create Bible classes and organisations named in the file that don't exist yet</label>
        <div class="actions"><button type="submit" class="btn ghost">Update preview</button></div>
      </div>
    </form>`;
}

const rowList = (items, render) => (items.length
  ? `<ul class="mi-list">${items.slice(0, LIST_LIMIT).map(render).join('')}</ul>${items.length > LIST_LIMIT ? `<p class="muted-text">…and ${items.length - LIST_LIMIT} more.</p>` : ''}`
  : '');
const nameOf = (p) => (p.data ? `${p.data.firstName} ${p.data.lastName}` : (p.row || []).filter(Boolean).slice(0, 3).join(' · ') || 'Empty row');

function register(app) {
  app.get('/members/import/template.csv', requireAdmin, (req, res) => {
    const headers = ['Member ID', 'First name', 'Last name', 'Gender', 'Date of birth', 'Mobile', 'Email', 'Marital status', 'Status', 'Bible class', 'Organisations', 'Joined', 'Notes'];
    const example = ['', 'Ama', 'Mensah', 'F', '12/03/1990', '024 412 7781', 'ama@example.com', 'Married', 'Member', 'Wesley Class', 'Choir; Women\'s Fellowship', '01/06/2015', ''];
    const line = (r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="members-import-template.csv"' });
    res.send(`﻿${line(headers)}\r\n${line(example)}\r\n`);
  });

  app.get('/members/import', requireAdmin, (req, res) => {
    const body = `${pageHero('Import members', 'Add many members at once from a spreadsheet')}
      <section class="card">
        <div class="card-head"><h2>Choose a file</h2><span class="meta">CSV, Excel (.xlsx or .xls) · up to ${imp.MAX_ROWS.toLocaleString('en-GH')} rows, 5 MB</span></div>
        <form class="form" method="post" action="/members/import" enctype="multipart/form-data">
          <label class="wide">Member file<input type="file" name="file" required accept=".csv,.xlsx,.xls,.ods,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
          <div class="actions"><button type="submit">Upload and preview</button><a class="btn ghost" href="/members/import/template.csv">${icon('download')} Download a template</a></div>
        </form>
        <p class="muted-text">The first row must be the column names. Only the first sheet is read. Nothing is added until you have checked the preview and pressed Import.</p>
        <ul class="muted-text mi-tips">
          <li>Each member needs a first and last name, either in two columns or one "Name" column (split at the first space; titles like Mr, Mrs and Rev are dropped).</li>
          <li>Several organisations go in one cell, separated by ; or a comma.</li>
          <li>Dates can be written 12/03/1990 (day first), 1990-03-12 or 12 March 1990. Excel date cells work too.</li>
          <li>Rows with the same phone number, email, or name and date of birth as an existing member are skipped, so importing the same file twice is safe.</li>
          <li>A file exported from Members › Export can be imported as it is.</li>
        </ul>
      </section>`;
    res.page({ title: 'Members · Import', active: '/members', noHeader: true, body });
  });

  app.post('/members/import', requireAdmin, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        flash(req, err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB. Split it into smaller files.' : 'The file could not be uploaded. Try again.');
        return res.redirect('/members/import');
      }
      next();
    });
  }, asyncHandler(async (req, res) => {
    // Multipart bodies skip the global CSRF check (not parsed yet when it runs).
    if (!csrfValid(req)) return res.status(403).send('Security check failed. Refresh the page and try again.');
    if (!req.file) { flash(req, 'Choose a file to upload.'); return res.redirect('/members/import'); }
    const fileName = String(req.file.originalname || 'members').slice(0, 200);
    const sheet = imp.readSheet(req.file.buffer, fileName);
    if (sheet.error) { flash(req, sheet.error); return res.redirect('/members/import'); }
    const db = res.locals.db;
    // One file at a time per person; an abandoned preview is replaced.
    await db.memberImport.deleteMany({ where: { userId: res.locals.user.id } });
    const saved = await db.memberImport.create({ data: { userId: res.locals.user.id, fileName, headers: sheet.headers, rows: sheet.rows } });
    res.redirect(`/members/import/${saved.id}`);
  }));

  app.get('/members/import/:id(\\d+)', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const file = await db.memberImport.findFirst({ where: { id: Number(req.params.id), userId: res.locals.user.id } });
    if (!file) { flash(req, 'That upload has expired. Upload the file again.'); return res.redirect('/members/import'); }
    const { headers, rows } = file;
    const choices = readChoices(req.query, headers);
    const named = choices.mapping.includes('fullName') || (choices.mapping.includes('firstName') && choices.mapping.includes('lastName'));
    const result = await plan(db, rows, choices);
    const ok = result.filter((r) => r.kind === 'ok');
    const dups = result.filter((r) => r.kind === 'duplicate');
    const errors = result.filter((r) => r.kind === 'error');
    const withProblems = ok.filter((r) => r.problems.length);

    const cols = [['gender', 'Gender'], ['dateOfBirth', 'Born'], ['mobilePhone', 'Mobile'], ['email', 'Email'], ['membershipStatus', 'Status']];
    const previewTable = ok.length ? `<div class="mi-scroll">${table(
      ['Row', 'Name', ...cols.map((c) => c[1]), 'Bible class', 'Organisations'],
      ok.slice(0, PREVIEW_ROWS).map((r) => [r.line, `<b>${esc(r.data.firstName)} ${esc(r.data.lastName)}</b>`, ...cols.map(([k]) => esc(k === 'membershipStatus' ? STATUS_LABELS[r.data[k]] : k === 'dateOfBirth' && r.data[k] ? fmtBirthday(r.data[k]) : (r.data[k] || '—'))), esc(r.names.bibleClass || '—'), esc(r.names.organizations.join(', ') || '—')]),
    )}</div>` : '<p class="muted-text">No rows can be imported with these settings.</p>';

    const qs = new URLSearchParams(Object.fromEntries([
      ...choices.mapping.map((m, i) => [`map${i}`, m]), ['status', choices.defaultStatus], ['channel', choices.defaultChannel], ['createGroups', choices.createGroups ? '1' : '0'],
    ]));
    const body = `${pageHero('Check the import', `${file.fileName} · ${rows.length.toLocaleString('en-GH')} row${rows.length === 1 ? '' : 's'}`)}
      ${statsRow([
        { cls: 'green', icon: icon('userPlus'), value: ok.length, label: 'Ready to import' },
        { cls: 'orange', icon: icon('users'), value: dups.length, label: 'Already there or repeated' },
        { cls: 'red', icon: icon('alert'), value: errors.length, label: 'Cannot be imported' },
      ])}
      ${named ? '' : '<div class="pd-callout" role="alert"><span><b>No name column chosen.</b> Set a column to "Full name", or one to "First name" and one to "Last name".</span></div>'}
      <section class="card">
        <div class="card-head"><h2>Columns</h2><span class="meta">Check each column is matched to the right field</span></div>
        ${mappingForm(file.id, headers, rows, choices)}
      </section>
      <section class="card">
        <div class="card-head"><h2>Preview</h2><span class="meta">${ok.length > PREVIEW_ROWS ? `First ${PREVIEW_ROWS} of ${ok.length}` : `${ok.length} member${ok.length === 1 ? '' : 's'}`}</span></div>
        ${previewTable}
        <form method="post" action="/members/import/${file.id}" class="mi-go">
          ${[...qs.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
          <div class="actions">${ok.length ? `<button type="submit">Import ${ok.length.toLocaleString('en-GH')} member${ok.length === 1 ? '' : 's'}</button>` : ''}<a class="btn ghost" href="/members/import">Choose another file</a></div>
        </form>
      </section>
      ${withProblems.length ? `<section class="card"><div class="card-head"><h2>Imported with some values left out</h2><span class="meta">${withProblems.length}</span></div>
        ${rowList(withProblems, (r) => `<li><b>Row ${r.line}</b> ${esc(nameOf(r))}: ${esc(r.problems.join('; '))}</li>`)}</section>` : ''}
      ${dups.length ? `<section class="card"><div class="card-head"><h2>Skipped: already in the church or repeated</h2><span class="meta">${dups.length}</span></div>
        ${rowList(dups, (r) => `<li><b>Row ${r.line}</b> ${esc(nameOf(r))}: ${esc(r.reason)}</li>`)}</section>` : ''}
      ${errors.length ? `<section class="card"><div class="card-head"><h2>Skipped: cannot be imported</h2><span class="meta">${errors.length}</span></div>
        ${rowList(errors, (r) => `<li><b>Row ${r.line}</b> ${esc(nameOf(r))}: ${esc(r.reason)}</li>`)}</section>` : ''}`;
    res.page({ title: 'Members · Import', active: '/members', noHeader: true, body });
  }));

  app.post('/members/import/:id(\\d+)', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const file = await db.memberImport.findFirst({ where: { id: Number(req.params.id), userId: res.locals.user.id } });
    if (!file) { flash(req, 'That upload has already been imported or has expired.'); return res.redirect('/members'); }
    // Claim it first, so a double-click cannot import the file twice.
    const claimed = await db.memberImport.deleteMany({ where: { id: file.id } });
    if (!claimed.count) { flash(req, 'That upload has already been imported.'); return res.redirect('/members'); }

    const choices = readChoices(req.body || {}, file.headers);
    const ready = (await plan(db, file.rows, choices)).filter((r) => r.kind === 'ok');

    // Bible classes and organisations, matched by name (any case).
    const lc = (s) => s.toLowerCase();
    const classes = new Map((await db.ministry.findMany({ select: { id: true, name: true } })).map((m) => [lc(m.name), m.id]));
    const orgs = new Map((await db.organization.findMany({ select: { id: true, name: true } })).map((o) => [lc(o.name), o.id]));
    const created = { classes: [], orgs: [] };
    const unknown = { classes: new Set(), orgs: new Set() };
    for (const r of ready) {
      const c = r.names.bibleClass;
      if (c && !classes.has(lc(c))) {
        if (choices.createGroups) { classes.set(lc(c), (await db.ministry.create({ data: { name: c } })).id); created.classes.push(c); } else unknown.classes.add(c);
      }
      for (const o of r.names.organizations) {
        if (!orgs.has(lc(o))) {
          if (choices.createGroups) { orgs.set(lc(o), (await db.organization.create({ data: { name: o } })).id); created.orgs.push(o); } else unknown.orgs.add(o);
        }
      }
    }

    // Member IDs: keep the file's own when free, otherwise the next MBR-###.
    const taken = new Set((await db.member.findMany({ where: { externalId: { not: null } }, select: { externalId: true } })).map((m) => m.externalId));
    let next = 0;
    for (const id of taken) { const m = /^MBR-(\d+)$/.exec(id); if (m) next = Math.max(next, parseInt(m[1], 10)); }
    const allocate = () => { let id; do { next += 1; id = `MBR-${String(next).padStart(3, '0')}`; } while (taken.has(id)); taken.add(id); return id; };

    const toDate = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);
    let added = 0;
    // 1,000 rows at a time: few round trips, well under Postgres's 65,535 parameters.
    for (let i = 0; i < ready.length; i += 1000) {
      const chunk = ready.slice(i, i + 1000).map((r) => {
        const d = r.data;
        const externalId = d.externalId && !taken.has(d.externalId) ? (taken.add(d.externalId), d.externalId) : allocate();
        return {
          r,
          row: {
            ...d, externalId,
            dateOfBirth: toDate(d.dateOfBirth), joinDate: toDate(d.joinDate), baptismDate: toDate(d.baptismDate), confirmationDate: toDate(d.confirmationDate),
            bibleClassId: r.names.bibleClass ? classes.get(lc(r.names.bibleClass)) || null : null,
            unsubscribeToken: crypto.randomBytes(16).toString('hex'),
          },
        };
      });
      await db.member.createMany({ data: chunk.map((c) => c.row) });
      added += chunk.length;
      const ids = new Map((await db.member.findMany({ where: { externalId: { in: chunk.map((c) => c.row.externalId) } }, select: { id: true, externalId: true } })).map((m) => [m.externalId, m.id]));
      const links = [];
      for (const c of chunk) {
        const memberId = ids.get(c.row.externalId);
        for (const o of new Set(c.r.names.organizations.map(lc))) if (memberId && orgs.has(o)) links.push({ orgId: orgs.get(o), memberId });
      }
      if (links.length) await db.organizationMembership.createMany({ data: links, skipDuplicates: true });
    }

    await logActivity(db, 'members_imported', `${added} member${added === 1 ? '' : 's'} imported from ${file.fileName}`, '/members', res.locals.user.id);
    const notes = [];
    if (created.classes.length) notes.push(`${created.classes.length} new Bible class${created.classes.length === 1 ? '' : 'es'}`);
    if (created.orgs.length) notes.push(`${created.orgs.length} new organisation${created.orgs.length === 1 ? '' : 's'}`);
    const skipped = file.rows.length - added;
    let msg = `${added.toLocaleString('en-GH')} member${added === 1 ? '' : 's'} imported${notes.length ? `, with ${notes.join(' and ')}` : ''}.`;
    if (skipped) msg += ` ${skipped} row${skipped === 1 ? ' was' : 's were'} skipped.`;
    if (unknown.classes.size || unknown.orgs.size) msg += ` Not found, so left blank: ${[...unknown.classes, ...unknown.orgs].slice(0, 8).join(', ')}.`;
    flash(req, msg, 'success');
    res.redirect('/members');
  }));
}

module.exports = { register };
