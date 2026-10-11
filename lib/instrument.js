'use strict';
// Must be required before any other module (server.js's first require) so
// Sentry's auto-instrumentation can wrap http/express/pg before they load.
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // 100% tracing is costly and sends far more request data to a third party
  // than error reporting needs. Raise via SENTRY_TRACES_SAMPLE_RATE if wanted.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
  sendDefaultPii: false,
});

module.exports = Sentry;
