'use strict';
// The preacher roster for the Preaching Plan: each preacher has a code (S, M1, M2,
// or a lay preacher's number), a name and contact details. The plan picks from
// this list (routes-pg-html/preaching.js). Each church keeps its own list.
//
// Admins and Editors with full access add and edit; taking someone off the plan
// stays with admins. Contact details are shown only to those who can edit.

const asyncHandler = require('../lib/async-handler');
const { isLimited, requireEditorWithFullAccess } = require('../lib/access');
const { esc } = require('../lib/format');
const { pageHero } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const P = require('../lib/preachers');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}
const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

async function memberOptions(db, selected) {
  const members = await db.member.findMany({ where: { deletedAt: null }, orderBy: { lastName: 'asc' }, select: { id: true, firstName: true, lastName: true } });
  return '<option value="">Not a member</option>' + members.map((m) => `<option value="${m.id}"${m.id === selected ? ' selected' : ''}>${esc(`${m.firstName} ${m.lastName}`)}</option>`).join('');
}

async function form(db, p, action) {
  return `<form class="form" method="post" action="${action}">
    <label>Code<input name="code" required maxlength="3" value="${esc(p.code || '')}" list="preacher-codes" placeholder="S, M1, M2 or a number"><datalist id="preacher-codes"><option value="S"><option value="M1"><option value="M2"></datalist>
      <span class="hint">S superintendent minister, M1 circuit minister, M2 society minister, a number for a circuit lay preacher.</span></label>
    <label>Name<input name="name" required maxlength="120" value="${esc(p.name || '')}"></label>
    <label>Member<select name="memberId">${await memberOptions(db, p.memberId)}</select><span class="hint">If they are a member of this church, their member phone and email are used for reminders.</span></label>
    <label>Phone<input name="phone" maxlength="40" value="${esc(p.phone || '')}"></label>
    <label>Email<input type="email" name="email" maxlength="160" value="${esc(p.email || '')}"></label>
    <div class="actions form-actions"><a class="btn ghost" href="/preachers">Cancel</a><button type="submit">Save</button></div>
  </form>`;
}

