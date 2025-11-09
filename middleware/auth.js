const authService = require('../services/authService');
const { AuthenticationError } = require('../utils/errors');

/**
 * Enhanced auth middleware with better error handling
 */
const authenticate = async (req, res, next) => {
    try {
        const token = req.header('auth-token') || req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            return res.unauthorized('Access denied. No token provided.');
        }
        
        // Verify token
        const decoded = authService.verifyToken(token);
        
        // Check if token contains user info (new format)
        if (decoded.name && decoded.email) {
            // Use user info from JWT token (more efficient)
            req.user = {
                _id: decoded._id,
                name: decoded.name,
                email: decoded.email,
                role: decoded.role || 'user'
            };
        } else {
            // Fallback: legacy tokens without user info - fetch from database
            const user = await authService.getProfile(decoded._id);
            req.user = user;
        }
        
        next();
    } catch (error) {
        if (error instanceof AuthenticationError) {
            return res.unauthorized(error.message);
        }
        return res.error(error);
    }
};

/**
 * Admin role middleware
 */
const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.forbidden('Admin access required');
    }
    next();
};

/**
 * Optional authentication - doesn't fail if no token
 */
const optionalAuth = async (req, res, next) => {
    try {
        const token = req.header('auth-token') || req.header('Authorization')?.replace('Bearer ', '');
        
        if (token) {
            const decoded = authService.verifyToken(token);
            
            // Check if token contains user info (new format)
            if (decoded.name && decoded.email) {
                req.user = {
                    _id: decoded._id,
                    name: decoded.name,
                    email: decoded.email,
                    role: decoded.role || 'user'
                };
            } else {
                // Fallback: legacy tokens without user info - fetch from database
                const user = await authService.getProfile(decoded._id);
                req.user = user;
            }
        }
        
        next();
    } catch (error) {
        // Continue without user if token is invalid
        next();
    }
};

module.exports = {
    authenticate,
    requireAdmin,
    optionalAuth
};