'use strict';
// Help & Guide (/help): a page-by-page guide for every role. It used to exist
// in the single-church app and was lost in the multi-tenant rewrite, leaving
// the sidebar's Help link on Express's "Cannot GET /help".
//
// Sections follow what the reader can open (lib/access.js): Finance,
// Communications and Reports only with finance access, Users & Settings only
// for admins. "Your access" spells out the reader's own role, in the same
// words as Users & Roles.

const { esc } = require('../lib/format');
const { pageHero } = require('../lib/views');
const { hasFinanceAccess } = require('../lib/access');

const ROLE_LABELS = { ADMIN: 'Administrator', EDITOR: 'Editor', VIEWER: 'Viewer' };
const ROLE_MEANING = {
  ADMIN: 'You manage everything, including users and settings.',
  EDITOR: 'You add and edit records, but cannot delete, export or send messages.',
  VIEWER: 'You can read records but not change them.',
};
const FINANCE_LABELS = { NONE: 'No finance access', CASHIER: 'Cashier', TREASURER: 'Steward / Treasurer', AUDITOR: 'Auditor', FINANCE_ADMIN: 'Finance admin' };
const FINANCE_MEANING = {
  NONE: 'Finance, Communications and Reports are hidden, and Events, the Preaching Plan and Inventory are read-only.',
  CASHIER: 'You record income and expenses.',
  TREASURER: 'You record and review accounting.',
  AUDITOR: 'You review accounting only.',
  FINANCE_ADMIN: 'You record and review accounting.',
};

function section(id, title, summary, steps) {
  return `
    <section class="card help-card" id="${id}">
      <div class="card-head"><h2>${esc(title)}</h2></div>
      <p>${summary}</p>
      ${steps && steps.length ? `<ol class="help-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : ''}
    </section>`;
}

function helpPage(user) {
  const isAdmin = user.role === 'ADMIN';
  const finance = hasFinanceAccess(user);
  const financeRole = isAdmin ? null : (user.financeRole || 'NONE');

  const sections = [
    ['help-access', 'Your access',
      `You are signed in as <strong>${esc(ROLE_LABELS[user.role] || 'Viewer')}</strong>${financeRole ? ` with <strong>${esc(FINANCE_LABELS[financeRole] || financeRole)}</strong>` : ''}. ${ROLE_MEANING[user.role] || ROLE_MEANING.VIEWER}${financeRole ? ` ${FINANCE_MEANING[financeRole] || ''}` : ''}`,
      [
        'The menu only lists the pages you can open. Buttons for things your role cannot do are hidden or refused with an explanation.',
        isAdmin
          ? 'You change other people’s access on <a href="/users">Users &amp; Roles</a>.'
          : 'If you need more access, ask an administrator of your church to change your role on Users &amp; Roles.',
      ]],
    ['help-around', 'Getting around',
      'Every section is in the sidebar. On a phone, the main sections are in the tab bar at the bottom and the rest are under <strong>More</strong>.',
      [
        '<strong>Search</strong> (<kbd>Ctrl K</kbd>, or <kbd>⌘ K</kbd> on a Mac) jumps to a page or an action, or finds a member or an event by name.',
        '<strong>New</strong> starts the things your role can create, such as a new member.',
        'The moon / sun button switches between light and dark. Your choice is kept on this device.',
        '<a href="/profile">Profile</a> shows your account and sets up two-factor sign-in.',
      ]],
    ['help-install', 'Install the app',
      'Church Manager can be installed on a phone or computer, so it opens from the home screen, dock or Start menu like any other app.',
      [
        'Click <strong>Install app</strong> in the sidebar (on a phone, under <strong>More</strong>). It only appears where the browser can install it.',
        'On an iPhone or iPad, open the site in Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.',
        'You sign in once inside the installed app.',
      ]],
    ['help-members', 'Members',
      'The directory of everyone in the church. Search by name, phone or email, filter the list, and open anyone’s profile.',
      [
        'Administrators and Editors add and edit members, including their photos.',
        isAdmin ? 'Administrators can also import members from a CSV or Excel file, export the list, and archive members.' : null,
      ]],
    ['help-attendance', 'Attendance', 'Who came to each service and the headcounts, with trends over time.', null],
    ['help-events', 'Events',
      'Services, meetings and programmes, with check-ins (including by QR code) and RSVPs.',
      [finance ? null : 'Without finance access, Events are read-only, though Editors can still check people in and record RSVPs.']],
    ['help-groups', 'Bible Classes & Organizations', 'Small groups and ministries, each with its leader and members.', null],
    ['help-preaching', 'Preaching Plan', 'Who preaches when, with the next assignment at the top.', null],
    ['help-inventory', 'Inventory', 'The church’s property and equipment.', null],
    finance && ['help-finance', 'Finance',
      'Income, tithes, expenses, funds and monthly allowances, kept as a ledger.',
      [
        'Expenses are submitted for approval, and every payout needs a second approver.',
        'Cashiers record income and expenses; Treasurers record and review; Auditors review only; Finance admins do both.',
      ]],
    finance && ['help-communications', 'Communications',
      'Announcements, and SMS or email broadcasts to members.',
      ['Only administrators send broadcasts.']],
    finance && ['help-reports', 'Reports', 'Summaries of members, attendance and finance for a date range, ready to print or save as PDF.', null],
    isAdmin && ['help-admin', 'Users & Settings',
      'For administrators only.',
      [
        '<a href="/users">Users &amp; Roles</a>: add staff, set each person’s role and finance role, change how they sign in, and reset passwords.',
        '<a href="/settings">Settings</a>: the church’s details, such as its name and logo. The logo also becomes the app’s icon when someone installs it.',
      ]],
  ].filter(Boolean).map(([id, title, summary, steps]) => [id, title, summary, (steps || []).filter(Boolean)]);

  return `
    ${pageHero('Help & Guide', 'How to use Church Manager, page by page.')}
    <nav class="card help-toc" aria-label="On this page">
      <div class="card-head"><h2>On this page</h2></div>
      <ul class="help-toc-list">${sections.map(([id, title]) => `<li><a href="#${id}">${esc(title)}</a></li>`).join('')}</ul>
    </nav>
    ${sections.map(([id, title, summary, steps]) => section(id, title, summary, steps)).join('')}`;
}

function register(app) {
  app.get('/help', (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    res.page({ title: 'Help & Guide', active: '/help', noHeader: true, body: helpPage(res.locals.user) });
  });
}

module.exports = { register };