function register(app) {
  app.get('/preachers', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const user = res.locals.user;
    const canEdit = (user.role === 'ADMIN' || user.role === 'EDITOR') && !isLimited(user);
    const list = (await db.preacher.findMany()).sort(P.byCode);
    const row = (p) => `<tr>
      <td><b>${esc(p.code)}</b></td><td>${esc(p.name)}${p.active ? '' : ' <span class="muted-text">(off the plan)</span>'}</td><td>${esc(P.typeOf(p.code))}</td>
      ${canEdit ? `<td>${esc([p.phone, p.email].filter(Boolean).join(' · ')) || '<span class="muted-text">none</span>'}</td>
      <td style="white-space:nowrap"><a href="/preachers/${p.id}/edit" class="link">Edit</a>
        ${user.role === 'ADMIN' ? `<form method="post" action="/preachers/${p.id}/${p.active ? 'archive' : 'restore'}" class="inline" data-confirm="${p.active ? 'Take this preacher off the plan? Past appointments keep their name.' : 'Put this preacher back on the plan?'}"><button type="submit" class="link">${p.active ? 'Take off plan' : 'Put back'}</button></form>` : ''}</td>` : ''}
    </tr>`;
    const body = `${pageHero('Preachers', 'Who may be appointed on the Preaching Plan, by code.')}
      ${canEdit ? `<details class="form-toggle" style="margin-bottom:1rem"${list.length ? '' : ' open'}><summary><strong>＋ Add a preacher</strong></summary><div style="margin-top:.75rem">${await form(db, {}, '/preachers')}</div></details>` : ''}
      <section class="card">
        <div class="card-head"><h2>Circuit preachers</h2><a href="/preaching">Preaching Plan</a></div>
        ${list.length ? `<table><thead><tr><th>Code</th><th>Name</th><th>Role</th>${canEdit ? '<th>Contact</th><th></th>' : ''}</tr></thead><tbody>${list.map(row).join('')}</tbody></table>`
          : `<p class="muted-text">No preachers yet.${canEdit ? ' Add the superintendent minister (S), circuit minister (M1), society minister (M2) and the lay preachers.' : ''}</p>`}
      </section>`;
    res.page({ title: 'Preachers', active: '/preaching', noHeader: true, body });
  }));

  // The same field rules for add and edit. Returns { data } or { error }.
  async function read(db, b, selfId) {
    const code = P.parseCode(b.code);
    if (!code) return { error: 'The code must be S, M1, M2 or a number (a circuit lay preacher).' };
    const name = clean(b.name, 120);
    if (!name) return { error: 'Enter the preacher’s name.' };
    const clash = await db.preacher.findFirst({ where: { code } });
    if (clash && clash.id !== selfId) return { error: `${code} is already ${clash.name}.` };
    let memberId = null;
    if (b.memberId) {
      const m = await db.member.findUnique({ where: { id: Number(b.memberId) } });
      if (!m) return { error: 'That member was not found.' };
      memberId = m.id;
    }
    return { data: { code, name, memberId, phone: clean(b.phone, 40), email: clean(b.email, 160) } };
  }

  app.post('/preachers', requireEditorWithFullAccess, asyncHandler(async (req, res) => {
    const r = await read(res.locals.db, req.body || {}, null);
    if (r.error) { flash(req, r.error); return res.redirect('/preachers'); }
    await res.locals.db.preacher.create({ data: r.data });
    await logActivity(res.locals.db, 'preacher_added', `Preacher added: ${r.data.code} ${r.data.name}`, '/preachers', res.locals.user.id);
    flash(req, `${r.data.code} · ${r.data.name} added.`, 'success');
    res.redirect('/preachers');
  }));

  app.get('/preachers/:id(\\d+)/edit', requireEditorWithFullAccess, asyncHandler(async (req, res) => {
    const id = idOf(req);
    const p = id ? await res.locals.db.preacher.findUnique({ where: { id } }) : null;
    if (!p) return res.status(404).send('Preacher not found');
    res.page({ title: 'Edit preacher', active: '/preaching', noHeader: true, body: `${pageHero('Edit preacher', `${p.code} · ${p.name}`)}${await form(res.locals.db, p, `/preachers/${p.id}`)}` });
  }));

  app.post('/preachers/:id(\\d+)', requireEditorWithFullAccess, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = idOf(req);
    const existing = id ? await db.preacher.findUnique({ where: { id } }) : null;
    if (!existing) return res.status(404).send('Preacher not found');
    const r = await read(db, req.body || {}, id);
    if (r.error) { flash(req, r.error); return res.redirect(`/preachers/${id}/edit`); }
    const saved = await db.preacher.update({ where: { id }, data: r.data });
    // Appointments still to come follow the new name and contact; past ones keep what they had.
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const { preacherId, ...copy } = P.planFields(saved);
    await db.preachingPlan.updateMany({ where: { preacherId: id, deletedAt: null, preachDate: { gte: today } }, data: copy });
    await logActivity(db, 'preacher_updated', `Preacher updated: ${saved.code} ${saved.name}`, '/preachers', res.locals.user.id);
    flash(req, 'Saved.', 'success');
    res.redirect('/preachers');
  }));

  for (const [action, active] of [['archive', false], ['restore', true]]) {
    app.post(`/preachers/:id(\\d+)/${action}`, requireAdmin, asyncHandler(async (req, res) => {
      const id = idOf(req);
      const p = id ? await res.locals.db.preacher.findUnique({ where: { id } }) : null;
      if (p) {
        await res.locals.db.preacher.update({ where: { id }, data: { active } });
        await logActivity(res.locals.db, `preacher_${active ? 'restored' : 'archived'}`, `${p.code} ${p.name} ${active ? 'put back on' : 'taken off'} the plan`, '/preachers', res.locals.user.id);
      }
      res.redirect('/preachers');
    }));
  }
}

module.exports = { register };
