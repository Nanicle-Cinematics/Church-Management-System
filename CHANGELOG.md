# Changelog

All notable changes to this project are documented here.

## Unreleased

### Security

- **Support tells the person when it changes their sign-in or makes them a reset link.** Platform support can do both without the church's say-so (a locked-out admin cannot turn on support access), so it could quietly take over an account that has no two-factor. The user is now told at the contact they had before the change (email, or a text if they have no email). A reset link sent to the user themselves needs no extra notice. These support actions are also written to the audit logs before they are carried out, not after, so a failure partway can no longer leave an action unlogged.
- **The tenant layer refuses any write that names another church** (`lib/tenant.js`). Attacking it directly from one church against another showed that reads, and updates and deletes by id, were already isolated. But seven things were not: a write could set `churchId` or `church: { connect }` to hand a row to another church, a nested create could plant a row in another church that pointed at this church's records, `updateManyAndReturn` was not scoped at all, `createManyAndReturn` could write into another church, and `tenantDb(undefined)` returned every church's rows (Prisma ignores an undefined filter). No route passes request data into a write, so none of this was reachable today; it is closed so that one careless line later cannot break isolation. Any `churchId` or `church` in write data that is not the scoped church is now refused, `*AndReturn` operations are scoped like their twins, and `tenantDb()` throws without a church id.
- **A Cashier can no longer undo posted money.** Reversing or archiving income, day-born collections, services and harvests (page and API) now needs a Treasurer, Finance Admin or Admin, the same as reversing a journal entry; the Reverse buttons are hidden from Cashiers. Found in the per-role permissions review: the direct journal reversal was already restricted, but these routes reversed the same ledger entries with no approval.
- **The chart of accounts needs finance access** (`/api/finance/accounts` was open to every signed-in user).
- **Read-only accounts no longer receive an event's check-in token** (the secret in its QR code) from the events API; Admins and Editors, who can open the QR page, still do.
- The Users form now says that the Finance role works on its own, whatever the Role above says.

- **Strict script policy (CSP).** Pages can no longer run inline script. `script-src` is now `'self'` (it allowed `'unsafe-inline'`), so markup injected into a page cannot execute code. All 14 inline scripts moved to `public/js/`, and the 45 inline `onclick` / `onsubmit` / `onchange` handlers and 6 `javascript:` print links became `data-` attributes handled by `public/js/ui.js` (`data-confirm`, `data-prompt`, `data-autosubmit`, `data-print`, `data-reload`, ...). This also fixes a bug: confirm messages that contained a member's or user's name were built into inline JavaScript, so a name with a quote in it could run script when someone clicked Delete or Send. Messages now travel as plain text. Styles still allow inline `style=""`. `test/csp.test.js` fails if inline script or a handler comes back.
- **Password rules.** A chosen password must be at least 10 characters (was 8), must not be a well-known one however it is dressed up ("Password123!", "Welcome2024"), a single repeated character or all digits, and must not contain the person's own email name. This applies to sign-up, password reset, new teammates and admin resets. Existing passwords are untouched.
- **A reminder to turn on two-factor** at the top of the dashboard for Admins and finance accounts that have not, until they do.
- **Reset and check-in links no longer reach logs.** The error log and Sentry now store URLs with the secret part (reset, verify, check-in, RSVP and unsubscribe links) and the query string removed.
- **Uploaded photos and logos are saved under the type their bytes show**, not the type the browser claimed.

- **Password spraying is throttled.** Sign-in was limited per IP *and* email, so one IP trying a single password against many addresses never reached a limit. Church sign-in now also limits each IP to 100 attempts per 15 minutes, and the operator console to 50.
- **Public QR check-in and RSVP show less, and expire.** A result shows a first name and last initial only (no surname, member ID or class), and a phone number no longer finds anyone. A check-in link works from 12 hours before the event to a day after it ends; an RSVP link until a day after. Old QR codes stop working.
- **Two-factor secrets can be encrypted at rest** (`lib/secret-box.js`). Set `TOTP_ENCRYPTION_KEY` (`fly secrets set TOTP_ENCRYPTION_KEY=...`), deploy, then run `node scripts/encrypt-totp-secrets.js` once. Secrets stored earlier keep working until then. Keep the key: if it is lost, those users sign in with a recovery code and an admin resets their two-factor.

