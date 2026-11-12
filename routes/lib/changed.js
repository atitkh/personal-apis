// "Answer with the result, and audit it unless nothing changed". `auditDetail(result)` is the domain's own detail shaper.
const audit = require('../../services/audit');

// A person at the dashboard: audited as `admin`.
const adminChanged = (auditDetail) => (req, res, conn, action, result, status = 200) => {
    if (result.status !== 'unchanged') audit.record(conn, 'admin', action, auditDetail(result), req.ip);
    res.status(status).json(result);
};

// An API key on /hub: audited under the key's name with its id as detail.key_id.
const keyChanged = (auditDetail) => (req, res, conn, action, result, status = 200) => {
    if (result.status !== 'unchanged') audit.recordKey(conn, req.apiKey, action, auditDetail(result), req.ip);
    res.status(status).json(result);
};

module.exports = { adminChanged, keyChanged };
