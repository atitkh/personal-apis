/**
 * Base Error class for all custom errors
 */
class BaseError extends Error {
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.timestamp = new Date().toISOString();
        
        Error.captureStackTrace(this, this.constructor);
    }
    
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            statusCode: this.statusCode,
            timestamp: this.timestamp
        };
    }
}

/**
 * Validation Error - 400 Bad Request
 */
class ValidationError extends BaseError {
    constructor(message, details = null) {
        super(message, 400);
        this.details = details;
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            details: this.details
        };
    }
}

/**
 * Authentication Error - 401 Unauthorized
 */
class AuthenticationError extends BaseError {
    constructor(message = 'Authentication required') {
        super(message, 401);
    }
}

/**
 * Authorization Error - 403 Forbidden
 */
class AuthorizationError extends BaseError {
    constructor(message = 'Access forbidden') {
        super(message, 403);
    }
}

/**
 * Not Found Error - 404 Not Found
 */
class NotFoundError extends BaseError {
    constructor(resource = 'Resource') {
        super(`${resource} not found`, 404);
    }
}

/**
 * Conflict Error - 409 Conflict
 */
class ConflictError extends BaseError {
    constructor(message = 'Resource conflict') {
        super(message, 409);
    }
}

/**
 * Rate Limit Error - 429 Too Many Requests
 */
class RateLimitError extends BaseError {
    constructor(message = 'Too many requests') {
        super(message, 429);
    }
}

/**
 * Database Error - 500 Internal Server Error
 */
class DatabaseError extends BaseError {
    constructor(message = 'Database operation failed') {
        super(message, 500);
    }
}

/**
 * External API Error - 502 Bad Gateway
 */
class ExternalAPIError extends BaseError {
    constructor(service, message = 'External service unavailable') {
        super(`${service}: ${message}`, 502);
        this.service = service;
    }
    
    toJSON() {
        return {
            ...super.toJSON(),
            service: this.service
        };
    }
}

/**
 * Service Unavailable Error - 503 Service Unavailable
 */
class ServiceUnavailableError extends BaseError {
    constructor(message = 'Service temporarily unavailable') {
        super(message, 503);
    }
}

module.exports = {
    BaseError,
    ValidationError,
    AuthenticationError,
    AuthorizationError,
    NotFoundError,
    ConflictError,
    RateLimitError,
    DatabaseError,
    ExternalAPIError,
    ServiceUnavailableError
};