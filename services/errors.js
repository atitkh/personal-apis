// An error meant for the caller: an HTTP status, a short machine code and a sentence a person can read.
// Each hub domain throws its own subclass (DigestError, PlaceError); the /hub router and the MCP registry
// turn any of them into a clean JSON error, and treat everything else as a bug (500).
class HubError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

module.exports = { HubError };
