const { BaseError } = require('../utils/errors');

/**
 * Standard API response formatter
 */
class ResponseFormatter {
    /**
     * Success response
     */
    static success(res, data = null, message = 'Success', statusCode = 200) {
        const response = {
            success: true,
            message,
            data,
            timestamp: new Date().toISOString()
        };
        
        // Add request ID if available
        if (res.locals.requestId) {
            response.requestId = res.locals.requestId;
        }
        
        return res.status(statusCode).json(response);
    }
    
    /**
     * Created response
     */
    static created(res, data = null, message = 'Resource created successfully') {
        return this.success(res, data, message, 201);
    }
    
    /**
     * No content response
     */
    static noContent(res, message = 'No content') {
        return res.status(204).json({
            success: true,
            message,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Paginated response
     */
    static paginated(res, data, pagination, message = 'Data retrieved successfully') {
        const response = {
            success: true,
            message,
            data,
            pagination: {
                page: parseInt(pagination.page),
                limit: parseInt(pagination.limit),
                total: pagination.total,
                pages: pagination.pages,
                hasNext: pagination.page < pagination.pages,
                hasPrev: pagination.page > 1
            },
            timestamp: new Date().toISOString()
        };
        
        if (res.locals.requestId) {
            response.requestId = res.locals.requestId;
        }
        
        return res.status(200).json(response);
    }
    
    /**
     * Error response
     */
    static error(res, error, statusCode = 500) {
        let response = {
            success: false,
            error: {
                message: error.message || 'Internal server error',
                type: error.name || 'Error'
            },
            timestamp: new Date().toISOString()
        };
        
        // Add request ID if available
        if (res.locals.requestId) {
            response.requestId = res.locals.requestId;
        }
        
        // Handle operational errors
        if (error instanceof BaseError) {
            response.error.statusCode = error.statusCode;
            
            // Add additional error details for validation errors
            if (error.details) {
                response.error.details = error.details;
            }
            
            // Add service information for external API errors
            if (error.service) {
                response.error.service = error.service;
            }
            
            return res.status(error.statusCode).json(response);
        }
        
        // Handle validation errors from Mongoose
        if (error.name === 'ValidationError') {
            response.error.type = 'ValidationError';
            response.error.details = Object.values(error.errors).map(err => ({
                field: err.path,
                message: err.message,
                value: err.value
            }));
            return res.status(400).json(response);
        }
        
        // Handle MongoDB duplicate key error
        if (error.code === 11000) {
            response.error.type = 'DuplicateError';
            response.error.message = 'Resource already exists';
            return res.status(409).json(response);
        }
        
        // Handle JWT errors
        if (error.name === 'JsonWebTokenError') {
            response.error.type = 'AuthenticationError';
            response.error.message = 'Invalid token';
            return res.status(401).json(response);
        }
        
        if (error.name === 'TokenExpiredError') {
            response.error.type = 'AuthenticationError';
            response.error.message = 'Token expired';
            return res.status(401).json(response);
        }
        
        // For unexpected errors, don't expose internal details in production
        if (process.env.NODE_ENV === 'production') {
            response.error.message = 'Internal server error';
            delete response.error.stack;
        } else {
            // In development, include stack trace
            response.error.stack = error.stack;
        }
        
        return res.status(statusCode).json(response);
    }
    
    /**
     * Validation error response
     */
    static validationError(res, errors) {
        return res.status(400).json({
            success: false,
            error: {
                type: 'ValidationError',
                message: 'Validation failed',
                details: errors
            },
            requestId: res.locals.requestId,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Not found response
     */
    static notFound(res, resource = 'Resource') {
        return res.status(404).json({
            success: false,
            error: {
                type: 'NotFoundError',
                message: `${resource} not found`
            },
            requestId: res.locals.requestId,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Unauthorized response
     */
    static unauthorized(res, message = 'Authentication required') {
        return res.status(401).json({
            success: false,
            error: {
                type: 'AuthenticationError',
                message
            },
            requestId: res.locals.requestId,
            timestamp: new Date().toISOString()
        });
    }
    
    /**
     * Forbidden response
     */
    static forbidden(res, message = 'Access forbidden') {
        return res.status(403).json({
            success: false,
            error: {
                type: 'AuthorizationError',
                message
            },
            requestId: res.locals.requestId,
            timestamp: new Date().toISOString()
        });
    }
}

/**
 * Middleware to add response methods to res object
 */
const responseFormatter = (req, res, next) => {
    // Add response methods to res object
    res.success = (data, message, statusCode) => 
        ResponseFormatter.success(res, data, message, statusCode);
    
    res.created = (data, message) => 
        ResponseFormatter.created(res, data, message);
    
    res.noContent = (message) => 
        ResponseFormatter.noContent(res, message);
    
    res.paginated = (data, pagination, message) => 
        ResponseFormatter.paginated(res, data, pagination, message);
    
    res.error = (error, statusCode) => 
        ResponseFormatter.error(res, error, statusCode);
    
    res.validationError = (errors) => 
        ResponseFormatter.validationError(res, errors);
    
    res.notFound = (resource) => 
        ResponseFormatter.notFound(res, resource);
    
    res.unauthorized = (message) => 
        ResponseFormatter.unauthorized(res, message);
    
    res.forbidden = (message) => 
        ResponseFormatter.forbidden(res, message);
    
    next();
};

module.exports = {
    ResponseFormatter,
    responseFormatter
};