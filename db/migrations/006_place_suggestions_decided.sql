-- Who accepted or dismissed a suggestion, and when. A dismissed street keeps its row (status dismissed), so a
-- later sighting only raises its count and never puts it back in the queue.
ALTER TABLE place_suggestions ADD COLUMN decided_at TEXT;
ALTER TABLE place_suggestions ADD COLUMN decided_by TEXT;
