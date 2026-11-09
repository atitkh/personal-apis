// Refuses requests for a domain the operator has switched off. Place it after authentication.
const db = require('../db');
const domains = require('../services/domains');

function requireDomain(name) {
    return (req, res, next) => {
        let conn;
        try { conn = db.get(); } catch (err) { conn = null; }
        // No readable database: the declared default applies (see domains.isEnabled).
        const on = conn ? domains.isEnabled(conn, name) : domains.REGISTRY[name].defaultEnabled;
        if (on) return next();
        res.status(503).json({ error: 'domain_disabled', message: `The ${name} domain is switched off.` });
    };
}

module.exports = { requireDomain };
