const { AsyncLocalStorage } = require('async_hooks');
const { PrismaClient, Prisma } = require('@prisma/client');
const { normalizeEnvDatabaseUrl } = require('./database-url');

normalizeEnvDatabaseUrl();

// ---------------------------------------------------------------------------
//  MULTI-TENANCY CHOKE POINT
//  Every tenant-owned row carries `churchId`. tenantDb(churchId) returns a
//  Prisma client extension that AUTOMATICALLY scopes every query to that
//  church:
//    - read/filter/update/delete ops get `where.churchId = churchId`
//    - create / createMany / upsert get `churchId` written into the data
//  Route handlers use the returned client and never write a churchId filter
//  by hand. Direct port of poultry-manager's src/lib/tenant.ts.
// ---------------------------------------------------------------------------

const db = new PrismaClient();

// Models WITHOUT a churchId column (pre-tenant / the tenant itself). Never scoped.
const GLOBAL_MODELS = new Set(['Church', 'TrialSignup', 'PlatformOperator', 'PlatformAuditLog']);

// Operations whose `args.where` should be constrained to the church.
const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

// ---------------------------------------------------------------------------
//  LINKS BETWEEN ROWS
//  The scoping above covers the row being written, not the rows it points at:
//  a check-in saved under church A could name church B's member, and the
//  database accepts it (foreign keys are on `id` alone). Anything that then
//  reads the check-in with `include: { member }` would show church B's data.
//  So every write through tenantDb() has each foreign key it sets (scalar
//  `memberId: 5`, nested `connect`, nested `create`) checked against the same
//  church first, and is refused as "Not found" if any of them is not.
// ---------------------------------------------------------------------------

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const isTenantModel = (name) => !GLOBAL_MODELS.has(name) && MODELS.has(name)
  && MODELS.get(name).fields.some((f) => f.name === 'churchId');
// FK_FIELDS[model][fkField] = { target, key }   e.g. Attendance.memberId -> Member.id
// RELATIONS[model][relationField] = { target, key }   for nested writes
const FK_FIELDS = {};
const RELATIONS = {};
for (const m of MODELS.values()) {
  FK_FIELDS[m.name] = {};
  RELATIONS[m.name] = {};
  for (const f of m.fields) {
    if (f.kind !== 'object' || !isTenantModel(f.type)) continue;
    const target = MODELS.get(f.type);
    const key = (f.relationToFields && f.relationToFields[0])
      || (target.fields.find((x) => x.isId) || {}).name || 'id';
    RELATIONS[m.name][f.name] = { target: f.type, key };
    if (f.relationFromFields && f.relationFromFields.length === 1) {
      FK_FIELDS[m.name][f.relationFromFields[0]] = { target: f.type, key };
    }
  }
}

class TenantRefError extends Error {
  constructor() {
    super('Not found.');
    this.name = 'TenantRefError';
    this.status = 404;
    this.expose = true; // shown as-is by the error handler; reveals nothing
  }
}

function addRef(refs, target, key, value) {
  if (value !== null && typeof value === 'object') value = 'set' in value ? value.set : undefined;
  if (value === null || value === undefined) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return; // Prisma refuses it anyway
  const k = `${target}.${key}`;
  if (!refs.has(k)) refs.set(k, { target, key, values: new Set() });
  refs.get(k).values.add(value);
}

function collectRefs(model, data, refs) {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data)) { data.forEach((d) => collectRefs(model, d, refs)); return; }
  const fks = FK_FIELDS[model] || {};
  const rels = RELATIONS[model] || {};
  for (const [field, value] of Object.entries(data)) {
    if (fks[field]) { addRef(refs, fks[field].target, fks[field].key, value); continue; }
    const rel = rels[field];
    if (!rel || !value || typeof value !== 'object') continue;
    const wheres = [].concat(value.connect || [], value.set || [],
      value.connectOrCreate ? [].concat(value.connectOrCreate).map((c) => c && c.where) : []);
    for (const w of wheres) if (w && w[rel.key] !== undefined) addRef(refs, rel.target, rel.key, w[rel.key]);
    if (value.create) collectRefs(rel.target, value.create, refs);
    if (value.createMany && value.createMany.data) collectRefs(rel.target, value.createMany.data, refs);
    if (value.connectOrCreate) [].concat(value.connectOrCreate).forEach((c) => c && collectRefs(rel.target, c.create, refs));
    for (const op of ['update', 'updateMany', 'upsert']) {
      for (const u of [].concat(value[op] || [])) {
        if (!u) continue;
        if (u.data) collectRefs(rel.target, u.data, refs);
        if (u.create) collectRefs(rel.target, u.create, refs);
        if (u.update) collectRefs(rel.target, u.update, refs);
        if (!u.data && !u.create && !u.update && !u.where) collectRefs(rel.target, u, refs);
      }
    }
  }
}

