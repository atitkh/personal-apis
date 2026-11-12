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

## Next (stage 3, dashboard; nothing here yet)
- Deadlines view (Upcoming, All, Done), add/edit drawer, history and restore, subscriptions strip. Register in `public/app.js`.
- Not done on purpose: icon in `ui.js`, `DOMAIN_HUES` (rose), `WRITE_WARNING.deadlines` in `views/overview.js`, `g r` shortcut,
  command palette entries, Overview "Upcoming" text. Unknown domains already fall back to spare colours and generic text.
- Overview Today card links: `views/overview.js` maps briefing item `ref` to a route; add `deadlines` there.

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
