'use strict';
// Platform › Trial enquiries: demo requests from the marketing site
// (routes-pg-html/trial-enquiries.js), newest first. The operator marks each
// contacted, converted (linked to the church once it signs up) or declined,
// and keeps notes; Call, WhatsApp and an email inviting them to sign up are
// one click away.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, listCard } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { db: rawDb } = require('../lib/tenant');
const { icon } = require('../lib/icons');
const { operatorLayout } = require('../lib/operator-shell');
const { requireOperator, logPlatformEvent } = require('../lib/platform-operators');
const { normalizePhoneGH } = require('../lib/delivery');

const STATUSES = { new: ['New', 'pending'], contacted: ['Contacted', 'sent'], converted: ['Converted', 'fulfilled'], declined: ['Declined', 'failed'] };

function page(res, opts) {
  return res.send(operatorLayout({ ...opts, operator: res.locals.operator, flash: res.locals.flash, flashType: res.locals.flashType }));
}
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '');

function signupMail(t) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const subject = `Your Church Manager demo for ${t.churchName}`;
  const body = `Hello ${t.contactName},\n\nThank you for your interest in Church Manager for ${t.churchName}.\n\nYou can create your church's account here:\n${base}/signup\n\nCall or WhatsApp us if you would like help setting up.\n`;
  return `mailto:${encodeURIComponent(t.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function enquiryCard(t, churches) {
  const [label, tone] = STATUSES[t.status] || [t.status, 'pending'];
  const phone = normalizePhoneGH(t.phone);
  const links = [
    phone && `<a class="btn ghost" href="tel:${esc(phone)}">Call</a>`,
    phone && `<a class="btn ghost" href="https://wa.me/${esc(phone.replace(/\D/g, ''))}" target="_blank" rel="noopener">WhatsApp</a>`,
    t.email && `<a class="btn ghost" href="${esc(signupMail(t))}">Email a sign-up link</a>`,
  ].filter(Boolean).join(' ');
  const converted = t.convertedChurchId && churches.find((c) => c.id === t.convertedChurchId);
  return `
    <article class="card op-enquiry" id="t${t.id}">
      <div class="card-head">
        <h2>${esc(t.churchName)} <span class="pill pill-${tone}">${esc(label)}</span></h2>
        <span class="meta">${esc(when(t.createdAt))}</span>
      </div>
      <p><strong>${esc(t.contactName)}</strong>${t.role ? ` · ${esc(t.role)}` : ''} · ${esc(t.phone)}${t.email ? ` · ${esc(t.email)}` : ''}${t.memberCount ? ` · ${esc(t.memberCount)} members` : ''}</p>
      ${t.notes ? `<p class="op-enquiry-notes">${esc(t.notes).replace(/\n/g, '<br>')}</p>` : ''}
      ${converted ? `<p>Now <a href="/platform/churches/${esc(converted.id)}">${esc(converted.name)}</a>.</p>` : ''}
      ${t.contactedAt ? `<p class="muted-text">Contacted ${esc(when(t.contactedAt))}.</p>` : ''}
      <p>${links}</p>
      <form method="post" action="/platform/trials/${t.id}" class="filter-bar">
        <select name="status" aria-label="Status">${Object.entries(STATUSES).map(([v, [l]]) => `<option value="${v}"${v === t.status ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select name="churchId" aria-label="Their church, once signed up"><option value="">Their church, once signed up…</option>${churches.map((c) => `<option value="${esc(c.id)}"${c.id === t.convertedChurchId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <input name="note" maxlength="1000" value="${esc(t.operatorNote || '')}" placeholder="Your notes" style="flex:1;min-width:200px">
        <button type="submit">Save</button>
      </form>
    </article>`;
}

function register(app) {
  app.get('/platform/trials', requireOperator, asyncHandler(async (req, res) => {
    const show = Object.hasOwn(STATUSES, req.query.status) ? req.query.status : '';
    const [enquiries, counts, churches] = await Promise.all([
      rawDb.trialSignup.findMany({ where: show ? { status: show } : {}, orderBy: { createdAt: 'desc' }, take: 200 }),
      rawDb.trialSignup.groupBy({ by: ['status'], _count: { _all: true } }),
      rawDb.church.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    const count = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
    const total = counts.reduce((n, c) => n + c._count._all, 0);
    const tabs = `<nav class="pm-tabs" aria-label="Status">${[['', 'All', total], ...Object.entries(STATUSES).map(([v, [l]]) => [v, l, count[v] || 0])]
      .map(([v, l, n]) => `<a href="/platform/trials${v ? `?status=${v}` : ''}"${v === show ? ' aria-current="page"' : ''}>${l}<span>${n}</span></a>`).join('')}</nav>`;
    const body = `
      ${pageHero('Trial enquiries', 'Demo requests from the website. Newest first.')}
      ${statsRow([
        { cls: 'gold', icon: icon('bell'), value: String(count.new || 0), label: 'New' },
        { cls: 'blue', icon: icon('phone'), value: String(count.contacted || 0), label: 'Contacted' },
        { cls: 'green', icon: icon('checkCircle'), value: String(count.converted || 0), label: 'Converted' },
        { cls: 'purple', icon: icon('trend'), value: total ? `${Math.round(((count.converted || 0) / total) * 100)}%` : '—', label: 'Conversion' },
      ])}
      ${tabs}
      ${enquiries.length ? enquiries.map((t) => enquiryCard(t, churches)).join('') : listCard({ title: 'No enquiries', count: 0, countLabel: '', inner: '<p class="muted-text">Demo requests from the website will appear here, and you will get an email for each.</p>' })}`;
    page(res, { title: 'Trial enquiries', active: '/platform/trials', body });
  }));

  app.post('/platform/trials/:id', requireOperator, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const t = Number.isInteger(id) ? await rawDb.trialSignup.findUnique({ where: { id } }) : null;
    if (!t) { flash(req, 'Enquiry not found.'); return res.redirect('/platform/trials'); }
    const b = req.body || {};
    let status = Object.hasOwn(STATUSES, b.status) ? b.status : t.status;
    let churchId = b.churchId ? String(b.churchId) : null;
    if (churchId && !(await rawDb.church.findUnique({ where: { id: churchId }, select: { id: true } }))) churchId = null;
    if (churchId && status !== 'declined') status = 'converted'; // linking a church means they signed up
    await rawDb.trialSignup.update({
      where: { id },
      data: {
        status,
        convertedChurchId: churchId,
        operatorNote: String(b.note || '').trim().slice(0, 1000) || null,
        contactedAt: t.contactedAt || (status !== 'new' ? new Date() : null),
      },
    });
    if (status !== t.status) {
      await logPlatformEvent(req, { operator: res.locals.operator, event: 'platform.trial_status', subject: `${t.churchName}: ${STATUSES[t.status]?.[0] || t.status} → ${STATUSES[status][0]}`, churchId });
    }
    flash(req, `Saved: ${t.churchName}.`, 'success');
    res.redirect(`/platform/trials${req.query.status ? `?status=${encodeURIComponent(req.query.status)}` : ''}#t${id}`);
  }));
}

module.exports = { register };