### Added

- **View as church** (support). A church admin can allow Church Manager support to see their church's app, read-only, for 1 hour, 24 hours or 3 days, under Settings › **Support access**, and can turn it off at any time. While access is on, the church's console page offers **View as church (read-only)**. The operator then sees the app as one of the church's admins does, under a banner that says so, with **End**.
  - **Nothing can be changed:** every save is refused, and a read-only database connection refuses any write at the source.
  - **Nothing can be exported:** exports and downloads are refused.
  - **It ends by itself** when access runs out or is turned off, or the operator's console session ends.
  - **It is recorded:** allowing, turning off, starting and ending are in the church's own security log, and the latest are listed on its Settings page.
- Platform › **Errors**: the last 90 days of server errors, grouped, so the same fault on different pages or records shows once. Errors are grouped by method, by path with ids replaced, and by message with numbers, ids and quoted values replaced. Each group shows its count, first and last seen, how many churches it hit, and the latest occurrence with its stack. **Mark fixed** takes a group off the Open list. If the fault happens again it reappears, marked **came back**. The Overview's error count now counts open errors only, and links here.
- Platform › **Operators**: manage the console's own accounts without the server script, which still works. The tab lists each operator's two-factor, lock and disabled state and last sign-in. Operators can:
  - **add** an operator, whose random password is shown once on the page and who sets up two-factor at first sign-in;
  - **reset** another operator's password (shown once; they are signed out everywhere) or two-factor;
  - **rename**, **disable** or **enable** operators;
  - **change their own password**, with their current one.
  
  Nobody can disable or reset themselves, and the last enabled operator cannot be disabled. Every change is in the platform audit log.
- Platform › **Announcements**: a notice, such as planned maintenance, shown at the top of every signed-in church page while it runs. It has a start and an end (or runs until ended) and is marked as Information or Important. Each person can dismiss it on their device. The operator can also email it once to every active church's admins. **End now** and **Delete** are on the list. Churches see changes within a minute. Creating, ending and deleting are logged.
- Platform › church page › Users › **Help**: support tools for each user of a church.
  - **Password reset link:** email it, text it, or show it to the operator to pass on (e.g. by WhatsApp to someone who signs in with a phone). It works once, within an hour.
  - **Unlock** an account locked by wrong passwords.
  - **Resend** the email-verification link.
  - **Change how they sign in** (email and/or phone), with the same checks as the church's own Users & Roles.
  
  Each action is written to the church's own security log as "Platform support: …", and to the platform audit log.
