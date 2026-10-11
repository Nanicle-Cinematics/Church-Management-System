'use strict';
// The product mark, as inline SVG so the public pages need no image request
// (the default logo.png is ~840 KB). Colours come from the editorial tokens in
// public/editorial.css: the square takes the accent, the cross the paper colour.
const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5" fill="currentColor"/><path d="M10.5 5h3v5.5H19v3h-5.5V19h-3v-5.5H5v-3h5.5z" fill="var(--ed-paper)"/></svg>';
module.exports = { MARK };
