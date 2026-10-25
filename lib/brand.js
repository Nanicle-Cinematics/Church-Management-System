'use strict';
// The product mark, as inline SVG so the public pages need no image request
// (the default logo.png is ~840 KB). MARK is the full square, coloured by
// currentColor with a white cross; MARK_CROSS is just the cross, for placing
// on a tile that already supplies the square (the Precision public pages).
const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5" fill="currentColor"/><path d="M10.5 5h3v5.5H19v3h-5.5V19h-3v-5.5H5v-3h5.5z" fill="#fff"/></svg>';
const MARK_CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 3h3v6.5H20v3h-6.5V21h-3v-8.5H4v-3h6.5z" fill="currentColor"/></svg>';
module.exports = { MARK, MARK_CROSS };
