# Changelog

All notable changes to this project are documented here.

## Unreleased

### Changed

- New "Precision" look for the signed-in app, stage 1 of 3 (shell and dashboard). A light sidebar with grouped sections, a top bar with breadcrumbs, a "New" menu and a light/dark switch, and a ⌘K / Ctrl K search over pages, actions, members and events. It replaces the Material You theme (`public/theme-material.css` removed; `public/theme-precision.css` and `public/app-theme.js` added). The colour picker is gone; the light/dark choice carries over. Cards, buttons, forms, tables and badges on every page use the new style. The sign-in and landing pages are unchanged for now.
- The dashboard has four key figures with trend lines, giving by type over 12 weeks or 12 months, what needs your attention, birthdays in the next 7 days (with a Wish shortcut to a one-person SMS for admins), attendance over the last 12 full weeks, upcoming events with the membership mix, and recent activity. Giving now comes from the finance ledger, so it matches the Finance page (it used to count general income records only).
- Platform operators see the Platform link in the sidebar again.
- Phones (900px wide and under) get a floating Liquid Glass tab bar instead of the side menu: Home, Members, Finance, Events and More, with the current section highlighted in its colour. More opens a sheet with the other sections plus Search, Light/dark, Profile and Sign out; a floating New button opens the quick actions. The phone top bar keeps just the page title and search. Computers keep the sidebar.
- More colour across the app:
  - A brand stripe along the top of every page, and the dashboard greeting as a gradient banner.
  - Sidebar icons colour-coded by section, and coloured tiles in the New menu.
  - Key figures and stat tiles with coloured top strips, and a coloured mark beside each card title.
  - Varied avatar colours, coloured fund cards, and a wider chart palette (violet, teal, gold, rose).
  - Styling only (`public/theme-precision.css`).
- Finance overview, stage 3 of 3:
  - Key figures for the month compared with last month so far, Sunday collections (cash count sheets, counted then verified, with Verify for a second officer), and income by type from the ledger.
  - Recent ledger entries, expenses waiting for approval (Approve/Reject in place), financial checks, fund balance cards, and the tools directory.
  - Approve, reject and cash-count verify accept `return_to=/finance`. No other destination is accepted, and their existing controls still apply.
  - The ledger's income grouping (`INCOME_GROUPS`) is shared by the dashboard and Finance.
- The landing page and the signed-out pages (sign-in, sign-up, password reset, MFA, QR check-in, RSVP, unsubscribe) now use the Precision look. The landing page hero shows a miniature of the dashboard. They load `public/public.css` (self-contained, about 20 KB) and the same light/dark script as the app. `public/editorial.css`, `public/theme-editorial.css` and `public/material-theme.js` are removed.
- Members: admins can tick members (across pages and filters, up to 500) and send them an SMS or email through the broadcast composer, or export them as CSV. An Export button downloads everyone matching the current filters. `GET /members/export.csv` (admins only, logged to activity) takes the directory filters or `?ids=`; `/communications/broadcast` accepts `member_ids=1,2,3`. CSV helpers moved to `lib/csv.js`.
- Members directory, stage 2 of 3: status tabs with counts, a filter panel (status, organisation, Bible class, day born, each multi-select and kept in the link), and a denser table with organisations, attendance over the last 12 weeks and, for finance roles, giving this year. On phones the filters open as a bottom sheet. Clicking a member opens a slide-in profile summary (contact, status, organisations, giving this year for finance roles, last 12 weeks of attendance, recent check-ins) with Call, SMS, Edit and Open full profile; `?open=ID` keeps it in the link and Back closes it. New route `GET /members/:id/panel` returns that summary as an HTML fragment. `/members?status=` accepts several values; the old single-value links still work.

- Broadcasts are sent in the background. `POST /api/communications/broadcasts` now answers `202` with the broadcast in `SENDING`; poll `GET /api/communications/broadcasts/:id` for the final status. The HTML broadcast page redirects at once and refreshes itself while sending. A failed send marks the broadcast `FAILED`, and on SIGTERM the server waits up to 20 seconds for in-flight sends.

### Fixed

