# Authorization Matrix

This describes what the code enforces today (checked against the route guards in
`routes-pg/` and `routes-pg-html/`). It replaces an earlier single-tenant version
that referred to the `dunwelladmin` username and to editor write access, neither
of which exists any more.

Two independent settings decide access: the user **role** and the **finance role**.

## Role

| Area | Admin | Editor | Viewer |
| --- | --- | --- | --- |
| Dashboard, members, attendance, events, Bible classes, organizations, inventory, preaching, announcements: add and edit | Yes | Yes | Read only |
| The same areas: delete or archive (editors may still remove a member photo) | Yes | No | No |
| Member data export (CSV), bulk SMS/email from Members | Yes | No | No |
| Communications: send broadcasts, email settings | Read/write | Blocked | Blocked |
| Communications: view history | Read | Read | Read |
| Users and roles, church settings, data export | Read/write | Blocked | Blocked |
| Reports (Pro plan) | Read | Read | Read |

No church account, whatever its role, can open the platform console. See
**Platform operators** below.

Editors add and edit everyday records (members and their photos, attendance, events with check-ins and RSVPs, Bible classes, organizations and their members, inventory, the preaching plan, announcements). Deleting or archiving, exporting member data, sending broadcasts or preacher reminders, email settings, users and church settings stay with admins. Money is governed by the finance role, not by this one.

### Editors and Viewers without a finance role

An Editor or Viewer whose finance role is **None** gets a narrower app
(`lib/access.js`). Admins, and Editors or Viewers with any finance role, are
not affected.

| Area | Editor, no finance role | Viewer, no finance role |
| --- | --- | --- |
| Dashboard | Yes, without money | Yes, without money |
| Members, attendance, Bible classes, organizations | Add and edit (as above) | Read only |
| Events | Read; check people in and record RSVPs. No create, edit or headcounts | Read only |
| Preaching plan, inventory | Read only | Read only |
| Finance, Communications, Reports (pages and API) | Blocked (403), hidden from the menu | Blocked (403), hidden from the menu |

## Finance role (`financeRole`)

| Capability | Admin | Finance Admin | Treasurer | Cashier | Auditor | None |
| --- | --- | --- | --- | --- | --- | --- |
| View finance pages and reports | Yes | Yes | Yes | Yes | Yes | No |
| Record income, tithes, day-borns, services, harvests, pledges, expenses, cash counts, deposits | Yes | Yes | Yes | Yes | No | No |
| Approve / reject expenses (tiered by amount, never your own) | Tier 3 | Tier 2 | Tier 1 | No | No | No |
| Verify cash counts and deposits (never your own), void, reverse journals, manage funds, projects, budgets, lock periods | Yes | Yes | Yes | No | No | No |
| Change expense approval limits | **Admin only** | No | No | No | No | No |
| Reopen a locked period | **Admin only** | No | No | No | No | No |

Allowances (Finance › Allowances): anyone who can view finance pages sees the
worker list and each month's run; Admins, Finance Admins and Treasurers add,
edit and pause workers, set the due day and alert numbers, draft a month by
hand and send a test alert. The drafted expenses follow the approval tiers
below; they are recorded by the system, so any fund manager may approve them.

Approval tiers use the limits in Finance settings (default 500 / 5000): up to the
small limit any fund manager, up to the medium limit a Finance Admin or Admin,
above that an Admin.

## Public pages (no login)

`/checkin/:token`, `/rsvp/:token` (possession of the event QR token, rate limited,
name search with signed picks) and `/u/:token` (unsubscribe). All stop working
when the church is suspended or deleted.

## Audit

Security-sensitive actions are written to `security_audit_log` (logins, MFA,
role changes, admin password resets, user removal, data export). Finance actions
are written to the activity log and shown at `/finance/audit`.

## Platform operators

The platform console (`/platform`, `/api/platform/*`) sees and changes every
church, so it is not reached through a church account at all.

- Operators are a separate table (`platform_operators`) with no church and no
  access to church pages or church data. A church account cannot open the
  console, and an operator session cannot open church pages.
- They sign in at `/platform/login`. Two-factor is required: an operator who
  has not set it up is taken through setup right after the password, and the
  console stays closed until it is done. Five wrong passwords lock the account
  for 15 minutes; 30 minutes without activity signs them out.
- There is no sign-up page. Accounts are managed on the server with
  `node scripts/platform-operator.js` (see `docs/OPERATIONS_RUNBOOK.md`).
- Sign-ins and every console action are recorded in `platform_audit_log`.
  Plan and access changes are also written to the affected church's own
  security audit log.

`PLATFORM_ADMIN_EMAILS` no longer grants access. It is still read as a fallback
address for operational alert emails when `ALERT_EMAIL` is unset.
