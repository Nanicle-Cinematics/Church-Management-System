'use strict';
// The collections a bank deposit takes to the bank.
//
// Four kinds of collection post to Cash in hand (1000) when recorded and can
// be ticked on a deposit: general income, tithes, standalone day-born
// collections and service offerings. A ticked record carries the deposit's id
// until that deposit is voided; while it does, the record cannot be reversed
// (see assertNotBanked in lib/ledger-pg.js). Special offerings, harvests and
// pledge payments are banked as a typed amount instead.

const { sumMoney } = require('./cash-count');

const OPEN = { deletedAt: null, depositId: null, journalEntryId: { not: null } };

const KINDS = {
  INCOME: {
    model: 'incomeRecord',
    find: (db, take) => db.incomeRecord.findMany({ where: OPEN, orderBy: [{ transactionDate: 'asc' }, { id: 'asc' }], take }),
    date: (r) => r.transactionDate,
    amount: (r) => r.amount,
    label: (r) => `Income · ${r.receivedFrom || 'Anonymous'}${r.receiptNumber ? ` (${r.receiptNumber})` : ''}`,
    method: (r) => r.paymentMethod || 'Cash',
  },
  TITHE: {
    model: 'tithe',
    find: (db, take) => db.tithe.findMany({ where: OPEN, orderBy: [{ titheDate: 'asc' }, { id: 'asc' }], take, include: { member: { select: { firstName: true, lastName: true } } } }),
    date: (r) => r.titheDate,
    amount: (r) => r.amount,
    label: (r) => `Tithe · ${r.member ? `${r.member.firstName} ${r.member.lastName}` : 'Member'}`,
    method: (r) => r.method || 'Cash',
  },
  DAYBORN: {
    model: 'dayBornCollection',
    find: (db, take) => db.dayBornCollection.findMany({ where: OPEN, orderBy: [{ collectionDate: 'asc' }, { id: 'asc' }], take }),
    date: (r) => r.collectionDate,
    amount: (r) => r.amount,
    label: (r) => `Day-born · ${r.dayBorn.charAt(0)}${r.dayBorn.slice(1).toLowerCase()}`,
    method: (r) => r.paymentMethod || 'Cash',
  },
  SERVICE: {
    model: 'service',
    find: (db, take) => db.service.findMany({ where: OPEN, orderBy: [{ serviceDate: 'asc' }, { id: 'asc' }], take, include: { serviceType: { select: { typeName: true } } } }),
    date: (r) => r.serviceDate,
    amount: (r) => r.totalAmount,
    label: (r) => `Service · ${r.serviceType ? r.serviceType.typeName : 'Offering'}`,
    method: () => 'Cash',
  },
};
const KIND_NAMES = Object.keys(KINDS);

/** Posted collections on no deposit yet, oldest first: what cash in hand is made of. */
async function undepositedItems(db, take = 300) {
  const items = [];
  for (const kind of KIND_NAMES) {
    const k = KINDS[kind];
    for (const r of await k.find(db, take)) {
      items.push({ key: `${kind}:${r.id}`, kind, id: r.id, date: k.date(r), label: k.label(r), method: k.method(r), amount: Number(k.amount(r) || 0) });
    }
  }
  return items.sort((a, b) => a.date - b.date || a.key.localeCompare(b.key));
}

/** Read "INCOME:12" checkbox values into ids per kind; anything else is ignored. */
function parseItemKeys(values) {
  const out = Object.fromEntries(KIND_NAMES.map((k) => [k, []]));
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  for (const v of list) {
    const [kind, raw] = String(v).split(':');
    const id = Number(raw);
    if (KINDS[kind] && Number.isInteger(id) && id > 0 && !out[kind].includes(id)) out[kind].push(id);
  }
  return out;
}

const itemCount = (ids) => KIND_NAMES.reduce((n, k) => n + ids[k].length, 0);

/**
 * Attach the ticked collections to a deposit, inside the caller's
 * transaction, and return their total. The amount comes from the database,
 * never the form. Throws if any of them was archived, is unposted, or is
 * already on another deposit, so two officers cannot bank the same money.
 */
async function attachItems(tx, depositId, ids) {
  const wanted = itemCount(ids);
  const amounts = [];
  let attached = 0;
  for (const kind of KIND_NAMES) {
    if (!ids[kind].length) continue;
    const k = KINDS[kind];
    const rows = await tx[k.model].findMany({ where: { id: { in: ids[kind] }, ...OPEN } });
    amounts.push(...rows.map(k.amount));
    const res = await tx[k.model].updateMany({ where: { id: { in: ids[kind] }, ...OPEN }, data: { depositId } });
    attached += res.count;
  }
  if (amounts.length !== wanted || attached !== wanted) {
    throw new Error('Some of the ticked collections were banked by someone else or have been reversed. Refresh and tick them again.');
  }
  return sumMoney(amounts);
}

/** The deposit was voided: its collections are unbanked again. */
async function releaseItems(db, depositId) {
  for (const kind of KIND_NAMES) {
    await db[KINDS[kind].model].updateMany({ where: { depositId }, data: { depositId: null } });
  }
}

/** How many collections each deposit carries, for the deposits list. */
async function itemCountsByDeposit(db, depositIds) {
  const counts = new Map();
  if (!depositIds.length) return counts;
  for (const kind of KIND_NAMES) {
    const rows = await db[KINDS[kind].model].groupBy({ by: ['depositId'], where: { depositId: { in: depositIds } }, _count: { _all: true } });
    for (const r of rows) counts.set(r.depositId, (counts.get(r.depositId) || 0) + r._count._all);
  }
  return counts;
}

/**
 * Next per-church, per-year document number, e.g. CC-2026-0001, allocated
 * inside the caller's transaction. Serialised with a transaction-scoped
 * advisory lock rather than "catch the unique clash and retry": PostgreSQL
 * aborts the whole transaction on the first clash, so a retry inside it
 * cannot work (the same reason lib/ledger-pg.js locks its journal sequence).
 */
async function nextDocNo(tx, churchId, delegate, field, prefix, year) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${prefix + ':' + churchId + ':' + year}, 0))::text AS locked`;
  const start = `${prefix}-${year}-`;
  const last = await delegate.findFirst({ where: { [field]: { startsWith: start } }, orderBy: { [field]: 'desc' }, select: { [field]: true } });
  const next = last ? Number(String(last[field]).slice(start.length)) + 1 : 1;
  return `${start}${String(next).padStart(4, '0')}`;
}

module.exports = { KIND_NAMES, undepositedItems, parseItemKeys, itemCount, attachItems, releaseItems, itemCountsByDeposit, nextDocNo };
