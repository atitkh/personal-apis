// Guards a route with an API key: `Authorization: Bearer pak_...` or `x-api-key: pak_...`.
//   router.get('/get', requireScope('attendance:read'), handler)
const db = require('../db');
const apiKeys = require('../services/apiKeys');

function extractKey(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    return (m ? m[1] : req.get('x-api-key') || '').trim();
}

function requireScope(scope) {
    return (req, res, next) => {
        const token = extractKey(req);
        if (!token) {
            return res.status(401).json({ error: 'Unauthorized', message: 'An API key is required' });
        }
        let key;
        try {
            key = apiKeys.verify(db.get(), token);
        } catch (err) {
            return res.status(503).json({ error: 'Unavailable', message: 'Key store unavailable' });
        }
        if (!key) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or revoked API key' });
        }
        if (!apiKeys.hasScope(key.scopes, scope)) {
            return res.status(403).json({ error: 'Forbidden', message: `This key lacks the "${scope}" scope` });
        }
        req.apiKey = key;
        next();
    };
}

module.exports = { requireScope, extractKey };