// The check must see rows created earlier in the same transaction (a period,
// a count sheet), so it runs on the transaction's client when there is one:
// tenantDb()'s $transaction records it here for the duration of the callback.
const currentTx = new AsyncLocalStorage();

async function assertSameChurch(model, operation, args, churchId) {
  const refs = new Map();
  if (operation === 'upsert') { collectRefs(model, args.create, refs); collectRefs(model, args.update, refs); }
  else collectRefs(model, args.data, refs);
  for (const { target, key, values } of refs.values()) {
    const ids = [...values];
    const delegate = target[0].toLowerCase() + target.slice(1);
    const client = currentTx.getStore() || db;
    const found = await client[delegate].count({ where: { [key]: { in: ids }, churchId } });
    if (found !== ids.length) throw new TenantRefError();
  }
}

// A write may only ever name THIS church. Routes never pass request data into
// a write, but if one ever did, `data: { churchId: other }`, a nested create,
// or `church: { connect: ... }` would hand a row to another church, or plant
// one there that points at this church's records. So any churchId, or any use
// of the `church` relation, anywhere in the data that is not this church is
// refused, rather than trusted to be absent.
function assertNoForeignChurch(value, churchId) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((v) => assertNoForeignChurch(v, churchId)); return; }
  for (const [key, v] of Object.entries(value)) {
    if (key === 'churchId') {
      const set = v !== null && typeof v === 'object' && 'set' in v ? v.set : v;
      if (set !== undefined && set !== churchId) throw new TenantRefError();
    } else if (key === 'church') {
      const named = v && v.connect && v.connect.id;
      if (named !== churchId) throw new TenantRefError();
    } else {
      assertNoForeignChurch(v, churchId);
    }
  }
}

const WRITE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);

function tenantDb(churchId) {
  // `where: { churchId: undefined }` is no filter at all in Prisma, so a missing
  // church would not fail: every read would quietly return every church's rows.
  if (typeof churchId !== 'string' || !churchId) throw new Error('tenantDb() needs a church id');
  const client = db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || GLOBAL_MODELS.has(model)) return query(args);
          const a = { ...(args ?? {}) };
          if (WRITE_OPS.has(operation)) {
            for (const part of [a.data, a.create, a.update]) assertNoForeignChurch(part, churchId);
            await assertSameChurch(model, operation, a, churchId);
          }

          if (WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), churchId };
          }
          if (operation === 'create') {
            a.data = { ...(a.data ?? {}), churchId };
          }
          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const d = a.data;
            a.data = Array.isArray(d) ? d.map((x) => ({ ...x, churchId })) : { ...(d ?? {}), churchId };
          }
          if (operation === 'upsert') {
            a.create = { ...(a.create ?? {}), churchId };
          }
          return query(a);
        },
      },
    },
  });
  // Interactive transactions record their client for the link check above.
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== '$transaction') return target[prop];
      return (arg, opts) => (typeof arg === 'function'
        ? target.$transaction((tx) => currentTx.run(tx, () => arg(tx)), opts)
        : target.$transaction(arg, opts));
    },
  });
}

// Resolves the tenant for a public, session-less token-based route (QR
// check-in, RSVP). Event.checkinToken is declared @unique GLOBALLY (not
// per-church) in the schema, so looking it up via the raw, unscoped `db`
// is safe — there's no cross-tenant ambiguity to resolve. Once the event
// (and its churchId) is found, everything else in the request should use
// the returned tenantDb(), never the raw client. Returns null if the
// token doesn't match any event.
async function resolveChurchByCheckinToken(token) {
  if (!token) return null;
  const event = await db.event.findUnique({
    where: { checkinToken: token },
    include: { church: { select: { name: true, suspendedAt: true, deletedAt: true } } },
  });
  if (!event) return null;
  // These pages have no session, so the central suspension gate in
  // tenant-http.js never sees them. A suspended or deleted church's public
  // links must stop working too, and look the same as an unknown token.
  if (event.church.suspendedAt || event.church.deletedAt) return null;
  return { event, churchId: event.churchId, db: tenantDb(event.churchId) };
}

// A church's data for a read-only support view (lib/support-view.js):
// scoped like tenantDb, and any write is refused here, at the source, so a
// page that happens to save something on GET cannot change a church's data.
const CHANGE_OPS = new Set([...WRITE_OPS, 'delete', 'deleteMany', 'createManyAndReturn', 'updateManyAndReturn', '$executeRaw', '$executeRawUnsafe']);
function readOnlyTenantDb(churchId) {
  const scoped = tenantDb(churchId);
  return scoped.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (CHANGE_OPS.has(operation)) throw new Error(`Read-only support view: ${model}.${operation} refused`);
          return query(args);
        },
      },
    },
  });
}

module.exports = { db, tenantDb, readOnlyTenantDb, GLOBAL_MODELS, resolveChurchByCheckinToken, TenantRefError };