- Platform › Overview › **Growth · last 12 months**: church sign-ups and Pro upgrades per month as paired bars, with the 12-month totals, churches deleted and the upgrade rate, plus the numbers in a table. An upgrade is counted once per church per month, from either the console's upgrade record or the church's Pro start date, so earlier upgrades count too.
- **Trial enquiries.** The marketing site's "Request demo" form now posts to Church Manager (`POST /enquiry`) instead of Formspree. Each request is saved, and the operators get an email (`ALERT_EMAIL` / `PLATFORM_ADMIN_EMAILS`) with a link to it. The person sees a thank-you page with a link back to the website. Bots are kept out by a hidden field and a limit of 5 requests an hour per address. Platform › **Trial enquiries** lists them newest first, with New, Contacted, Converted and Declined tabs, counts and the conversion rate. For each enquiry, the operator can call, WhatsApp, or email a sign-up link, keep notes, change the status, and link the church once it signs up (which marks it converted). Status changes are logged.
- Platform › **Churches at risk**: every active church's last sign-in, last activity (anything staff did in the app) and setup (members, events, staff). Two lists: **Quiet for 30 days or more** (no sign-in and no activity) and **Never got started** (signed up a week or more ago, fewer than 5 members). Each shows the first admin's name with Call, WhatsApp and Email links. Last sign-in comes from the security log, so sign-ins from before today count. The Overview counts churches at risk. Each church's console page shows every user's last sign-in, which is now recorded on each successful sign-in (`users.last_login_at`).
- **SMS allowances.** Each church may send a number of texts per calendar month: Free 100, Pro 2,000 (`lib/plan.js`). The platform operator can set a different number for any church on Platform › SMS. A send that would go over is refused whole, never half-sent, with a message that says how many are used and left. In a broadcast, the SMS recipients are marked failed with that reason. Texts the platform sends a church, such as Pro renewal reminders, are neither counted nor limited. Church admins see "N of M texts, K left" under Communications › SMS delivery. The broadcast page warns when under a tenth is left, and says so when none are.
- Platform › SMS › **Texts in [month]**: every church's texts and pages (160-character parts, 70 for Ghanaian letters like ɛ and ɔ or emoji) for any of the last 12 months, against its allowance, with a box to set or clear each church's own allowance. Changes are logged.
- Platform › **SMS**: the SMS account's balance (mNotify or Arkesel), checked every hour and on **Check now**, with the provider's last reply for reference. When it falls below the alert level (default 200, set on the page or by `SMS_BALANCE_ALERT_BELOW`), operators are alerted by email, webhook and Sentry (as configured), and by text to `ALERT_PHONE` if set. The alert goes once, then daily while the balance stays low; topping up above the level clears it. A failed check keeps the last good figure and shows why. The Overview tab shows the balance too, marked when low. The operator alert email's subject now matches the alert, instead of always reading "backup failure".
- Platform › **Payments**: record what a church paid for its plan, with amount, date, method (Mobile Money, bank, cash or other), reference, months covered and a note. Ticking **Extend their Pro plan** extends Pro from its current end. The page shows revenue this month, last month, this year and all time, a bar chart of the last 12 months, every payment, totals per church, and **Lapsed, not renewed**: Pro plans that ended in the last 60 days, each with a button to record its payment. A mistaken record can be deleted; the church's plan is left as it is. Each church's console page lists its payments. Recording and deleting are logged. Payment history is kept, under the church's name, even after a church is deleted and purged. The console now has tabs: Overview and Payments.
- Platform › **Pro renewals**: Pro plans ending in the next 30 days or ended in the last 60, soonest first, with days left and the last reminder sent. **Extend** adds 1, 3, 6 or 12 months to the current end date (or from today once lapsed) and is logged. Each church's admins are reminded by email and text 14 days and 3 days before the end, and once when it lapses, each time once per end date. Extending starts the reminders afresh. Suspended and deleted churches are skipped. They run with the hourly allowance check, so they add no database wake-ups. `BILLING_CONTACT` sets the how-to-renew line, e.g. "Call or WhatsApp 024 412 7781". A lapsed plan already falls back to Free on its own; nothing is removed.
- Database for the operator portal's new features, all at once (`scripts/add-portal-features.sql`, run before deploying): Pro reminder state, SMS allowances and "view as church" columns on `churches`; `users.last_login_at`; trial follow-up columns on `trial_signups`; resolved columns on `error_log`; and new tables `platform_payments`, `sms_usage`, `platform_settings` and `platform_announcements`. Features that are not built yet leave their columns empty.
- Fixed: a browser signed in to a suspended or deleted church was stuck. Its "Access suspended" page offered Sign out, but that form had no security token, so signing out was refused and sent back to the same page. Every page, including both sign-in pages, kept showing it. Sign out now works, and the operator console (`/platform`, `/platform/login`) can always be reached, whatever church session the browser holds.
- SMS through **mNotify** as well as Arkesel. `SMS_PROVIDER` (`ARKESEL`, the default, or `MNOTIFY`) picks the provider, with `MNOTIFY_API_KEY` or `ARKESEL_API_KEY`. `SMS_SENDER_ID` is the default sender name (`ARKESEL_SENDER` is still read if it is unset). Calls to either provider now time out after 15 seconds, and a refusal reads in the provider's own words.
- Each church can have its own **SMS sender name** (Communications › Email settings › SMS delivery, admins). An admin asks for a name of 3–11 letters or numbers, e.g. DUNWELL. The platform operator registers it with the SMS provider, then approves or rejects it in the console under "SMS sender names to approve"; a rejection can give a reason, which the church sees. Only an approved name is used: until then, and for churches without one, texts go out under the default name. Broadcasts, preacher reminders, finance receipts and pledge statements, and allowance alerts all use it. The same card has **Send a test SMS**, which shows the provider's answer. Approvals and rejections are recorded in the operator and security audit logs. Database: new columns `churches.sms_sender_id`, `sms_sender_status`, `sms_sender_note` (`scripts/add-sms-sender-names.sql`, run before deploying).
- Fixed: texts sent through Arkesel could be recorded as failed even when they were delivered. The app called Arkesel's v2 address but checked for v1's reply (`"code": "ok"`); v2 answers `"status": "success"`. Both are now accepted.
- Fixed: "＋ Add Bible Class", and "＋ Add Item" and "＋ Category" on Inventory, did nothing visible. They jumped to a collapsed form further down without opening it. Such buttons now open the form, scroll to it and put the cursor in its first field.
- Help & Guide (`/help`) is back. The sidebar linked to it, but the page had been lost in the multi-church rewrite, so everyone got "Cannot GET /help". It now opens a page-by-page guide for every role, starting with "Your access": the reader's role and finance role, what they allow, and that an administrator can change them. Sections for Finance, Communications and Reports appear only with finance access, and Users & Settings only for admins.
- The installed app carries the church's own name and logo. When someone installs Church Manager while signed in, the app is named after the church (shortened for the home screen, e.g. "Dunwell" for "Dunwell Methodist Society, Koforidua"). Its icon is the logo uploaded under Settings › Church logo, drawn square on white whatever the logo's shape, with a smaller copy that Android can crop to a circle. Without a logo the icon stays Church Manager's, and signed-out visitors install the plain Church Manager app. After a logo change, Chrome updates installed icons on its own schedule (Android may ask first). iPhones keep the icon they were added with until the app is removed and added again. Icon links are signed, so one church's logo cannot be fetched by guessing another's link. New dependency: `sharp` (image resizing). No database changes.
- Install Church Manager as an app on any phone or computer. On Android, Windows, macOS, Linux and ChromeOS (Chrome, Edge, Samsung Internet), "Install app" opens the browser's own install prompt. On iPhone, iPad and Safari on a Mac, and Firefox on Android, it shows the steps for that browser (Share › Add to Home Screen, File › Add to Dock). The button is in the sidebar, in More on phones, and under the sign-in box. It shows only where installing is possible, and never inside the installed app. The installed app opens full screen from the home screen, dock or Start menu, and its title bar follows light or dark. Long-pressing the icon offers Members, Attendance and Events. When a page cannot load because the device is offline, a "You're offline" page offers Try again and reloads by itself when the connection returns. Church pages are never stored on the device. Every page (app, sign-in, landing) now carries the manifest and registers the service worker. Previously only the Allowances page did, for notifications. No database changes.
- Members › Import (admins): add members from a CSV or Excel file (.csv, .xlsx, .xls, .ods; up to 5,000 rows, 5 MB). Columns are matched automatically from their names (Name or First name/Surname, Sex, D.O.B, Phone, Class, Organisations and so on) and can be changed. A preview shows who will be added, who is skipped because they are already in the church or repeat an earlier row (same phone, email, or name and date of birth), and rows without a full name. Dates are read day first (12/03/1990), as well as 1990-03-12, 12 March 1990 and Excel date cells. Titles like Mr, Mrs and Rev are dropped from names. Bible classes and organisations named in the file are linked, and created if missing (optional). The file's own member IDs are kept when free. A file from Members › Export imports as it is, and a template can be downloaded. Database: new table `member_imports` (`scripts/add-member-imports.sql`, run before deploying).
- Finance › Allowances: monthly allowances for church workers. Fund managers keep a list of workers (linked to a member or just a name), each with a monthly amount, fund and expense category, and can pause or resume anyone. On the due day set on that page (or the last day of a shorter month), the app drafts one expense per active worker, "Allowance – October 2026", submitted for approval; they then go through the normal approval and payment-voucher flow. Each month is drafted once, even with several app machines or a restart, and a day missed while the app was down is caught up within three days. A fund manager can also draft the current month by hand.
- Finance has an Allowances tab, next to Reports.
- Allowance alerts: when a month is drafted, Treasurers, Finance admins and Admins get an email, a text message (to the phone they sign in with, plus any extra numbers set on the Allowances page), and a notification on each phone or computer where they turned notifications on. If any allowance is still unpaid five days later they are reminded once. The dashboard's "Needs attention" shows allowances waiting for approval. "Send me a test alert" checks every channel.
- Device notifications (Web Push): "Turn on notifications" on the Allowances page. Notifications appear through the phone's or computer's own notification system, even with the app closed, and tapping one opens the page. On iPhone and iPad the app must first be added to the Home Screen (iOS 16.4 or later); the app now has a manifest and home-screen icon for that. Needs `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`; without them the button is hidden and nothing else changes.
- Database: new tables `allowances`, `allowance_runs`, `push_subscriptions`, and new columns on `expenses` and `finance_settings` (`scripts/add-allowances.sql`, run before deploying).

