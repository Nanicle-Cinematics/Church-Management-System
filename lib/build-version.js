'use strict';

// Which build is live, for /healthz, so the uptime monitor (saas-monitor) can
// mark deploys on its charts. Fly sets FLY_IMAGE_REF on every machine, e.g.
// registry.fly.io/church-management-system:<label>, sometimes with an
// @sha256:… digest after it. deploy.yml labels the image with the git commit;
// a manual `fly deploy` gets Fly's own deployment-<id> label instead.
// Reads only the environment: /healthz must never touch the database.
function buildVersion(env = process.env) {
  const ref = String(env.FLY_IMAGE_REF || '').split('@')[0];
  const label = ref.slice(ref.lastIndexOf('/') + 1).split(':')[1] || '';
  if (/^[0-9a-f]{40}$/.test(label)) return { commit: label.slice(0, 7) };
  return label ? { deployment: label } : {};
}

module.exports = { buildVersion };
