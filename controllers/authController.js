const authService = require('../services/authService');
const { validate, schemas } = require('../middleware/validation');
const { AuthenticationError } = require('../utils/errors');

class AuthController {
    /**
     * Register a new user
     */
    async register(req, res, next) {
        try {
            const result = await authService.register(req.body);
            return res.created(result, 'User registered successfully');
        } catch (error) {
            next(error);
        }
    }
    
    /**
     * Login user
     */
    async login(req, res, next) {
        try {
            const { email, password } = req.body;
            const result = await authService.login(email, password);
            
            // Set token in header
            res.header('auth-token', result.token);
            
            return res.success(result, 'Login successful');
        } catch (error) {
            next(error);
        }
    }
    
    /**
     * Get current user profile
     */
    async getProfile(req, res, next) {
        try {
            const profile = await authService.getProfile(req.user._id);
            return res.success(profile, 'Profile retrieved successfully');
        } catch (error) {
            next(error);
        }
    }
    
    /**
     * Update user profile
     */
    async updateProfile(req, res, next) {
        try {
            const profile = await authService.updateProfile(req.user._id, req.body);
            return res.success(profile, 'Profile updated successfully');
        } catch (error) {
            next(error);
        }
    }
    
    /**
     * Change password
     */
    async changePassword(req, res, next) {
        try {
            const { currentPassword, newPassword } = req.body;
            const result = await authService.changePassword(
                req.user._id, 
                currentPassword, 
                newPassword
            );
            return res.success(result, 'Password changed successfully');
        } catch (error) {
            next(error);
        }
    }
    
    /**
     * Logout (client-side token removal)
     */
    async logout(req, res, next) {
        try {
            // In a more advanced setup, you might invalidate the token on the server
            return res.success(null, 'Logged out successfully');
        } catch (error) {
            next(error);
        }
    }
    
    /**
     * Get all users (admin only)
     */
    async getUsers(req, res, next) {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            
            const result = await authService.getUsers(page, limit);
            return res.paginated(result.users, result.pagination, 'Users retrieved successfully');
        } catch (error) {
            next(error);
        }
    }
}

module.exports = new AuthController();