- Members on phones: the filter sheet showed open over the list on load; it now stays hidden until Filters is tapped.
- Member photo upload wrote the file before checking the member belonged to the caller's church (cross-tenant overwrite/delete) and had no CSRF check.
- Expense approval and journal reversal are now claimed atomically; concurrent requests can no longer pay an expense or reverse an entry twice (`approveAndPayExpense`, `reverseJournal`).
- Tithes reject non-positive amounts and invalid dates before any row is created; pledge payments use an atomic increment; receipt numbers retry on a clash.
- Special offerings post to 4040; "Salaries", "Office Supplies" and "Outreach" expenses post to their own accounts instead of 5900. Entries already posted keep their old account.
- Public check-in/RSVP: no roster dropdown, signed name picks, minimum search length, rate limiting, and suspended/deleted churches' links stop working. The RSVP page is now search-then-pick.
- Platform-operator emails (`PLATFORM_ADMIN_EMAILS`) can no longer be registered once any church exists, or created as tenant users (set `ALLOW_PLATFORM_ADMIN_SIGNUP=1` just while registering the operator account after other churches exist).
- Concurrent pledge payments no longer collide on the empty placeholder receipt number (each insert now uses a unique placeholder).
- Rate limiter bounds its key length and bucket count. Production no longer signs sessions with a hardcoded secret when `SESSION_SECRET` is unset.
- Password reset tokens are stored hashed, are single-use atomically, and sign out the user's other sessions. Reset/verification emails are not sent without `PUBLIC_URL` in production.
- Login: non-string passwords no longer 500, unknown emails cost the same bcrypt time, failed-attempt counting is atomic.
- `/api` rejects form-encoded bodies; non-numeric ids give 404; production 500 responses no longer include internal error text; CSV exports neutralise formula cells; removed users free their login email.
- Expense approval now claims on the exact amount/date/fund/category the approver saw, and expense edits are conditional on status, so an edit racing an approval can no longer change a paid expense. Expense approval limits can only be changed by an Admin.
- Email "From" is always the platform address (churches control only the display name and Reply-To); broadcasts have a length limit and a rolling 24-hour per-church cap (`BROADCAST_DAILY_LIMIT_FREE` / `_PRO`); preaching reminders are rate limited and only marked sent if a channel accepted them.
- Added the missing `/u/:token` unsubscribe page that every broadcast email links to; `/api/members` no longer returns `unsubscribeToken`.
- A fund's opening balance can't be edited once it has postings. Added `scripts/purge-deleted-churches.js` (dry run by default) to act on `deletionPurgeAfter`. Stuck `SENDING` broadcasts are marked FAILED after 30 minutes.
- JSON user routes now write security-audit events like the HTML ones; an admin password reset clears the lockout and signs the user out everywhere; admin 2FA disable clears recovery codes.
- Member ids retry on a clash; gender / marital status / preferred channel / dates are validated (400, not 500). "Missing 3 Sundays" ignores future and unattended services; report dates are validated.
- The Editor role is documented as read-only (it never had write access); `docs/AUTHORIZATION_MATRIX.md` rewritten to match the code. Only platform operators see the Platform nav link.
- Oversized text fields (over 20,000 characters) are refused; Sentry tracing defaults to 10%; deploys wait for the tests workflow and pin the flyctl action.

## v1.4.0 - 2026-06-30

### Added

