'use strict';
// Sample records for the Help page: each major feature shown with made-up data, drawn by the
// same renderers the real pages use, so an example always looks like the app does today.
// Every name, number and amount here is invented. The frame says so, and `inert` means
// nothing inside it can be clicked, focused or submitted (and links and form actions are
// renamed to data-* so even a browser without `inert` has nothing to follow).

const { esc, fmtMoney } = require('./format');
const { table, statsRow, listCard, memberAvatar } = require('./views');
const { icon } = require('./icons');
const { chip, entryCard, promptHtml } = require('./almanac-ui');

const SAMPLE_WEEK = new Date(Date.UTC(2026, 10, 1)); // a Sunday: 1 November 2026

const status = (label, cls = '') => `<span class="pill${cls ? ` pill-${cls}` : ''}">${esc(label)}</span>`;

const members = () => listCard({
  title: 'Members', count: 4, countLabel: 'people',
  inner: table(['Name', 'Member ID', 'Status', 'Phone'], [
    ['Ama Sample', 'MBR-0001', status('Member', 'member'), '024 000 0001'],
    ['Kofi Example', 'MBR-0002', status('Member', 'member'), '020 000 0002'],
    ['Efua Demo', 'MBR-0003', status('Regular', 'regular'), '055 000 0003'],
    ['Yaw Placeholder', 'MBR-0004', status('Visitor', 'visitor'), '024 000 0004'],
  ].map(([name, id, st, phone]) => [`<span class="help-person">${memberAvatar({ first_name: name.split(' ')[0], last_name: name.split(' ')[1] })}<span>${esc(name)}</span></span>`, id, st, phone])),
});

const attendance = () => `${statsRow([
  { cls: 'green', icon: icon('attendance'), value: '142', label: 'Check-ins this week' },
  { cls: 'blue', icon: icon('members'), value: '138', label: 'Weekly average' },
])}${listCard({
  title: 'Recent services', count: 3, countLabel: 'services',
  inner: table(['Date', 'Service', 'Present'], [
    ['Sun 25 Oct', 'First Service', '96'], ['Sun 25 Oct', 'Second Service (Twi)', '46'], ['Wed 21 Oct', 'Midweek Bible Study', '38'],
  ]),
})}`;

const events = () => listCard({
  title: 'Upcoming events', count: 3, countLabel: 'events',
  inner: table(['When', 'Event', 'Where', 'RSVPs'], [
    ['Sun 1 Nov, 9:00', 'All Saints Sunday Service', 'Main sanctuary', '64'],
    ['Wed 4 Nov, 18:00', 'Midweek Bible Study', 'Chapel hall', '22'],
    ['Sat 7 Nov, 10:00', 'Youth Fellowship Rally', 'Church grounds', '31'],
  ]),
});

const groups = () => listCard({
  title: 'Bible classes', count: 3, countLabel: 'classes',
  inner: table(['Class', 'Leader', 'Members'], [['Class 1', 'Ama Sample', '14'], ['Class 2', 'Kofi Example', '12'], ['Women’s Fellowship', 'Efua Demo', '27']]),
});

const sampleEntry = () => ({
  id: 0, serviceDate: SAMPLE_WEEK, serviceLabel: '', title: 'All Saints Sunday', colour: 'WHITE', theme: 'Hope in the saints',
  oldTestament: 'Revelation 7:9-17', psalm: 'Psalm 34:1-10', epistle: '1 John 3:1-3', gospel: 'Matthew 5:1-12', hymns: ['56', '112', '203', '340/341'], teachingService: false, notes: null,
});

const preaching = () => listCard({
  title: 'Preaching Plan', count: 3, countLabel: 'appointments',
  inner: table(['Date', 'Preacher', 'Service', 'Almanac'], [
    ['Sun 1 Nov', '<b>M1</b> · Rev. Kofi Mensah', '9:00 AM', `${chip('WHITE')} <small>All Saints Sunday</small>`],
    ['Sun 8 Nov', '<b>S</b> · Rev. Ama Boateng', '9:00 AM', `${chip('GREEN')} <small>Twenty-Fourth Sunday</small>`],
    ['Sun 15 Nov', '<b>7</b> · Mr. Yaw Owusu', '9:00 AM', `${chip('GREEN')} <small>Twenty-Fifth Sunday</small>`],
  ], { keyCols: 3 }),
});

