-- Links: a record in one domain can point at a record in any other ("this preference is for that trip"). One row per
-- link, shown from both ends. The old typed columns (flights.trip_id, deadlines.trip_id, place_id) stay as they are.
-- ids are text because digests are identified by kind/period. Triggers remove a record's links when the record is
-- deleted for good, so deleting never leaves a dangling link and no delete path has to remember to do it.
CREATE TABLE links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_domain TEXT NOT NULL,
    from_id     TEXT NOT NULL,
    to_domain   TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    rel         TEXT NOT NULL DEFAULT 'related' CHECK (length(rel) BETWEEN 1 AND 30),
    note        TEXT CHECK (note IS NULL OR length(note) <= 200),
    created_at  TEXT NOT NULL,
    actor       TEXT NOT NULL,
    CHECK (NOT (from_domain = to_domain AND from_id = to_id))
);
CREATE UNIQUE INDEX links_pair ON links (from_domain, from_id, to_domain, to_id, rel);
CREATE INDEX links_from ON links (from_domain, from_id);
CREATE INDEX links_to ON links (to_domain, to_id);

CREATE TRIGGER links_gone_deadlines AFTER DELETE ON deadlines BEGIN
    DELETE FROM links WHERE (from_domain = 'deadlines' AND from_id = CAST(OLD.id AS TEXT)) OR (to_domain = 'deadlines' AND to_id = CAST(OLD.id AS TEXT));
END;
CREATE TRIGGER links_gone_preferences AFTER DELETE ON preferences BEGIN
    DELETE FROM links WHERE (from_domain = 'preferences' AND from_id = CAST(OLD.id AS TEXT)) OR (to_domain = 'preferences' AND to_id = CAST(OLD.id AS TEXT));
END;
CREATE TRIGGER links_gone_places AFTER DELETE ON places BEGIN
    DELETE FROM links WHERE (from_domain = 'places' AND from_id = CAST(OLD.id AS TEXT)) OR (to_domain = 'places' AND to_id = CAST(OLD.id AS TEXT));
END;
CREATE TRIGGER links_gone_flights AFTER DELETE ON flights BEGIN
    DELETE FROM links WHERE (from_domain = 'flights' AND from_id = CAST(OLD.id AS TEXT)) OR (to_domain = 'flights' AND to_id = CAST(OLD.id AS TEXT));
END;
CREATE TRIGGER links_gone_trips AFTER DELETE ON trips BEGIN
    DELETE FROM links WHERE (from_domain = 'trips' AND from_id = CAST(OLD.id AS TEXT)) OR (to_domain = 'trips' AND to_id = CAST(OLD.id AS TEXT));
END;
CREATE TRIGGER links_gone_lifelog AFTER DELETE ON lifelog_episodes BEGIN
    DELETE FROM links WHERE (from_domain = 'lifelog' AND from_id = CAST(OLD.id AS TEXT)) OR (to_domain = 'lifelog' AND to_id = CAST(OLD.id AS TEXT));
END;
CREATE TRIGGER links_gone_digests AFTER DELETE ON digests BEGIN
    DELETE FROM links WHERE (from_domain = 'digests' AND from_id = OLD.kind || '/' || OLD.period) OR (to_domain = 'digests' AND to_id = OLD.kind || '/' || OLD.period);
END;