### Changed

- SMS sender names may have spaces between words, e.g. "DUNWELL MC", as the SMS provider accepts them ("CHURCH MGMT" was approved). The rule is still 3–11 characters, spaces included: letters and numbers, no symbols, and no space at either end. Extra spaces are tidied when a name is requested.
- Member form: the emergency contact's Relationship is picked from a list: Spouse, Parent, Child, Sibling, Other relative, Guardian, Friend or Other. A relationship typed before the list existed ("uncle") is kept and shown as the current choice until someone picks another. A typed value that matches the list in another case ("spouse") selects that option. No database changes.
- Bible classes and organizations: "Meets" is now **Meeting days**, picked from a list of days (Sunday to Saturday) with an optional time, and saved as e.g. "Sunday, 8:00 AM". It can now be changed after creation: in each Bible class's row, and under Manage on an organization's page (it could only be set when creating them). An older free-text value such as "Saturday 5pm" is kept and shown until someone picks a day. Bible Classes shows meeting days in their own column.
- New member form: Status offers Member, Visitor, Distant, Transferred and Deceased. Members who already have Regular, Inactive or Other keep it; it stays selected on their form until changed. The Members tabs show Members, Visitors and Distant, plus Regulars and Inactive only while anyone has them. Import reads "Distant" (and "away", "abroad"). Database: new `DISTANT` membership status (`scripts/add-member-status-distant.sql`, run before deploying).
- Date of birth on the member form is a day and a month, with no year. It is shown as "14 March". A year already on file (from an import or the API) is kept and shown. 29 February works. A day without a month, or a date that doesn't exist (31 April), is refused. The members export writes a birthday without a year as "14 March", and import reads it back. Day born is not worked out from a birthday without a year.

