'use strict';
// The usual answers behind the drop-downs that replaced typed text (lib/choice.js).
// A church can always choose "Other…" and type its own, so these are suggestions, not limits.

// Income subcategories follow the income category (routes-pg-html/finance.js INCOME_CATEGORIES).
const INCOME_SUBCATEGORIES = {
  donation: ['Thanksgiving', 'Building project', 'Missions and evangelism', 'Welfare', 'Special appeal', 'Gift in kind'],
  event: ['Harvest', 'Concert or programme', 'Fundraising dinner', 'Conference or retreat', 'Bazaar or sales'],
  rent: ['Hall rental', 'Chairs and canopy hire', 'Sound system hire', 'Land or property rent'],
  bookshop: ['Bibles and hymn books', 'Books and materials', 'Stationery', 'Church wear'],
  welfare_refund: ['Loan repayment', 'Advance returned', 'Overpayment returned'],
  other: ['Interest earned', 'Sale of items', 'Refund received', 'Miscellaneous'],
};
const incomeSubcategoryOptions = () => Object.entries(INCOME_SUBCATEGORIES)
  .flatMap(([group, list]) => list.map((value) => ({ value, label: value, group })));

const ALLOWANCE_ROLES = ['Caretaker', 'Organist', 'Choirmaster', 'Instrumentalist or drummer', 'Sound engineer', 'Security', 'Cleaner', 'Church secretary', 'Interpreter', 'Driver', 'Usher coordinator'];

const BANKS = ['GCB Bank', 'Ecobank Ghana', 'Stanbic Bank', 'Absa Bank Ghana', 'Fidelity Bank', 'CalBank', 'Access Bank', 'Zenith Bank', 'Standard Chartered Bank', 'Republic Bank', 'Agricultural Development Bank (ADB)', 'Prudential Bank', 'United Bank for Africa (UBA)', 'Consolidated Bank Ghana (CBG)', 'First National Bank', 'GTBank', 'Bank of Africa'];

const DEFAULT_SERVICES = ['Sunday Service', 'Wednesday Service', 'Friday Service', 'Wedding Service', 'Funeral Service'];

/** The church's own service types (the ones it records offerings against), by name. */
async function serviceNames(db) {
  const types = await db.serviceType.findMany({ where: { isActive: true }, orderBy: { typeName: 'asc' }, select: { typeName: true } });
  return types.length ? types.map((t) => t.typeName) : DEFAULT_SERVICES;
}

module.exports = { INCOME_SUBCATEGORIES, incomeSubcategoryOptions, ALLOWANCE_ROLES, BANKS, serviceNames };
