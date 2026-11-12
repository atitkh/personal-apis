// Error-to-JSON wrappers for route handlers. A handler is `(req, res, conn)`; the wrapper supplies the db connection.
const db = require('../../db');
const { HubError } = require('../../services/errors');

// For the admin API: a domain error (instance of `ErrorClass`) becomes { error: message, code?, ...extra? } at its own
// status; anything else is logged with `logLabel` and answers a plain 500.
//   code  -> include err.code        extra -> spread err.extra (safe ids only)
//   async -> the handler may return a promise; a rejection is handled the same way
function adminHandler(ErrorClass, logLabel, { code = true, extra = false, async = false } = {}) {
    return (fn) => (req, res) => {
        const fail = (err) => {
            if (err instanceof ErrorClass) {
                return res.status(err.status).json({
                    error: err.message,
                    ...(code ? { code: err.code } : {}),
                    ...(extra ? (err.extra || {}) : {}),
                });
            }
            console.error(logLabel, err);
            res.status(500).json({ error: 'Something went wrong.' });
        };
        try {
            const out = fn(req, res, db.get());
            if (async && out && typeof out.then === 'function') out.catch(fail);
        } catch (err) {
            fail(err);
        }
    };
}

// For /hub: any HubError becomes { error: code, message, ...extra }. A handler may be async.
const hubHandle = (fn) => (req, res) => {
    const fail = (err) => {
        if (err instanceof HubError) {
            // `extra` carries safe ids only (a duplicate flight's id), never a submitted value.
            return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
        }
        console.error('hub error:', err);
        res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
    };
    try {
        const out = fn(req, res, db.get());
        if (out && typeof out.then === 'function') out.catch(fail);
    } catch (err) {
        fail(err);
    }
};

module.exports = { adminHandler, hubHandle };