const almanac = () => `<ul class="almanac-list">${entryCard(sampleEntry(), { now: true, preachers: ['M1 · Rev. Kofi Mensah'] })}</ul>
  <p class="help-example-note">What an administrator is asked, on every page, until a colour is chosen:</p>
  ${promptHtml({ ...sampleEntry(), colour: 'GREEN', title: 'Twenty-Fourth Sunday' }, '/')}`;

const inventory = () => listCard({
  title: 'Inventory', count: 3, countLabel: 'items',
  inner: table(['Item', 'Quantity', 'Condition', 'Location'], [['Plastic chairs', '120', 'Good', 'Main hall'], ['Keyboard', '1', 'Needs repair', 'Choir room'], ['Public address system', '1', 'Good', 'Main sanctuary']]),
});

const finance = () => `${statsRow([
  { cls: 'green', icon: icon('finance'), value: esc(fmtMoney(5200)), label: 'Income this month' },
  { cls: 'gold', icon: icon('alert'), value: esc(fmtMoney(350)), label: 'Expenses waiting' },
])}${listCard({
  title: 'Recent entries', count: 3, countLabel: 'entries',
  inner: table(['Date', 'Description', 'Fund', 'Amount', 'Status'], [
    ['25 Oct', 'Sunday offering (1st Service)', 'General Fund', esc(fmtMoney(1842.5)), status('Posted', 'fulfilled')],
    ['24 Oct', 'Tithes', 'General Fund', esc(fmtMoney(2100)), status('Posted', 'fulfilled')],
    ['23 Oct', 'Generator fuel', 'Building Fund', esc(fmtMoney(350)), status('Waiting for approval', 'pending')],
  ], { keyCols: 3 }),
})}`;

const communications = () => `<div class="card"><div class="card-head"><h2>New message</h2></div>
  <p><b>To:</b> All members (212) · <b>By:</b> SMS</p>
  <p class="help-sample-sms">Good morning. This Sunday is All Saints Sunday. Service begins at 9:00 AM. God bless you.</p></div>`;

const reports = () => `${statsRow([
  { cls: 'blue', icon: icon('members'), value: '212', label: 'Members' },
  { cls: 'green', icon: icon('attendance'), value: '138', label: 'Average attendance' },
  { cls: 'gold', icon: icon('finance'), value: esc(fmtMoney(21400)), label: 'Income, October' },
])}`;

const admin = () => listCard({
  title: 'Users & Roles', count: 3, countLabel: 'users',
  inner: table(['Name', 'Role', 'Finance role'], [['Ama Sample', 'Administrator', '—'], ['Kofi Example', 'Editor', 'Cashier'], ['Efua Demo', 'Viewer', '—']]),
});

const EXAMPLES = {
  'help-members': ['Members', members], 'help-attendance': ['Attendance', attendance], 'help-events': ['Events', events],
  'help-groups': ['Bible classes', groups], 'help-preaching': ['The Preaching Plan', preaching], 'help-almanac': ['The Almanac and colour prompt', almanac],
  'help-inventory': ['Inventory', inventory], 'help-finance': ['Finance', finance], 'help-communications': ['Communications', communications],
  'help-reports': ['Reports', reports], 'help-admin': ['Users & Roles', admin],
};

/** The framed example for a help section, or '' when it has none. */
function exampleFor(id) {
  const ex = EXAMPLES[id];
  if (!ex) return '';
  return `<figure class="help-example" role="group" aria-label="Example: ${esc(ex[0])}, with sample data">
    <figcaption><span class="help-example-tag">Example</span> ${esc(ex[0])}, with made-up sample data. Your own records appear in the real page.</figcaption>
    <div class="help-example-body" inert aria-hidden="true">${ex[1]().replace(/ (href|formaction|action)="/g, ' data-$1="')}</div>
  </figure>`;
}

module.exports = { exampleFor, EXAMPLES };
