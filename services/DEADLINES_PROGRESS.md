# Deadlines backend (stage 2 of the briefing / deadlines / preferences plan)

Dates Atit must not miss: documents, insurance, licences, subscriptions, memberships, bills, casual tasks. Plan:
`workspace/memory/projects/personal-hub-briefing-renewals-plan.md` section 2. Template: the flights domain.

## Done
- Migration `011_deadlines.sql`: `deadlines`, `deadline_revisions` (rev 1 immutable, restore is a new revision). CHECKs for kind,
  dates (GLOB), repeat (n only with every_n_months), windows 0..730 with urgent <= lead, status, cycle. `trip_id` is a plain
  integer, no foreign key (a future trips domain owns it).
- `services/deadlines.js`: create, get, list, upcoming, history, update, done, end, restore, stats, shape, nextDue, daysLeft.
- REST `/hub/deadlines`, admin API `/admin/api/deadlines`, MCP tool `deadlines`, domain registry entry, briefing hook
  (`briefingHooks.deadlines`), scope text, audit actions and Activity lists (dashboard Activity chip "Deadlines").
- Tests: deadlines, deadlinesHub, adminDeadlines, mcpDeadlines, deadlines hook block in briefing.test.js.

## Next
- Stage 4 (Preferences / renewals plan): see the plan card. The Deadlines dashboard is described below.

## API
- Scopes: `deadlines:read` (list, upcoming, get, history), `deadlines:write` (REST create, patch, done, end, restore; also needs
  read, as flights), `deadlines:edit` (MCP add, edit, done, end in write mode). No suggest scope.
- REST: `GET /hub/deadlines` (kind, status [active default | done | ended | all], due_before, due_after [inclusive],
  overdue=true, q, limit <= 200, offset; soonest first), `GET /upcoming?days=60`, `GET /:id[?rev=]`, `GET /:id/history`,
  `POST /`, `PATCH /:id`, `POST /:id/done`, `POST /:id/end`, `POST /:id/restore {rev}`. 503 when the domain is off.
- Admin (session + X-Requested-With on changes): same paths under `/admin/api/deadlines`, list and upcoming carry `reference`;
  `GET /:id` adds `history`. Works while the domain is off.
- MCP `deadlines`: read `list`, `get` (include_reference=true), `upcoming` (days default 60); write mode + deadlines:edit
  `add`, `edit` (status only `active`, to reopen), `done`, `end`. Results are marked as stored data. Restore is REST/admin only.
- Item fields: id, title, kind, due_date, due_time, repeat_kind, repeat_n, lead_days, urgent_days, status, next_due, days_left,
  overdue, window (urgent | attention | later | null), issuer, amount_cents, currency, cycle, auto_renew, cancel_by, trip_id,
  notes, done_at, rev, created_at, updated_at, updated_by, and `reference` (full shape) or `has_reference: true`.

## Rules
- Dates are local dates, "today" is the DIGEST_TZ date (default America/Chicago). Overdue = active and due_date < today.
- Window: urgent if overdue or days_left <= urgent_days; attention if <= lead_days; else later. Defaults 14 / 3.
- `done` on a repeating item: new due date = first occurrence after the current due date that is not before today (yearly +12
  months, monthly +1, every_n_months +n), month-end clamped (Jan 31 -> Feb 28). Occurrences are counted k * step from the
  date being closed, so the day does not drift (Jan 31 monthly caught up in April gives Apr 30, then May 31). Status stays
  active, `done_at` stamped, revision note "Done, next due <date>", `cancel_by` keeps its day gap. `done` on repeat none sets
  status done (revision note "Done"). `done` on a done or ended item is 409 `not_active`. `end` sets ended, nothing deleted.
- Money fields (amount_cents, currency, cycle, auto_renew, cancel_by) only for subscription, membership, bill: other kinds get
  400 `money_not_allowed`. amount_cents needs a currency. Changing kind away from a money kind needs the fields cleared.
