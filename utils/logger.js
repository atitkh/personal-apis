const winston = require('winston');
const crypto = require('crypto');
const config = require('../config');

/**
 * Custom log format
 */
const logFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
    winston.format.printf(({ level, message, timestamp, requestId, userId, ...meta }) => {
        let logMessage = `${timestamp} [${level.toUpperCase()}]`;
        
        if (requestId) {
            logMessage += ` [${requestId}]`;
        }
        
        if (userId) {
            logMessage += ` [User: ${userId}]`;
        }
        
        logMessage += ` ${message}`;
        
        if (Object.keys(meta).length > 0) {
            logMessage += ` ${JSON.stringify(meta)}`;
        }
        
        return logMessage;
    })
);

/**
 * Create logger instance
 */
const logger = winston.createLogger({
    level: config.get('LOG_LEVEL'),
    format: logFormat,
    defaultMeta: { service: 'personal-apis' },
    transports: [
        // Write to console
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        })
    ]
});

// Add file transports for production
if (config.isProduction()) {
    logger.add(new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5
    }));
    
    logger.add(new winston.transports.File({
        filename: 'logs/combined.log',
        maxsize: 5242880, // 5MB
        maxFiles: 5
    }));
}

/**
 * Middleware to add correlation ID and logging
 */
const requestLogger = (req, res, next) => {
    // Generate unique request ID
    const requestId = crypto.randomUUID();
    req.correlationId = requestId;
    req.requestId = requestId;
    res.locals.requestId = requestId;
    
    // Extract user ID from token if available
    const userId = req.user ? req.user._id : null;
    
    // Start time for response time calculation
    const startTime = Date.now();
    
    // Log incoming request
    logger.info('Incoming request', {
        requestId,
        userId,
        method: req.method,
        url: req.url,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        headers: {
            'content-type': req.get('Content-Type'),
            'authorization': req.get('Authorization') ? '[REDACTED]' : undefined
        }
    });
    
    // Override res.json to log response
    const originalJson = res.json;
    res.json = function(data) {
        const responseTime = Date.now() - startTime;
        
        // Log response
        logger.info('Outgoing response', {
            requestId,
            userId,
            statusCode: res.statusCode,
            responseTime: `${responseTime}ms`,
            contentLength: JSON.stringify(data).length
        });
        
        // Call original json method
        return originalJson.call(this, data);
    };
    
    // Log response when request finishes
    res.on('finish', () => {
        const responseTime = Date.now() - startTime;
        
        // Log level based on status code
        let logLevel = 'info';
        if (res.statusCode >= 400 && res.statusCode < 500) {
            logLevel = 'warn';
        } else if (res.statusCode >= 500) {
            logLevel = 'error';
        }
        
        logger.log(logLevel, 'Request completed', {
            requestId,
            userId,
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            responseTime: `${responseTime}ms`
        });
    });
    
    next();
};

/**
 * Error logging middleware
 */
const errorLogger = (error, req, res, next) => {
    const requestId = req.requestId;
    const userId = req.user ? req.user._id : null;
    
    // Log error with context
    logger.error('Request error', {
        requestId,
        userId,
        method: req.method,
        url: req.url,
        error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
            statusCode: error.statusCode || 500
        }
    });
    
    next(error);
};

/**
 * Custom logger methods for different contexts
 */
const customLogger = {
    /**
     * Log authentication events
     */
    auth: (message, data = {}) => {
        logger.info(`[AUTH] ${message}`, data);
    },
    
    /**
     * Log database operations
     */
    database: (message, data = {}) => {
        logger.info(`[DATABASE] ${message}`, data);
    },
    
    /**
     * Log external API calls
     */
    external: (message, data = {}) => {
        logger.info(`[EXTERNAL] ${message}`, data);
    },
    
    /**
     * Log security events
     */
    security: (message, data = {}) => {
        logger.warn(`[SECURITY] ${message}`, data);
    },
    
    /**
     * Log performance metrics
     */
    performance: (message, data = {}) => {
        logger.info(`[PERFORMANCE] ${message}`, data);
    },
    
    /**
     * Generic info logging
     */
    info: (message, data = {}) => {
        logger.info(message, data);
    },
    
    /**
     * Generic warning logging
     */
    warn: (message, data = {}) => {
        logger.warn(message, data);
    },
    
    /**
     * Generic error logging
     */
    error: (message, error = null, data = {}) => {
        const logData = { ...data };
        if (error) {
            logData.error = {
                name: error.name,
                message: error.message,
                stack: error.stack
            };
        }
        logger.error(message, logData);
    }
};

module.exports = {
    logger,
    requestLogger,
    errorLogger,
    customLogger
};