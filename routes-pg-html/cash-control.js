'use strict';
// Cash control: count sheets and bank deposits.
//
// Count sheets (/finance/cash-counts) record a collection counted by hand,
// note by note, against what was expected. They post nothing: the collection
// itself reached the ledger when it was recorded. A fund manager other than
// the person who entered the sheet verifies it.
//
// Bank deposits (/finance/deposits) record money taken to the bank by hand —
// there is no bank connection. A deposit either banks ticked collections
// (general income, tithes, day-born collections, service offerings; its
// amount is their total) or a typed amount (harvest, special offering and
// pledge money). It is PENDING until the slip number is recorded, then a fund
// manager other than its recorder verifies it, which posts Dr 1010 Bank
// Deposit Clearing / Cr 1000 Cash in hand. A void after verification reverses
// that entry and releases the ticked collections.
//
// Arithmetic is in pesewas (lib/cash-count.js); reversing a banked collection
// is refused centrally (assertNotBanked in lib/ledger-pg.js).

const asyncHandler = require('../lib/async-handler');
const { esc, fmtMoney, todayISO, isMoneyPositive, isMoneyNonNeg, isValidDate } = require('../lib/format');
const { pageHero, statsRow, table } = require('../lib/views');
const { scriptTag } = require('../lib/style-tags');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const ledger = require('../lib/ledger-pg');
const { amountInWords } = require('../lib/money');
const { icon } = require('../lib/icons');
const { DENOMINATIONS, computeCount, countVariance, denominationLabel, toPesewas } = require('../lib/cash-count');
const deposits = require('../lib/bank-deposits');
const {
  requireFinanceWrite, requireFundManager, requireFinanceReportAccess, refuseIfPeriodLocked, checkFundId, fundOptions,
} = require('./finance');

const COUNT_STATUSES = ['COUNTED', 'VERIFIED', 'VOIDED'];
const DEPOSIT_STATUSES = ['PENDING', 'DEPOSITED', 'VERIFIED', 'VOIDED'];
const PILL = { COUNTED: 'pending', PENDING: 'pending', DEPOSITED: 'open', VERIFIED: 'approved', VOIDED: 'reversed' };
const COLLECTIONS = ['Sunday offering', 'Main offertory', 'Thanksgiving', 'Tithes', 'Day-born', 'Harvest', 'Special offering', 'Pledge payments', 'Other'];

const iso = (d) => (d ? d.toISOString().slice(0, 10) : '');
const pill = (status) => `<span class="pill pill-${PILL[status] || 'other'}">${esc(status.charAt(0) + status.slice(1).toLowerCase())}</span>`;
const isFinanceWriter = (u) => !!u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(u.financeRole));
const isFundManager = (u) => !!u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(u.financeRole));

function varianceHtml(v) {
  if (v.kind === 'NONE') return '—';
  if (v.kind === 'BALANCED') return '<span class="positive">Balanced</span>';
  if (v.kind === 'SHORTAGE') return `<span class="negative">Short ${fmtMoney(-v.difference)}</span>`;
  return `<span class="negative">Over ${fmtMoney(v.difference)}</span>`;
}

async function userNames(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: list } }, select: { id: true, displayName: true } });
  return new Map(users.map((u) => [u.id, u.displayName]));
}

// Create a numbered row (CC-2026-0001, DEP-2026-0001) inside a transaction.
async function createNumbered(tx, churchId, delegate, field, prefix, year, data) {
  const no = await deposits.nextDocNo(tx, churchId, delegate, field, prefix, year);
  return delegate.create({ data: { ...data, [field]: no } });
}

// Live totals in the browser use the same pesewa arithmetic as the server;
// the server recomputes everything on save and is what is stored.
const COUNT_SCRIPT = `${scriptTag('cash-count')}`;
const DEPOSIT_SCRIPT = `${scriptTag('cash-deposit')}`;

