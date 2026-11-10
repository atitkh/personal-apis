-- A found flight can already be known to be cancelled or completed (a cancellation mail, say). NULL means
-- automatic, like a flight's status 'scheduled'. Accepting a candidate passes it on as the flight's status.
ALTER TABLE flight_candidates ADD COLUMN flight_status TEXT CHECK (flight_status IN ('cancelled', 'completed'));
