'use strict';
// CSV download helpers, shared by every export (finance registers, members).

// Spreadsheet formula injection: a cell that starts with = + - @ (or a
// tab/CR) is executed by Excel/Sheets. Names, descriptions and "received
// from" are free text, so prefix an apostrophe. Plain numbers such as -50.00
// are left alone.
function csvEscape(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, filename, header, rows) {
  const lines = [header.map(csvEscape).join(',')].concat(rows.map((r) => r.map(csvEscape).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\r\n'));
}

module.exports = { csvEscape, sendCsv };
