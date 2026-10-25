'use strict';
// The Help page's sample records: each belongs to a real help section, uses invented data, and is
// inert (nothing in it can be followed, focused or submitted).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { exampleFor, EXAMPLES } = require('../lib/help-examples');

test('every example belongs to a help section, is framed as made-up data, and cannot be interacted with', () => {
  const help = fs.readFileSync(path.join(__dirname, '..', 'routes-pg-html', 'help.js'), 'utf8');
  for (const id of Object.keys(EXAMPLES)) {
    assert.ok(help.includes(`'${id}'`), `${id} is a section on the Help page`);
    const html = exampleFor(id);
    assert.match(html, /<figure class="help-example"/);
    assert.match(html, /made-up sample data/);
    assert.match(html, /class="help-example-body" inert aria-hidden="true"/);
    assert.ok(!/<script|\son[a-z]+=|javascript:| href="| action="| formaction="/i.test(html), `${id}: no script, handler, link or form action`);
  }
  assert.strictEqual(exampleFor('help-access'), '', 'a section without an example gets none');
});

test('the examples use invented people and amounts only', () => {
  const all = Object.keys(EXAMPLES).map(exampleFor).join(' ');
  assert.match(all, /Ama Sample/);
  assert.match(all, /MBR-0001/);
  assert.doesNotMatch(all, /@[a-z0-9-]+\.[a-z]{2,}/i, 'no email addresses');
});
