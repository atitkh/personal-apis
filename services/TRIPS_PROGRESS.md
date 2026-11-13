# Trips domain: progress

Plan: `~/.openclaw/workspace/memory/projects/personal-hub-trips-plan.md` (decisions 1-9, stages 1-4).

## Stage 1 (core): done, local commits only
- Migration `017_trips.sql`: `trips` gains destination, kind (leisure, conference, research, family, work, other),
  status_override (null or cancelled), current_rev; `trip_revisions` (rev 1 backfilled for every existing trip,
  source `migration`); `trip_items`; `trip_suggestion_dismissed`. Ids and flights/deadlines links unchanged.
- `services/trips.js`: build/validate, list (phase, year, limit/offset; computed phase, days_to_start, days_left,
  nights, flight_count, route, distance_km, item_count), get (flights without booking references, has_booking_ref;
  deadlines id/title/kind/due_date/status/days_left), create/update/restore/history, linkFlight (moves a flight from
  another trip and says so) / unlinkFlight (each is a flight revision too), removalPreview/remove (same rules as the
  old flights trip delete: confirm, trip_in_use unless unassign: true; items go).
- `services/flights.js`: listTrips, getTrip, createTrip, updateTrip, buildTrip, cleanTrip, tripRemovalPreview,
  removeTrip, tripRemovedAuditDetail call trips.js (errors re-thrown as FlightError, old fields only, old answer
  shapes). New export `tripFlights`. The delete preview now also counts `items`.
- `services/deadlines.js`: trip_id must name an existing trip when it changes (bad_trip, 404); restore drops a trip
  that is gone. One deadlines test changed on purpose (it asserted the old "any number" rule).
- Domain registry entry `trips` (private, no briefing hook yet, no MCP tool yet: the board shows "No agent tool yet").
- REST `/hub/trips` (trips:read, trips:api-write): list, get, history, create, patch, restore,
  POST /:id/flights {flight_id}, POST /:id/flights/:flightId/unlink (a POST: /hub has no DELETE routes at all).
- Admin API `/admin/api/trips`: list, get (+history), create, patch, history, restore, link, DELETE unlink,
  delete-preview, DELETE (confirm, unassign, backup). Old /admin/api/flights/trips routes unchanged.
- Audit actions trip_created, trip_updated, trip_restored, trip_flight_linked, trip_flight_unlinked, trip_deleted;
  activity labels and a Trips activity filter; Keys catalogue entries for trips:read/agent-write/api-write.
- Tests: tests/trips.test.js, tests/tripsHub.test.js, tests/adminTrips.test.js; route snapshot regenerated.

## Next
- Stage 2: items service + REST + admin API, `suggest` (+ accept/dismiss admin API), MCP tool `trips`, briefing hook,
  overview WRITE_WARNING text, items in the trip detail.
- Stage 3: dashboard Trips page. Stage 4: review, deploy, push.