- When someone opens a page their role doesn't include, they now get a page inside the app ("You don't have access to this") instead of a bare "Forbidden". It names their role, says an administrator can change their access on Users & Roles, and links back to the dashboard. A route's own reason, such as "This area needs finance access", is kept. An unknown address shows "Page not found" (with the menu when signed in, or Sign in when not) instead of Express's "Cannot GET". API responses are unchanged (JSON).
- Settings is in the menu for admins only. Other roles were shown it and then refused. They have Profile for their own account.
- Editors and Viewers with no finance role (Finance role: None) now see only Members, Attendance, Bible Classes and Organizations (as their role allows), plus Events, the Preaching Plan and Inventory read-only. Editors among them can still check people in and record RSVPs at events, but cannot create or edit events, enter headcounts, or change the preaching plan or inventory. Finance, Communications and Reports are hidden from their menu and refused (403) by page and API. Their dashboard shows no money, as before, and their New menu offers only New member. Admins, and anyone with a finance role, are unchanged. To give someone the wider access, set a finance role on Users & Roles.
- `scripts/platform-operator.js rename <email> --name "New Name"` changes an operator's displayed name. `create` and `rename` drop quote marks left at either end of a name (curly quotes copied into a command were being saved as part of it).
- Users & Roles: **Edit sign-in** on each user changes how they sign in: add or change their email, add or change their phone number, or remove one, as long as one is left. Their password, role and history stay as they are. An email set by an admin counts as verified. API: `PUT /api/users/:id/login`.
- Staff can sign in with a phone number. On Users & Roles › New user an admin gives an email, a phone number, or both; the sign-in box takes either ("Email or phone"). Numbers are stored as +233… (local numbers like 024 412 7781 work, as do spaces and +233/00233), and each number can belong to one account across all churches. Phone-only users reset a forgotten password through an admin (the Users list's Reset); no text messages are sent. Removing a user or deleting a church frees their number as well as their email. The Users list and the platform console show how each person signs in. Church sign-up still uses an email. Database: new `users.phone` column (`scripts/add-user-phone.sql`, run before deploying). `DEFAULT_PHONE_COUNTRY_CODE` (default 233) sets the country for local numbers.
- The Editor role can now add and edit: members (and their photos), attendance, events (including check-ins, RSVPs, counts and the QR code), Bible classes, organizations and their members, inventory, the preaching plan and announcements. Deleting or archiving, exporting member data, sending broadcasts and preacher reminders, email settings, users and church settings stay with admins. Editors' "New" menu offers New member and Schedule event. The New user page and Users & Roles describe the roles accordingly. Previously Editor was the same as Viewer.
- Platform operators are now separate accounts, not church accounts:
  - They sign in at `/platform/login` and must use two-factor; the first sign-in sets it up and shows recovery codes. Five wrong passwords lock the account for 15 minutes, and 30 minutes without activity signs them out.
  - An operator has no church and cannot open church pages; no church account can open `/platform` or `/api/platform`, whatever its email. The church sidebar no longer shows a Platform link.
  - Accounts are created and managed only on the server with `scripts/platform-operator.js` (create, list, reset-password, reset-2fa, disable, enable). There is no sign-up page.
  - Operator sign-ins and console actions are logged in a new `platform_audit_log`, shown on the console as "Operator activity". Plan and access changes still appear in the church's own audit log, now without a church user as the actor.
  - `PLATFORM_ADMIN_EMAILS` no longer grants console access, and `ALLOW_PLATFORM_ADMIN_SIGNUP` is gone; signing up or inviting a user with a listed address is no longer refused. The variable is still used as a fallback address for alert emails.
  - Database: new tables `platform_operators` and `platform_audit_log` (`scripts/add-platform-operators.sql`, run before deploying).

- New "Precision" look for the signed-in app, stage 1 of 3 (shell and dashboard). A light sidebar with grouped sections, a top bar with breadcrumbs, a "New" menu and a light/dark switch, and a ⌘K / Ctrl K search over pages, actions, members and events. It replaces the Material You theme (`public/theme-material.css` removed; `public/theme-precision.css` and `public/app-theme.js` added). The colour picker is gone; the light/dark choice carries over. Cards, buttons, forms, tables and badges on every page use the new style. The sign-in and landing pages are unchanged for now.
- The dashboard has four key figures with trend lines, giving by type over 12 weeks or 12 months, what needs your attention, birthdays in the next 7 days (with a Wish shortcut to a one-person SMS for admins), attendance over the last 12 full weeks, upcoming events with the membership mix, and recent activity. Giving now comes from the finance ledger, so it matches the Finance page (it used to count general income records only).
- Platform operators see the Platform link in the sidebar again.
- Stat tiles on every other page (Attendance, Events, Members, Finance sub-pages, Inventory and the rest) now match the key figures: label above the number, the number at the same size, and a tinted icon chip in the top-right corner in the same colour order (violet, teal, gold, rose, sky). On phones the icons show too (they were hidden), and an old phone-only style that gave the tiles a grey gradient and a side bar no longer applies.
- Key figures on the dashboard and the Finance overview show a small tinted icon in each figure's colour (people, check-ins, money, new visitors; income, expenses, net, funds) instead of a short coloured bar along the top. Fund cards and the stat tiles on other pages lose their top bar too; their icons already carry the colour. The dashboard's trend lines move to the bottom-right corner.
- Phones now follow iOS 26's own look, matched against system apps in light and dark mode:
  - The tab bar and buttons use a light veil with a small blur, a hairline edge and a soft shadow; in dark mode, smoky dark glass.
  - Labels and icons are plain black or white with no glow, and the current tab sits in a soft grey pill.
  - The top bar is gone: the page title sits centred over a fade of the page colour, and search is a round glass button.
  - The New button is a round glass button with just a plus.
- On phones the More and New sheets are Liquid Glass too: frostier than the bars so every label stays easy to read, with the page's colours glowing through, the same bright rim and highlight, glassy tile icons, and a lighter backdrop behind the sheet.
- On phones the top bar is now a floating clear-glass capsule matching the tab bar, with the page scrolling underneath; the thin brand stripe is hidden on phones so it doesn't sit above the capsule.
- The phone tab bar and New button are now clear glass, closer to iOS 26: almost no tint and a light blur so the page shows through, a bright rim and edge glow for the shape, and a soft glow behind the labels and icons so they stay readable over any content.
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

- Users & Roles: role labels were pale gold on pale gold; they are now Admin (violet), Editor (teal) and Viewer (grey) pills. The actions column gives the role and finance pickers and the password box room (they were squeezed to a letter or two).
- Platform console: long church names ran into the Plan column; they wrap now.
- Creating a user with the username of someone removed earlier said "username already taken". Removing a user now frees their username as well as their email and phone, and a username still held by a user removed before this fix is freed when it is reused.
- Deleting a church from the platform console now frees its users' login emails straight away (emails are unique across all churches, so a deleted church used to keep them taken for 30 days). Restoring the church gives them back, except any another account has claimed meanwhile, which the console lists.
- Clearer messages:
  - A form opened before you last signed in or out (for example in another tab) used to end on a bare "Security check failed" page. It now returns you to the form and explains why nothing was saved.
  - Adding a user whose email is taken says whether it is already a user in your church or belongs to an account in another church.
- Desktop:
  - The Show/Hide button in password fields (New user, profile) sat below the field; it is inside the field again.
  - Finance › Services: the 7-day day-born breakdown forced the form wide and pushed Service type off the page.
  - Finance reports: the filter row ran off the page on smaller laptops (1024px), and the selected report tab was purple text on purple.
  - Labels in forms that are not standard form blocks (the broadcast audience picker, report filters) were still in the old all-caps style.
- Signed-out pages (sign in, sign up, password reset, two-factor, the outage page) showed one church's name, from the `CHURCH_NAME` setting, to everyone. They now show the product name, Church Manager. QR check-in, RSVP and unsubscribe pages, which belong to one church, show that church's own name.
- Security (tenant isolation): a church admin could record an event check-in or RSVP for another church's member by sending that member's id, and the event page then showed the other church's member's name. The event forms now check that the event and member are their own church's. More broadly, every write through the church-scoped database client now checks each id it links to (scalar ids, nested `connect` and nested `create`, inside transactions too) and refuses a link to another church's row as "Not found". `scripts/check-cross-church-links.js` reports any existing cross-church links (read-only; every count should be 0).
- Phones:
  - Typing in the search dialog showed a tinted box between the search icon and Esc (the app's field border and focus ring); the field is now plain text.
  - Tapping a member sometimes opened the summary card over the whole screen. Its height was set in `vh`, which in iPhone Safari can be taller than the visible area while the toolbars show. The card now stops 64px below the top of the screen; the More sheet and the Members filter sheet use the visible height (`dvh`) too.
  - The collapsible "Record …" forms (Finance, Inventory, Preaching, Bible Classes and others) were a pill with a small grey button inside; they are now cards with a full-width header and a chevron.
- The search dialog is frosted glass, and the More and New sheets are much clearer glass.
- The phone tab bar and New button are much clearer too (about a fifth white instead of half), with a faint halo behind labels and icons so they stay readable.
- iPhone (iOS 26 Safari):
  - Safari's toolbars turned dark grey on light pages. A hidden full-screen backdrop (opacity 0) and the closed Members filter sheet were still on the page, and Safari tints its toolbars from those. Both are now fully hidden while closed.
  - Ghost copies and streaks still appeared under the top area while scrolling. The round top buttons no longer use a live blur (a frosted fill instead); Safari repaints the page wrongly under a blur inside the pinned top area.
  - The phone tab bar was hidden behind Safari's own bottom toolbar. Pages no longer extend under Safari's toolbars (`viewport-fit=cover` removed), so the bar sits above them.
  - The glass bars smeared ghost copies of the page while scrolling. The glass is now drawn on a layer inside each bar instead of on the bar itself, without the masked rim or brightness/contrast filters that Safari draws badly. This also stops Safari tinting its toolbar from the bar.
  - Tapping a text field made Safari zoom in, and the zoom carried over to the next page, cutting the layout off on the right. Fields are 16px on phones and touch screens, which Safari does not zoom, and the app clips anything wider than the screen instead of widening the page.
- Phones: the dashboard greeting buttons no longer squeeze their labels onto two lines (they wrap to a second row instead), and the Settings logo upload and the member profile no longer push the page wider than the screen on small phones.
- Members on phones: the Filters button was cut off at the right edge (search now gets its own row, with Export and Filters side by side below it), and long names and phone numbers ran out of the member card instead of trimming with an ellipsis.
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
