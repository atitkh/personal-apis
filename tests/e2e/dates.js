// Dates for the seeds and runners that stay the same distance from today as when they were written (2026-11-12),
// so "future" flights and found flights never drift into the past. Past dates are written literally and never move.
const ANCHOR = Date.parse('2026-11-12T00:00:00Z');
const rel = (canon) => new Date(Date.now() + (Date.parse(`${canon}T00:00:00Z`) - ANCHOR)).toISOString().slice(0, 10);
module.exports = { rel };