- Privacy: `reference` is in full-shape answers only (REST `GET /:id`, admin API). Lists, `/upcoming`, history rows, MCP and the
  briefing never carry it. Revisions store it; `get(id, {rev})` shows it only to full readers. Audit rows (deadline_created,
  _updated, _done, _ended, _restored) hold id, title, rev and field NAMES (and next_due for done), never values.
  Briefing text has the title and dates only, never reference, amount or notes.
- Briefing: overdue -> urgent `deadlines:<id>:due-<date>:overdue`; inside urgent window -> urgent; inside lead window ->
  attention (both in `attention`); else due inside the briefing horizon -> info in `upcoming`. Ids `deadlines:<id>:due-<date>`.

## Checks
- Whole jest suite (26 suites): 454 tests green (baseline 390, +64 for deadlines). Run in /tmp/pa-flights with docker node:20, not on the NFS mount.

## Deadlines dashboard (stage 3)
- Files: `routes/admin/public/views/deadlines.js` (the view), registration in `app.js` (route, nav badge, palette), `shortcuts.js`,
  `skeletons.js`, `ui.js` (icon `deadlines`, `DOMAIN_HUES.deadlines = 'rose'`), `style.css` (`--rose` light #C23B63, dark #F08AA6,
  `.hue-rose`, the deadlines block at the end), `shell.js` (badge screen-reader word), `views/overview.js` (write warning, link).
- Routes: `#/deadlines` (Upcoming), `?tab=all`, `?tab=done`, `#/deadlines/<id>` (drawer), `?new=1` (Add drawer; the palette uses it).
  Filters in the URL: `kind`, `q`, `overdue=1` (Upcoming), `status` (All).
- Shortcut is `g r` (not `g d`: that is Digests). Nav badge = active items whose window is urgent (overdue included).
  Palette: actions "Add deadline", "Deadlines due soon", one entry per active deadline (title, kind and date only).
- Data: three admin calls per render (active, done, ended; done and ended are `limit=1` on Upcoming, only the counts). Client-side
  filtering. Active items cap at 200 (the API limit); a note shows when more exist.
- Rows: title (+ issuer), kind chip, due date and "in 12 days / due today / overdue by 3 days", window chip (Later neutral, Soon
  amber, Urgent red, Overdue solid red), repeat text, amount per cycle for items with money fields; Done and Edit (Reopen and Open
  on done or ended items). Done on a repeating item toasts "Next due <date>", on a one-off it moves to the Done tab.
- Drawer form: fields by kind (money group only for subscription, membership, bill), start warning and urgent days prefilled by
  kind (document 90/14, licence 60/14, insurance 30/7, subscription 7/3, membership 14/3, bill 7/2, task 7/2, other 7/2) until
  the person edits either number; live sentence under them. Reference is a password input with a Show toggle. Editing sends only
  changed fields; fields that stop applying (repeat N, money fields after a kind change) are sent as null. API errors are shown
  inline and the field named by the error code is focused. Drawer also has status chips, Done, End (confirm), Reopen, History with
  Compare and Restore. There is no delete.
- Subscriptions strip (Upcoming): active subscription, membership and bill items with amount and currency; per month = weekly
  x 52/12, monthly, quarterly / 3, yearly / 12, one line per currency, next 3 renewals, "Planned amounts, not payments."; items
  with an amount but no cycle are left out of the total and counted in a note.
- Overview: the Deadlines channel row comes from the domain registry (rose, power switch, mode selector); briefing items with
  `ref.domain` deadlines link to `#/deadlines/<id>`.
- Browser checks: scratch hub (see FLIGHTS_PROGRESS.md), seed `tmp/hub-flights-e2e/deadlines-seed.js` (invented items relative to
  today), `SEED=deadlines-seed.js ./reset.sh`, then `node run-deadlines.mjs`: 26 checks, 26 pass (tabs and counts, window chips,
  relative dates, privacy of reference and notes in the list DOM, strip numbers, filters, Done rolling a yearly item, Done on a
  one-off, Reopen, Add drawer fields and live sentence, validation, create, mask and reveal, edit, history restore and compare, End
  and Reopen, no delete, overview channel and briefing link, palette, `g r`, dark rose, 390 px, no console errors).
- Whole jest suite: 26 suites, 454 tests green (no new API behaviour, so no new tests; the admin-modules test picks up the new view).
