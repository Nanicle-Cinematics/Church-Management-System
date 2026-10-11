# Authorization Matrix

This describes what the code enforces today (checked against the route guards in
`routes-pg/` and `routes-pg-html/`). It replaces an earlier single-tenant version
that referred to the `dunwelladmin` username and to editor write access, neither
of which exists any more.

Two independent settings decide access: the user **role** and the **finance role**.

## Role

| Area | Admin | Editor | Viewer |
| --- | --- | --- | --- |
| Dashboard, members, attendance, events, Bible classes, organizations, inventory, preaching, announcements | Read/write | Read | Read |
| Communications: send broadcasts, email settings | Read/write | Blocked | Blocked |
| Communications: view history | Read | Read | Read |
| Users and roles, church settings, data export | Read/write | Blocked | Blocked |
| Reports (Pro plan) | Read | Read | Read |
| Platform console | Only addresses in `PLATFORM_ADMIN_EMAILS` | | |

`editor` is currently identical to `viewer`: no route grants it write access.
It is kept so existing accounts do not break; give a user write access either by
making them an Admin or, for money only, a finance role.

## Finance role (`financeRole`)

| Capability | Admin | Finance Admin | Treasurer | Cashier | Auditor | None |
| --- | --- | --- | --- | --- | --- | --- |
| View finance pages and reports | Yes | Yes | Yes | Yes | Yes | No |
| Record income, tithes, day-borns, services, harvests, pledges, expenses, cash counts, deposits | Yes | Yes | Yes | Yes | No | No |
| Approve / reject expenses (tiered by amount, never your own) | Tier 3 | Tier 2 | Tier 1 | No | No | No |
| Verify cash counts and deposits (never your own), void, reverse journals, manage funds, projects, budgets, lock periods | Yes | Yes | Yes | No | No | No |
| Change expense approval limits | **Admin only** | No | No | No | No | No |
| Reopen a locked period | **Admin only** | No | No | No | No | No |

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
