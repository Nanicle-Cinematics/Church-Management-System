'use strict';
// "Meeting days" for Bible classes and organizations: a day picked from a
// list, with an optional time, stored in the existing meets_on text column
// as "Sunday" or "Sunday, 4:00 PM".
//
// meets_on used to be free text ("Saturday 5pm"). A value that is not one of
// the days is kept as it is until someone picks a day: the dropdown shows it
// as the current choice, so saving another field never wipes it.

const { esc, DAYS_OF_WEEK } = require('./format');

const KEEP = '__keep__';

/** { day, time } from a stored value; day is null when it is old free text. */
function parseMeetsOn(value) {
  const m = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)(?:, (\d{1,2}):(\d{2}) (AM|PM))?$/.exec(String(value || ''));
  if (!m) return { day: null, time: '' };
  if (!m[2]) return { day: m[1], time: '' };
  let h = Number(m[2]) % 12;
  if (m[4] === 'PM') h += 12;
  return { day: m[1], time: `${String(h).padStart(2, '0')}:${m[3]}` };
}

/** The value to store from the form's meetsDay / meetsTime; `current` when kept. */
function meetsOnFromForm(body, current = null) {
  const day = body && body.meetsDay;
  if (day === KEEP) return current;
  if (!DAYS_OF_WEEK.includes(day)) return null;
  const t = /^(\d{2}):(\d{2})$/.exec(String(body.meetsTime || ''));
  if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) return day;
  const h = Number(t[1]);
  return `${day}, ${h % 12 || 12}:${t[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The day dropdown and time box, for a form or a row's inline form. */
function meetingDaysFields(current, { inline = false } = {}) {
  const { day, time } = parseMeetsOn(current);
  const legacy = current && !day ? `<option value="${KEEP}" selected>${esc(current)}</option>` : '';
  const options = `<option value="">— Not set —</option>${legacy}${DAYS_OF_WEEK.map((d) => `<option value="${d}" ${d === day ? 'selected' : ''}>${d}</option>`).join('')}`;
  if (inline) {
    return `<select name="meetsDay" aria-label="Meeting days">${options}</select>
      <input type="time" name="meetsTime" value="${esc(time)}" aria-label="Meeting time">`;
  }
  return `<label>Meeting days<select name="meetsDay">${options}</select></label>
    <label>Time <span class="muted-text">(optional)</span><input type="time" name="meetsTime" value="${esc(time)}"></label>`;
}

module.exports = { parseMeetsOn, meetsOnFromForm, meetingDaysFields };