function register(app) {
  // ---------------------------------------------------------------------------
  //  Cash count sheets
  // ---------------------------------------------------------------------------
  app.get('/finance/cash-counts', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const user = res.locals.user;
    const canWrite = isFinanceWriter(user);
    const canVerify = isFundManager(user);
    const status = COUNT_STATUSES.includes(req.query.status) ? req.query.status : '';
    const sheets = await db.cashCountSheet.findMany({
      where: status ? { status } : {}, orderBy: [{ serviceDate: 'desc' }, { id: 'desc' }], take: 100,
    });

    const live = sheets.filter((s) => s.status !== 'VOIDED');
    let counted = 0, shortages = 0, shortSheets = 0;
    for (const s of live) {
      counted += toPesewas(s.countedAmount);
      const v = countVariance(s.countedAmount, s.expectedAmount);
      if (v.kind === 'SHORTAGE') { shortages += toPesewas(-v.difference); shortSheets++; }
    }
    const awaiting = live.filter((s) => s.status === 'COUNTED').length;

    const qtyRows = (kind) => DENOMINATIONS.filter((d) => d.kind === kind).map((d) => `<tr>
        <td>${esc(d.label)}</td>
        <td><input type="number" min="0" step="1" inputmode="numeric" name="qty:${esc(d.key)}" data-value="${d.value}" aria-label="Quantity of ${esc(d.label)}" style="max-width:6rem"></td>
        <td data-line="qty:${esc(d.key)}" style="text-align:right">—</td></tr>`).join('');
    const addForm = canWrite ? `<details class="form-toggle" style="margin-bottom:1rem" ${req.query.new ? 'open' : ''}>
        <summary><strong>+ New cash count</strong></summary>
        <form class="form" method="post" action="/finance/cash-counts" data-cash-count style="margin-top:0.75rem">
          <label>Service date<input type="date" name="serviceDate" required value="${todayISO()}"></label>
          <label>Service<input name="serviceLabel" placeholder="e.g. Sunday 1st service"></label>
          <label>Collection counted<select name="collection" required>${COLLECTIONS.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
          <label>Fund<select name="fundId">${await fundOptions(db, '', true)}</select></label>
          <label>Expected amount (GH₵)<input type="number" step="0.01" min="0" name="expectedAmount" placeholder="Leave blank if not known"></label>
          <fieldset class="wide-cell"><legend>Count by denomination</legend><div class="two-col">
            <table class="data-table"><thead><tr><th>Notes</th><th>Quantity</th><th>Amount</th></tr></thead><tbody>${qtyRows('NOTE')}</tbody></table>
            <table class="data-table"><thead><tr><th>Coins</th><th>Quantity</th><th>Amount</th></tr></thead><tbody>${qtyRows('COIN')}</tbody></table></div>
            <p><strong>Counted: <span data-total>GH₵ 0.00</span></strong> · Difference: <span data-diff>—</span></p>
          </fieldset>
          <label>Counted by<input name="countedBy" required placeholder="Names of the counters"></label>
          <label>Witnessed by<input name="witnessedBy"></label>
          <label>Money received by<input name="receivedBy" placeholder="Officer who took custody"></label>
          <label class="wide">Notes<input name="notes" placeholder="e.g. one torn GH₵ 20 note set aside"></label>
          <div class="actions"><button type="submit">Save cash count</button></div>
          <p class="muted-text wide-cell">Saved as Counted. A fund manager other than you then verifies the sheet. A count posts nothing to the books.</p>
        </form>
      </details>${COUNT_SCRIPT}` : '';

    const rows = sheets.map((s) => {
      const actions = [];
      if (s.status === 'COUNTED' && canVerify && s.enteredBy !== user.id) {
        actions.push(`<form method="post" action="/finance/cash-counts/${s.id}/verify" style="display:inline"><button class="link" type="submit">Verify</button></form>`);
      }
      actions.push(`<a class="link" href="/finance/cash-counts/${s.id}">View / print</a>`);
      return [
        esc(s.sheetNo), esc(iso(s.serviceDate)) + (s.serviceLabel ? `<br><span class="muted-text">${esc(s.serviceLabel)}</span>` : ''),
        esc(s.collection), s.expectedAmount == null ? '—' : fmtMoney(s.expectedAmount), fmtMoney(s.countedAmount),
        varianceHtml(countVariance(s.countedAmount, s.expectedAmount)), esc(s.countedBy), pill(s.status), actions.join(' · '),
      ];
    });

    const filter = `<form method="get" class="filter-bar" style="margin-bottom:1rem"><label>Status <select name="status" data-autosubmit>
        <option value="">All</option>${COUNT_STATUSES.map((st) => `<option value="${st}" ${st === status ? 'selected' : ''}>${st.charAt(0) + st.slice(1).toLowerCase()}</option>`).join('')}
      </select></label><noscript><button type="submit">Filter</button></noscript></form>`;
    const body = `
      ${statsRow([
        { cls: 'green', icon: icon('finance'), value: fmtMoney(counted / 100), label: `Counted (${live.length} sheet${live.length === 1 ? '' : 's'})` },
        { cls: awaiting ? 'orange' : 'blue', icon: icon('clock'), value: awaiting, label: 'Awaiting verification' },
        { cls: shortages ? 'orange' : 'blue', icon: icon('alert'), value: fmtMoney(shortages / 100), label: `Shortages (${shortSheets} sheet${shortSheets === 1 ? '' : 's'})` },
      ])}
      ${addForm}
      ${filter}
      <section class="card">
        <div class="card-head"><h2>Count sheets</h2><span class="meta">${sheets.length} shown</span></div>
        ${rows.length ? table(['Sheet', 'Service date', 'Collection', 'Expected', 'Counted', 'Difference', 'Counted by', 'Status', ''], rows)
          : `<p class="muted-text">No cash counts yet.${canWrite ? ' After a service, open “New cash count” and enter how many of each note and coin were counted.' : ''}</p>`}
      </section>`;
    res.page({ title: 'Finance · Cash Counts', active: '/finance', noHeader: true, body: `${pageHero('Cash Count Sheets', 'Each collection counted by hand, note by note, and checked by a second officer.')}${body}` });
  }));

  app.post('/finance/cash-counts', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const back = '/finance/cash-counts?new=1';
    if (!isValidDate(b.serviceDate)) { flash(req, 'Enter a valid service date.'); return res.redirect(back); }
    const collection = String(b.collection || '').trim();
    if (!collection) { flash(req, 'Choose the collection that was counted.'); return res.redirect(back); }
    const countedBy = String(b.countedBy || '').trim();
    if (!countedBy) { flash(req, 'Name the person or people who counted.'); return res.redirect(back); }
    const expectedRaw = String(b.expectedAmount || '').trim();
    if (expectedRaw && !isMoneyNonNeg(expectedRaw)) { flash(req, 'Expected amount must be 0 or more.'); return res.redirect(back); }
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) { flash(req, 'Fund not found.'); return res.redirect(back); }

    const quantities = {};
    for (const [k, v] of Object.entries(b)) if (k.startsWith('qty:')) quantities[k.slice(4)] = v;
    const count = computeCount(quantities);
    if (!count.ok) { flash(req, count.message); return res.redirect(back); }

    const expected = expectedRaw ? Math.round(Number(expectedRaw) * 100) / 100 : null;
    const sheet = await db.$transaction(async (tx) => {
      const created = await createNumbered(tx, res.locals.churchId, tx.cashCountSheet, 'sheetNo', 'CC', b.serviceDate.slice(0, 4), {
        serviceDate: new Date(b.serviceDate), serviceLabel: String(b.serviceLabel || '').trim() || null, collection,
        fundId: fundCheck.fundId, expectedAmount: expected, countedAmount: count.total, countedBy,
        witnessedBy: String(b.witnessedBy || '').trim() || null, receivedBy: String(b.receivedBy || '').trim() || null,
        notes: String(b.notes || '').trim() || null, enteredBy: res.locals.user.id,
      });
      // Flat createMany with churchId, not a nested write: the tenant
      // extension stamps churchId on top-level creates only (see ledger-pg).
      await tx.cashCountLine.createMany({
        data: count.lines.map((l) => ({ churchId: res.locals.churchId, sheetId: created.id, kind: l.kind, denomination: l.value, quantity: l.quantity, amount: l.amount })),
      });
      return created;
    }, { timeout: 15000, maxWait: 15000 });

    const v = countVariance(count.total, expected);
    await logActivity(db, 'cash_count_entered',
      `Cash count ${sheet.sheetNo} (${collection}): ${fmtMoney(count.total)} counted${v.kind === 'SHORTAGE' ? `, short by ${fmtMoney(-v.difference)}` : v.kind === 'SURPLUS' ? `, over by ${fmtMoney(v.difference)}` : ''}`,
      `/finance/cash-counts/${sheet.id}`, res.locals.user.id);
    flash(req, `Cash count ${sheet.sheetNo} saved. It now awaits verification.`, 'success');
    res.redirect(`/finance/cash-counts/${sheet.id}`);
  }));

  app.get('/finance/cash-counts/:id(\\d+)', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const sheet = await db.cashCountSheet.findFirst({ where: { id: Number(req.params.id) } });
    if (!sheet) return res.status(404).send('Cash count not found');
    const lines = await db.cashCountLine.findMany({ where: { sheetId: sheet.id }, orderBy: [{ kind: 'desc' }, { denomination: 'desc' }] });
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const fund = sheet.fundId ? await db.fund.findUnique({ where: { id: sheet.fundId } }) : null;
    const names = await userNames(db, [sheet.enteredBy, sheet.verifiedBy, sheet.voidedBy]);
    const user = res.locals.user;
    const v = countVariance(sheet.countedAmount, sheet.expectedAmount);

    const actions = [];
    if (sheet.status === 'COUNTED' && isFundManager(user) && sheet.enteredBy !== user.id) {
      actions.push(`<form method="post" action="/finance/cash-counts/${sheet.id}/verify" style="display:inline"><button type="submit">Verify</button></form>`);
    }
    if (sheet.status !== 'VOIDED' && isFundManager(user)) {
      actions.push(`<form method="post" action="/finance/cash-counts/${sheet.id}/void" style="display:inline" data-prompt="Reason for voiding this cash count?" data-prompt-field="reason">
        <input type="hidden" name="reason"><button class="btn ghost" type="submit">Void</button></form>`);
    }
    const body = `
      <div class="screen-only receipt-actions">
        <a class="btn" href="#" data-print>🖨 Print / save as PDF</a>
        ${actions.join(' ')}
        <a class="btn-link" href="/finance/cash-counts">← Back to cash counts</a>
      </div>
      <div class="print-doc receipt-doc">
        <div class="rc-head">
          <div><div class="rc-church">⛪ ${esc(church.name)}</div><div class="muted-text">Cash Count Sheet</div></div>
          <div class="rc-no"><strong>${esc(sheet.sheetNo)}</strong><br><span class="muted-text">${esc(iso(sheet.serviceDate))}</span><br>${pill(sheet.status)}</div>
        </div>
        ${sheet.status === 'VOIDED' ? `<p class="pill pill-reversed">Voided${sheet.voidReason ? ': ' + esc(sheet.voidReason) : ''}</p>` : ''}
        <div class="rc-line"><span>Service</span><span>${esc(sheet.serviceLabel || '—')}</span></div>
        <div class="rc-line"><span>Collection</span><span>${esc(sheet.collection)}</span></div>
        <div class="rc-line"><span>Fund</span><span>${esc((fund && fund.name) || 'General fund')}</span></div>
        ${table(['Denomination', 'Quantity', 'Amount'], lines.map((l) => [esc(denominationLabel(l.kind, l.denomination)), l.quantity, fmtMoney(l.amount)]))}
        <div class="rc-line rc-total"><span>Total counted</span><strong>${fmtMoney(sheet.countedAmount)}</strong></div>
        <div class="rc-line"><span>Amount in words</span><span>${esc(amountInWords(sheet.countedAmount))}</span></div>
        <div class="rc-line"><span>Expected</span><span>${sheet.expectedAmount == null ? 'Not stated' : fmtMoney(sheet.expectedAmount)}</span></div>
        <div class="rc-line"><span>Difference</span><span>${varianceHtml(v)}</span></div>
        ${sheet.notes ? `<div class="rc-line"><span>Notes</span><span>${esc(sheet.notes)}</span></div>` : ''}
        <div class="rc-line"><span>Counted by</span><span>${esc(sheet.countedBy)}</span></div>
        <div class="rc-line"><span>Witnessed by</span><span>${esc(sheet.witnessedBy || '—')}</span></div>
        <div class="rc-line"><span>Received by</span><span>${esc(sheet.receivedBy || '—')}</span></div>
        <div class="rc-line"><span>Verified by</span><span>${sheet.verifiedBy ? `${esc(names.get(sheet.verifiedBy) || '—')} · ${esc(iso(sheet.verifiedAt))}` : 'Not yet verified'}</span></div>
        <p class="rc-foot">Entered by ${esc(names.get(sheet.enteredBy) || '—')}. A cash count is a control record and posts nothing to the books.</p>
      </div>`;
    res.page({ title: `Cash count ${sheet.sheetNo}`, active: '/finance', noHeader: true, body });
  }));

  app.post('/finance/cash-counts/:id(\\d+)/verify', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const back = (req.body && req.body.return_to) === '/finance' ? '/finance' : `/finance/cash-counts/${id}`;
    const sheet = await db.cashCountSheet.findFirst({ where: { id } });
    if (!sheet) return res.status(404).send('Not found');
    if (sheet.status !== 'COUNTED') { flash(req, 'Only a counted sheet can be verified.'); return res.redirect(back); }
    if (sheet.enteredBy === res.locals.user.id) { flash(req, 'You cannot verify a cash count you entered yourself — ask another fund manager.'); return res.redirect(back); }
    const claim = await db.cashCountSheet.updateMany({
      where: { id, status: 'COUNTED' }, data: { status: 'VERIFIED', verifiedBy: res.locals.user.id, verifiedAt: new Date() },
    });
    if (!claim.count) { flash(req, 'This sheet was just updated by someone else.'); return res.redirect(back); }
    await logActivity(db, 'cash_count_verified', `Cash count ${sheet.sheetNo} verified (${fmtMoney(sheet.countedAmount)})`, `/finance/cash-counts/${id}`, res.locals.user.id);
    flash(req, 'Cash count verified.', 'success');
    res.redirect(back);
  }));

  app.post('/finance/cash-counts/:id(\\d+)/void', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const back = `/finance/cash-counts/${id}`;
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) { flash(req, 'A reason is required to void a cash count.'); return res.redirect(back); }
    const sheet = await db.cashCountSheet.findFirst({ where: { id } });
    if (!sheet) return res.status(404).send('Not found');
    if (sheet.status === 'VOIDED') { flash(req, 'This cash count is already voided.'); return res.redirect(back); }
    const claim = await db.cashCountSheet.updateMany({
      where: { id, status: sheet.status }, data: { status: 'VOIDED', voidReason: reason.slice(0, 300), voidedBy: res.locals.user.id, voidedAt: new Date() },
    });
    if (!claim.count) { flash(req, 'This sheet was just updated by someone else.'); return res.redirect(back); }
    await logActivity(db, 'cash_count_voided', `Cash count ${sheet.sheetNo} voided: ${reason.slice(0, 120)}`, back, res.locals.user.id);
    flash(req, 'Cash count voided.', 'success');
    res.redirect(back);
  }));

  // ---------------------------------------------------------------------------
  //  Bank deposits
  // ---------------------------------------------------------------------------
  app.get('/finance/deposits', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const user = res.locals.user;
    const canWrite = isFinanceWriter(user);
    const canVerify = isFundManager(user);
    const status = DEPOSIT_STATUSES.includes(req.query.status) ? req.query.status : '';
    const list = await db.bankDeposit.findMany({ where: status ? { status } : {}, orderBy: [{ depositDate: 'desc' }, { id: 'desc' }], take: 100 });
    const cashInHand = await ledger.assetBalance(db, churchId, ledger.ACC.CASH);
    const banked = await ledger.assetBalance(db, churchId, ledger.ACC.BANK_CLEARING);
    const awaiting = await db.bankDeposit.aggregate({ where: { status: { in: ['PENDING', 'DEPOSITED'] } }, _sum: { amount: true }, _count: { _all: true } });
    const counts = await deposits.itemCountsByDeposit(db, list.map((d) => d.id));

    let addForm = '';
    if (canWrite) {
      const items = await deposits.undepositedItems(db);
      // Hand-built rather than table(): that helper escapes header text, and
      // the first header is a "tick all" checkbox.
      const itemTable = items.length ? `<div style="max-height:24rem;overflow:auto"><table class="data-table">
        <thead><tr><th><input type="checkbox" data-tick-all aria-label="Tick every collection"></th><th>Date</th><th>Collection</th><th>Method</th><th>Amount</th></tr></thead>
        <tbody>${items.map((it) => `<tr>
          <td data-label="Bank"><input type="checkbox" name="item" value="${esc(it.key)}" data-amount="${it.amount}" aria-label="Bank ${esc(it.label)}"></td>
          <td data-label="Date">${esc(iso(it.date))}</td><td data-label="Collection">${esc(it.label)}</td>
          <td data-label="Method">${esc(it.method)}</td><td data-label="Amount">${fmtMoney(it.amount)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted-text">No recorded income, tithes, day-born collections or service offerings are waiting to be banked.</p>';
      addForm = `<details class="form-toggle" style="margin-bottom:1rem" ${req.query.new ? 'open' : ''}>
        <summary><strong>+ Record a deposit</strong></summary>
        <form class="form" method="post" action="/finance/deposits" data-deposit style="margin-top:0.75rem">
          <fieldset class="wide-cell"><legend>What is being banked</legend>
            <p class="muted-text">Tick the collections going to the bank: the amount becomes their total. For harvest, special offering or pledge money, leave nothing ticked and type the amount. Cash in hand on the books: <strong>${fmtMoney(cashInHand)}</strong>.</p>
            ${itemTable}
          </fieldset>
          <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required><small class="muted-text" data-ticked></small></label>
          <label>Deposit date<input type="date" name="depositDate" required value="${todayISO()}"></label>
          <label>Fund<select name="fundId">${await fundOptions(db, '', true)}</select></label>
          <label>Bank<input name="bankName" required placeholder="e.g. GCB Bank, Koforidua"></label>
          <label>Account number<input name="accountNumber" placeholder="As written on the slip"></label>
          <label>Slip number<input name="slipNo" placeholder="Leave blank if not yet back"></label>
          <label>Deposited by<input name="depositedBy" required placeholder="Who took the money to the bank"></label>
          <label class="wide">Collections included<input name="collectionsIncluded" placeholder="e.g. Sunday offering and tithes, 3 May"></label>
          <label class="wide">Notes<input name="notes"></label>
          <div class="actions"><button type="submit">Save deposit</button></div>
          <p class="muted-text wide-cell">A fund manager other than you verifies the deposit against the slip, which moves the money from cash in hand to the bank in the books.</p>
        </form>
      </details>${DEPOSIT_SCRIPT}`;
    }

    const voidForm = (d) => `<form method="post" action="/finance/deposits/${d.id}/void" style="display:inline" data-prompt="${d.status === 'VERIFIED' ? 'Reason for voiding this deposit? Its ledger entry will be reversed.' : 'Reason for voiding this deposit?'}" data-prompt-field="reason"><input type="hidden" name="reason"><button class="link" type="submit">Void</button></form>`;
    const rows = list.map((d) => {
      const actions = [];
      if (d.status === 'PENDING' && canWrite) {
        actions.push(`<form method="post" action="/finance/deposits/${d.id}/slip" style="display:inline" data-prompt="Slip number from the bank?" data-prompt-field="slipNo"><input type="hidden" name="slipNo"><button class="link" type="submit">Add slip</button></form>`);
      }
      if (d.status === 'DEPOSITED' && canVerify && d.recordedBy !== user.id) {
        actions.push(`<form method="post" action="/finance/deposits/${d.id}/verify" style="display:inline"><button class="link" type="submit">Verify</button></form>`);
      }
      if (d.status !== 'VOIDED' && canVerify) actions.push(voidForm(d));
      if (d.journalEntryId) actions.push(`<a class="link" href="/finance/journal/${d.journalEntryId}">Journal</a>`);
      const n = counts.get(d.id) || 0;
      return [
        esc(d.depositNo), esc(iso(d.depositDate)),
        esc(d.bankName) + (d.accountNumber ? `<br><span class="muted-text">${esc(d.accountNumber)}</span>` : ''),
        d.slipNo ? esc(d.slipNo) : '<span class="muted-text">Not yet</span>',
        `${esc(d.collectionsIncluded || (n ? '' : '—'))}${n ? `<br><span class="muted-text">${n} collection${n === 1 ? '' : 's'} banked</span>` : ''}`,
        esc(d.depositedBy) + (d.voidReason ? `<br><span class="negative">Void: ${esc(d.voidReason)}</span>` : ''),
        fmtMoney(d.amount), pill(d.status), actions.join(' · '),
      ];
    });
    const filter = `<form method="get" class="filter-bar" style="margin-bottom:1rem"><label>Status <select name="status" data-autosubmit>
        <option value="">All</option>${DEPOSIT_STATUSES.map((st) => `<option value="${st}" ${st === status ? 'selected' : ''}>${st.charAt(0) + st.slice(1).toLowerCase()}</option>`).join('')}
      </select></label><noscript><button type="submit">Filter</button></noscript></form>`;
    const body = `
      ${statsRow([
        { cls: cashInHand < 0 ? 'orange' : 'blue', icon: icon('wallet'), value: fmtMoney(cashInHand), label: 'Cash in hand (books)' },
        { cls: 'green', icon: icon('ledger'), value: fmtMoney(banked), label: 'Banked (verified deposits)' },
        { cls: awaiting._count._all ? 'orange' : 'blue', icon: icon('clock'), value: fmtMoney(awaiting._sum.amount || 0), label: `Awaiting verification (${awaiting._count._all})` },
      ])}
      ${addForm}
      ${filter}
      <section class="card">
        <div class="card-head"><h2>Deposits</h2><span class="meta">${list.length} shown</span></div>
        ${rows.length ? table(['Deposit', 'Date', 'Bank', 'Slip', 'Collections', 'Deposited by', 'Amount', 'Status', ''], rows)
          : `<p class="muted-text">No deposits recorded yet.${canWrite ? ' When money goes to the bank, open “Record a deposit” and enter the slip details.' : ''}</p>`}
      </section>`;
    res.page({ title: 'Finance · Bank Deposits', active: '/finance', noHeader: true, body: `${pageHero('Bank Deposits', 'Money taken to the bank by hand, checked against the slip by a second officer.')}${body}` });
  }));

  app.post('/finance/deposits', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const back = '/finance/deposits?new=1';
    if (!isValidDate(b.depositDate)) { flash(req, 'Enter a valid deposit date.'); return res.redirect(back); }
    const bankName = String(b.bankName || '').trim();
    if (!bankName) { flash(req, 'Enter the bank.'); return res.redirect(back); }
    const depositedBy = String(b.depositedBy || '').trim();
    if (!depositedBy) { flash(req, 'Name the person who took the money to the bank.'); return res.redirect(back); }
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) { flash(req, 'Fund not found.'); return res.redirect(back); }
    const ids = deposits.parseItemKeys(b.item);
    const ticked = deposits.itemCount(ids);
    if (!ticked && !isMoneyPositive(b.amount)) { flash(req, 'Tick the collections being banked, or enter an amount greater than 0.'); return res.redirect(back); }
    const slipNo = String(b.slipNo || '').trim() || null;

    let deposit;
    try {
      deposit = await db.$transaction(async (tx) => {
        const created = await createNumbered(tx, res.locals.churchId, tx.bankDeposit, 'depositNo', 'DEP', b.depositDate.slice(0, 4), {
          depositDate: new Date(b.depositDate), amount: ticked ? 0 : Math.round(Number(b.amount) * 100) / 100,
          bankName, accountNumber: String(b.accountNumber || '').trim() || null, slipNo, depositedBy,
          collectionsIncluded: String(b.collectionsIncluded || '').trim() || null, fundId: fundCheck.fundId,
          notes: String(b.notes || '').trim() || null, status: slipNo ? 'DEPOSITED' : 'PENDING', recordedBy: res.locals.user.id,
        });
        if (!ticked) return created;
        const total = await deposits.attachItems(tx, created.id, ids);
        return tx.bankDeposit.update({ where: { id: created.id }, data: { amount: total } });
      }, { timeout: 15000, maxWait: 15000 });
    } catch (e) {
      if (!/banked by someone else/.test(e.message)) throw e;
      flash(req, e.message);
      return res.redirect(back);
    }

    await logActivity(db, 'deposit_recorded',
      `Deposit ${deposit.depositNo} of ${fmtMoney(deposit.amount)} to ${bankName}${ticked ? ` (${ticked} collection${ticked === 1 ? '' : 's'})` : ''}`,
      '/finance/deposits', res.locals.user.id);
    flash(req, slipNo ? `Deposit ${deposit.depositNo} recorded. It now awaits verification.`
      : `Deposit ${deposit.depositNo} saved as pending. Add the slip number when it comes back from the bank.`, 'success');
    res.redirect('/finance/deposits');
  }));

  app.post('/finance/deposits/:id(\\d+)/slip', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const slipNo = String((req.body && req.body.slipNo) || '').trim();
    if (!slipNo) { flash(req, 'Enter the slip number from the bank.'); return res.redirect('/finance/deposits'); }
    const deposit = await db.bankDeposit.findFirst({ where: { id } });
    if (!deposit) return res.status(404).send('Not found');
    const claim = await db.bankDeposit.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'DEPOSITED', slipNo: slipNo.slice(0, 100) } });
    if (!claim.count) { flash(req, 'Only a pending deposit takes a slip number.'); return res.redirect('/finance/deposits'); }
    await logActivity(db, 'deposit_slip_recorded', `Slip ${slipNo} recorded for deposit ${deposit.depositNo}`, '/finance/deposits', res.locals.user.id);
    flash(req, 'Slip number recorded. The deposit now awaits verification.', 'success');
    res.redirect('/finance/deposits');
  }));

  app.post('/finance/deposits/:id(\\d+)/verify', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const back = '/finance/deposits';
    const deposit = await db.bankDeposit.findFirst({ where: { id } });
    if (!deposit) return res.status(404).send('Not found');
    if (deposit.status !== 'DEPOSITED') { flash(req, 'Only a deposit with a slip number can be verified.'); return res.redirect(back); }
    if (deposit.recordedBy === res.locals.user.id) { flash(req, 'You cannot verify a deposit you recorded yourself — ask another fund manager.'); return res.redirect(back); }
    const date = iso(deposit.depositDate);
    if (await refuseIfPeriodLocked(req, res, db, date, back)) return;

    try {
      await db.$transaction(async (tx) => {
        const claim = await tx.bankDeposit.updateMany({
          where: { id, status: 'DEPOSITED' }, data: { status: 'VERIFIED', verifiedBy: res.locals.user.id, verifiedAt: new Date() },
        });
        if (!claim.count) throw new Error('This deposit was just verified by someone else.');
        const entryId = await ledger.postJournal(tx, churchId, {
          date, memo: `Deposit ${deposit.depositNo} to ${deposit.bankName}${deposit.slipNo ? ` (slip ${deposit.slipNo})` : ''}`,
          sourceType: 'BANK_DEPOSIT', sourceId: deposit.id, createdBy: res.locals.user.id,
          lines: [
            { accountCode: ledger.ACC.BANK_CLEARING, debit: deposit.amount, fundId: deposit.fundId },
            { accountCode: ledger.ACC.CASH, credit: deposit.amount, fundId: deposit.fundId },
          ],
        });
        // Checked AFTER posting, inside the transaction: postJournal has taken
        // the church's journal lock, so two deposits verified at once cannot
        // both pass on the same cash. Banking more than the books say is in
        // hand means income was never recorded; posting anyway would drive
        // cash in hand below zero and hide that.
        const after = await ledger.assetBalance(tx, churchId, ledger.ACC.CASH);
        if (toPesewas(after) < 0) {
          throw new Error(`This deposit (${fmtMoney(deposit.amount)}) is more than the cash in hand on the books (${fmtMoney(after + deposit.amount)}). Record the collections it came from first.`);
        }
        await tx.bankDeposit.update({ where: { id }, data: { journalEntryId: entryId } });
      }, { timeout: 15000, maxWait: 15000 });
    } catch (e) {
      if (!/just verified|more than the cash in hand|period is locked/.test(e.message)) throw e;
      flash(req, e.message);
      return res.redirect(back);
    }
    await logActivity(db, 'deposit_verified', `Deposit ${deposit.depositNo} of ${fmtMoney(deposit.amount)} verified and posted`, back, res.locals.user.id);
    flash(req, 'Deposit verified and posted: cash in hand reduced, bank increased.', 'success');
    res.redirect(back);
  }));

  app.post('/finance/deposits/:id(\\d+)/void', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const back = '/finance/deposits';
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) { flash(req, 'A reason is required to void a deposit.'); return res.redirect(back); }
    const deposit = await db.bankDeposit.findFirst({ where: { id } });
    if (!deposit) return res.status(404).send('Not found');
    if (deposit.status === 'VOIDED') { flash(req, 'This deposit is already voided.'); return res.redirect(back); }

    // Marked VOIDED first: assertNotBanked lets a deposit's own entry be
    // reversed only once the deposit is void.
    const claim = await db.bankDeposit.updateMany({
      where: { id, status: deposit.status }, data: { status: 'VOIDED', voidReason: reason.slice(0, 300), voidedBy: res.locals.user.id, voidedAt: new Date() },
    });
    if (!claim.count) { flash(req, 'This deposit was just updated by someone else.'); return res.redirect(back); }
    if (deposit.journalEntryId) {
      try {
        await ledger.reverseJournal(db, churchId, deposit.journalEntryId, `Deposit ${deposit.depositNo} voided: ${reason}`, res.locals.user.id);
      } catch (e) {
        await db.bankDeposit.updateMany({ where: { id, status: 'VOIDED' }, data: { status: deposit.status, voidReason: null, voidedBy: null, voidedAt: null } });
        if (!/period is locked|already reversed/.test(e.message)) throw e;
        flash(req, e.message);
        return res.redirect(back);
      }
    }
    await deposits.releaseItems(db, id);
    await logActivity(db, 'deposit_voided', `Deposit ${deposit.depositNo} voided: ${reason.slice(0, 120)}`, back, res.locals.user.id);
    flash(req, deposit.journalEntryId ? 'Deposit voided and its ledger entry reversed.' : 'Deposit voided.', 'success');
    res.redirect(back);
  }));
}

module.exports = { register };
