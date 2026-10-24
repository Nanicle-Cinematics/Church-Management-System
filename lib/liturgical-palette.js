'use strict';
// The liturgical colours the app can wear, and exactly how each one looks.
// public/liturgical.css is GENERATED from this file (node scripts/build-liturgical-css.js);
// test/liturgical.test.js fails if the two drift apart, and checks that every
// colour is readable (button text, links and the dashboard banner) in light and dark.
//
// Each look sets the app's accent family (the same five variables the base theme
// uses) and three gradient stops (g1 deepest, g3 brightest) for the dashboard
// banner and the thin bar at the top of every page.
//
// The four colours the Methodist Church Ghana Lectionary uses: white (gold on Christmas Day), green,
// violet and red.
//
// "White" is a festival colour, but a white app would be unreadable, so it is
// shown as gold: the same convention churches use for white-and-gold festivals.

const PALETTE = {
  GREEN: {
    label: 'Green',
    swatch: '#1e7f4a',
    light: { accent: '#1e7f4a', hover: '#176a3d', soft: '#e7f4ec', ink: '#14663a', on: '#ffffff', g1: '#0f5c33', g2: '#1e7f4a', g3: '#46a870' },
    dark: { accent: '#3dbb78', hover: '#55cc8c', soft: '#11271a', ink: '#8fe3b5', on: '#04200f', g1: '#0b3a22', g2: '#14633a', g3: '#1f8a52' },
  },
  VIOLET: {
    label: 'Violet',
    swatch: '#6a3fa0',
    light: { accent: '#6a3fa0', hover: '#5a3388', soft: '#f1eaf8', ink: '#53307f', on: '#ffffff', g1: '#46266f', g2: '#6a3fa0', g3: '#9569c9' },
    dark: { accent: '#a98bdb', hover: '#bba0e5', soft: '#231a38', ink: '#cdb8f0', on: '#180c2b', g1: '#2c1850', g2: '#47298a', g3: '#6a43b5' },
  },
  RED: {
    label: 'Red',
    swatch: '#b42318',
    light: { accent: '#b42318', hover: '#9a1c13', soft: '#fdecea', ink: '#912018', on: '#ffffff', g1: '#8a1a11', g2: '#b42318', g3: '#d4574a' },
    dark: { accent: '#f0786d', hover: '#f58f85', soft: '#301412', ink: '#ffb4ac', on: '#2b0805', g1: '#5c130d', g2: '#8f1f16', g3: '#b83a2e' },
  },
  WHITE: {
    label: 'White',
    note: 'shown as gold so it stays readable',
    swatch: '#9a7416',
    light: { accent: '#8a6a12', hover: '#735810', soft: '#fbf4de', ink: '#6e5410', on: '#ffffff', g1: '#6b5010', g2: '#8a6a12', g3: '#b98f1f' },
    dark: { accent: '#e3b341', hover: '#ebc15f', soft: '#2a2210', ink: '#f2d27a', on: '#1d1400', g1: '#4a3708', g2: '#76590d', g3: '#a2791a' },
  },
};

const KEYS = Object.keys(PALETTE);

module.exports = { PALETTE, KEYS };