- Native double-entry finance module built directly into the management app (no external service):
  - Chart of accounts (`accounts` table) with 30 predefined GL codes across ASSET/INCOME/EXPENSE/FUND_EQUITY types.
  - Double-entry journal (`journal_entries` + `journal_lines`) with POSTED/REVERSED lifecycle and reversal chaining.
  - Financial periods (`financial_periods`) for period-open/close controls.
  - Fund management (`funds`) with opening balance, type (GENERAL/BUILDING/WELFARE/etc.), restricted/unrestricted flag, and ledger-derived balance.
  - Finance projects (`finance_projects`) with status workflow (PLANNING/ACTIVE/ON_HOLD/COMPLETED/CANCELLED) and budget tracking.
  - Finance budgets (`finance_budgets` + `finance_budget_lines`) with ANNUAL/MONTHLY scope, account-level lines, and overspending warnings on the finance dashboard.
  - Payment vouchers (`payment_vouchers`) auto-generated from approved expenses, with printable voucher layout and signature fields.
  - Expense approval workflow: SUBMITTED → APPROVED → PAID / REJECTED, with voucher generation on approval.
  - Finance settings page for fiscal year start, default currency, cash account selection.
  - Accounting page with fund balances, trial balance (debit/credit totals, balanced check), and general ledger view.
  - CSV exports for trial balance, general ledger, vouchers, fund report, and projects.
  - User `finance_role` column (none/finance_admin/treasurer/cashier/auditor) with dedicated middleware (`requireFinanceWrite`, `requireFinanceAccounting`, `requireFundViewer`, `requireFundManager`).
  - `lib/ledger.js`: postCashIncome, postExpensePayment, reverseJournal, fundBalance, fundRaisedSpent helpers.
  - `lib/money.js`: amountInWords() Ghanaian-cedi amount-in-words for voucher printing.
- SaaS operations documentation:
  - `docs/LEGAL_AND_SUPPORT_READINESS.md`
  - `docs/MONITORING_AND_ALERTS.md`
  - `docs/OFFSITE_BACKUP_SETUP.md`
  - `docs/SAAS_ONBOARDING_AND_LIMITS.md`
  - `docs/SAAS_TENANCY_REVIEW.md`
  - `docs/USER_ACCEPTANCE_TEST_PLAN.md`

### Removed

- External SSO handoff to the Vercel church-finance app (`lib/sso.js`, `lib/sync.js`, `/sso/authorize`, `/sync/members`). Finance is now fully in-house.
- `FINANCE_ORIGIN` and `SSO_SECRET` environment variables (removed from `.env.example`).

### Notes

- Finance role migration: existing users default to `finance_role='none'`. Assign roles from the Users admin page.
- Ledger tables (`accounts`, `journal_entries`, `journal_lines`, `financial_periods`) are auto-created on first boot from the updated `schema.sql`.

## v1.3.0 - 2026-06-05

### Added

- Phase 3 production-hardening plan and operations runbook.
- In-app backup verification from `/backups`, including SQLite integrity checks and expected table checks.
- Backup create/delete/verify/restore staging events in the security audit log.
- Owner-only Operations page at `/operations` for readiness, backup, error, audit and integration status.

### Changed

- Backup verification and restore drill scripts now run `PRAGMA integrity_check` and validate expected core tables.

## v1.2.0 - 2026-05-28

### Added

- Security audit log for login and user-management events, with owner review page at `/security/audit`.
- Financial summary CSV export at `/reports/financial.csv`.
- Production sanity helper script: `scripts/prod-sanity.sh`.
- Authorization matrix documentation in `docs/AUTHORIZATION_MATRIX.md`.
- Enterprise command-center headers across operational pages, including dashboard, members, finance, events, communications, inventory, preaching, sacraments, backups, errors, users, profile and settings.

### Changed

- Release/security docs now include audit review and production sanity checks.
- Fresh database schema and live migration helper now both create the security audit index used by owner review.

## v1.1.0 - 2026-05-28

### Added

- Runtime health and readiness endpoints:
  - `GET /healthz`
  - `GET /readyz` (DB connectivity check)
- Inventory category model and workflows:
  - persistent `inventory_categories` schema guard
  - recommended categories list for inventory forms
  - category dropdowns for add/edit flows
  - admin route `POST /inventory/categories`
- Live migration/ops helpers:
  - `scripts/migrate-live-db.js`
  - `scripts/deploy-live.sh`
  - `scripts/verify-backup.sh`
- Fly health checks in:
  - `fly.toml`
  - `deploy/fly.toml.template`
- Operations documentation:
  - `docs/NEXT_STEPS.md`
  - `docs/RELEASE_CHECKLIST.md`
  - `docs/ROLLBACK_PIN.md`

### Changed

- Dashboard visual polish with `.dash-shell` modern aesthetic treatment.
- Startup environment validation now fails fast when required env variables are missing (outside tests).
- `package.json` adds `migrate-live-db` script.

### Notes

- If upgrading a long-lived production database, run:
  - `CHURCH_DB=/data/church.db node scripts/migrate-live-db.js`
