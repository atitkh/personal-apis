// Guards a route with an API key: `Authorization: Bearer pak_...` or `x-api-key: pak_...`.
//   router.get('/get', requireScope('attendance:read'), handler)
const db = require('../db');
const apiKeys = require('../services/apiKeys');
const keyLimits = require('./keyLimits');

const tooMany = (res, seconds, message) => {
    res.set('Retry-After', String(seconds));
    return res.status(429).json({ error: 'Too many requests', message });
};

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
        const waitIp = keyLimits.blockedFor(req.ip);
        if (waitIp) return tooMany(res, waitIp, 'Too many invalid API keys from this address. Try again later.');
        let key;
        try {
            key = apiKeys.verify(db.get(), token);
        } catch (err) {
            return res.status(503).json({ error: 'Unavailable', message: 'Key store unavailable' });
        }
        if (!key) {
            keyLimits.recordFailure(req.ip);
            return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or revoked API key' });
        }
        if (scope && !apiKeys.hasScope(key.scopes, scope)) {
            return res.status(403).json({ error: 'Forbidden', message: `This key lacks the "${scope}" scope` });
        }
        const waitKey = keyLimits.takeKeyCall(key.id);
        if (waitKey) return tooMany(res, waitKey, 'This API key has made too many calls. Try again later.');
        req.apiKey = key;
        next();
    };
}

// Any live key, whatever its scopes. The route then decides per request what the key may do (/hub/mcp).
const requireKey = () => requireScope(null);

module.exports = { requireScope, requireKey, extractKey };
