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

// ---------------------------------------------------------------------------
//  MONEY: Decimal(14,2) IN THE DATABASE, plain numbers IN THE APPLICATION
//  Money columns are exact numerics so SQL sums and the ledger cannot drift by
//  floating-point error. Prisma returns them as Decimal objects, which do not
//  behave like numbers (`a + b` concatenates, `a > 0` is wrong, JSON gives
//  strings). The whole app is written against numbers (rounded to the pesewa
//  with roundMoney where it matters), so every result that leaves Prisma —
//  model queries, aggregates, and raw SQL — is converted back here, once.
// ---------------------------------------------------------------------------
function decimalsToNumbers(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Prisma.Decimal.isDecimal(value)) return value.toNumber();
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = decimalsToNumbers(value[i]);
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // Date, Buffer, ...
  for (const key of Object.keys(value)) value[key] = decimalsToNumbers(value[key]);
  return value;
}

const decimalExtension = Prisma.defineExtension({
  name: 'decimals-to-numbers',
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        return decimalsToNumbers(await query(args));
      },
    },
    async $queryRaw({ args, query }) { return decimalsToNumbers(await query(args)); },
    async $queryRawUnsafe({ args, query }) { return decimalsToNumbers(await query(args)); },
  },
});

const db = new PrismaClient().$extends(decimalExtension);

// Models WITHOUT a churchId column (pre-tenant / the tenant itself). Never scoped.
const GLOBAL_MODELS = new Set(['Church', 'TrialSignup']);

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
  'delete',
  'deleteMany',
  'upsert',
]);

function tenantDb(churchId) {
  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || GLOBAL_MODELS.has(model)) return query(args);
          const a = { ...(args ?? {}) };

          if (WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), churchId };
          }
          if (operation === 'create') {
            a.data = { ...(a.data ?? {}), churchId };
          }
          if (operation === 'createMany') {
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
    include: { church: { select: { suspendedAt: true, deletedAt: true } } },
  });
  if (!event) return null;
  // These pages have no session, so the central suspension gate in
  // tenant-http.js never sees them. A suspended or deleted church's public
  // links must stop working too, and look the same as an unknown token.
  if (event.church.suspendedAt || event.church.deletedAt) return null;
  return { event, churchId: event.churchId, db: tenantDb(event.churchId) };
}

module.exports = { db, tenantDb, GLOBAL_MODELS, resolveChurchByCheckinToken, decimalsToNumbers };
