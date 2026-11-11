// Flight data sources that the hub calls itself (pull adapters). Each module exports:
//   id        short name, also the source name in flight_observations and flight_sources ("aerodatabox")
//   label     for people ("AeroDataBox")
//   fields    the enrichable fields it can fill (flights.ENRICHABLE)
//   keyEnv    the environment variable holding its API key; unset means "not configured"
//   lookup(flight, { fetch, now })  async, NEVER throws, 10 s timeout. flight has airline_iata, flight_number,
//             dep_local_date, origin_iata, dest_iata, sched_dep, sched_arr. Answers
//             { ok, fields, source_status, error }: fields normalised (UTC ISO times, delay_min whole minutes),
//             source_status the source's own status word, error a short code (not_configured, timeout, http_500...).
// Push sources (no adapter, they POST /hub/flights/:id/observations) are listed in PUSH_SOURCES.
const aerodatabox = require('./aerodatabox');

const ADAPTERS = [aerodatabox];
const PUSH_SOURCES = [{ id: 'gmail', label: 'Gmail status mails' }];

const byId = (id) => ADAPTERS.find((a) => a.id === id) || null;
const configured = (adapter, env = process.env) => Boolean(adapter.keyEnv ? env[adapter.keyEnv] : true);
const sourceNames = () => [...ADAPTERS.map((a) => a.id), ...PUSH_SOURCES.map((s) => s.id)];

module.exports = { ADAPTERS, PUSH_SOURCES, byId, configured, sourceNames };
