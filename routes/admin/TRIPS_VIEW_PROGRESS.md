# Trips dashboard page (stage 3): progress

## Done
- `routes/admin/public/views/trips.js`: Upcoming / Ongoing / Past tabs (cancelled in Past), cards, Suggestions panel
  (rename, Accept, Dismiss, Show dismissed again, home-airport note), New trip drawer (`?new=1`), trip drawer
  (edit with cancelled toggle, flights link/unlink picker, deadlines read only, items inline CRUD with Show reference,
  history with Compare/Restore, Delete permanently through deleteDialog).
- Wiring: route + nav (app.js), `g t` (shortcuts.js), `trips` icon (ui.js), skeleton, palette (New trip action, one entry
  per trip), minimal `.trip-*` rules at the end of style.css. Activity labels already existed (stage 1/2).
- `tests/adminTripsView.test.js` (6 tests). Module parse coverage comes from admin.test.js (it lists views/).

- Browser flow `tests/e2e/run-trips.mjs` + `trips-seed.js` (+ `trips` in run-all.mjs and the README): 20 checks pass
  (tabs and counts, cards, suggestion dismiss/restore/accept, create, link/move/unlink a flight, items with Show
  reference, edit, history restore, cancelled toggle, delete with unassign, activity, palette, 390 px).
- Full jest: 51 suites, 712 tests passed. Bug found by the flow and fixed: the create bodies used Object.fromEntries on a
  key list without mapping to pairs.

## Next
- Stage 4: review, deploy, push (nothing deployed or pushed here).
