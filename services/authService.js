const User = require('../models/User');
const { 
    ValidationError, 
    AuthenticationError, 
    NotFoundError, 
    ConflictError,
    DatabaseError 
} = require('../utils/errors');
const jwt = require('jsonwebtoken');
const config = require('../config');

class AuthService {
    /**
     * Register a new user
     */
    async register(userData) {
        try {
            const { name, email, password } = userData;
            
            // Check if user already exists
            const existingUser = await User.findByEmail(email);
            if (existingUser) {
                throw new ConflictError('User with this email already exists');
            }
            
            // Create new user
            const user = new User({ name, email, password });
            await user.save();
            
            // Generate token
            const token = this.generateToken(user._id);
            
            return {
                user: user.toJSON(),
                token
            };
        } catch (error) {
            if (error.name === 'ValidationError') {
                throw new ValidationError('Invalid user data', error.errors);
            }
            if (error.isOperational) {
                throw error;
            }
            throw new DatabaseError('Failed to register user');
        }
    }
    
    /**
     * Login user
     */
    async login(email, password) {
        try {
            // Find user with password
            const user = await User.findByEmailWithPassword(email);
            if (!user) {
                throw new AuthenticationError('Invalid email or password');
            }
            
            // Check if account is locked
            if (user.isLocked()) {
                throw new AuthenticationError('Account is temporarily locked due to too many failed login attempts');
            }
            
            // Verify password
            const isValidPassword = await user.comparePassword(password);
            if (!isValidPassword) {
                await user.incrementLoginAttempts();
                throw new AuthenticationError('Invalid email or password');
            }
            
            // Update last login
            await user.updateLastLogin();
            
            // Generate token
            const token = this.generateToken(user._id);
            
            return {
                user: user.toJSON(),
                token
            };
        } catch (error) {
            if (error.isOperational) {
                throw error;
            }
            throw new DatabaseError('Failed to login user');
        }
    }
    
    /**
     * Get user profile
     */
    async getProfile(userId) {
        try {
            const user = await User.findActiveById(userId);
            if (!user) {
                throw new NotFoundError('User');
            }
            
            return user.toJSON();
        } catch (error) {
            if (error.isOperational) {
                throw error;
            }
            throw new DatabaseError('Failed to fetch user profile');
        }
    }
    
    /**
     * Update user profile
     */
    async updateProfile(userId, updateData) {
        try {
            const user = await User.findActiveById(userId);
            if (!user) {
                throw new NotFoundError('User');
            }
            
            // Update allowed fields
            const allowedUpdates = ['name', 'profile', 'preferences'];
            Object.keys(updateData).forEach(key => {
                if (allowedUpdates.includes(key)) {
                    if (key === 'profile' || key === 'preferences') {
                        user[key] = { ...user[key], ...updateData[key] };
                    } else {
                        user[key] = updateData[key];
                    }
                }
            });
            
            await user.save();
            return user.toJSON();
        } catch (error) {
            if (error.name === 'ValidationError') {
                throw new ValidationError('Invalid update data', error.errors);
            }
            if (error.isOperational) {
                throw error;
            }
            throw new DatabaseError('Failed to update user profile');
        }
    }
    
    /**
     * Change password
     */
    async changePassword(userId, currentPassword, newPassword) {
        try {
            const user = await User.findById(userId).select('+password');
            if (!user) {
                throw new NotFoundError('User');
            }
            
            // Verify current password
            const isValidPassword = await user.comparePassword(currentPassword);
            if (!isValidPassword) {
                throw new AuthenticationError('Current password is incorrect');
            }
            
            // Update password
            user.password = newPassword;
            await user.save();
            
            return { message: 'Password changed successfully' };
        } catch (error) {
            if (error.isOperational) {
                throw error;
            }
            throw new DatabaseError('Failed to change password');
        }
    }
    
    /**
     * Verify JWT token
     */
    verifyToken(token) {
        try {
            const jwtConfig = config.getJWTConfig();
            return jwt.verify(token, jwtConfig.secret);
        } catch (error) {
            throw new AuthenticationError('Invalid or expired token');
        }
    }
    
    /**
     * Generate JWT token
     */
    generateToken(userId) {
        const jwtConfig = config.getJWTConfig();
        return jwt.sign(
            { _id: userId },
            jwtConfig.secret,
            { expiresIn: jwtConfig.expiresIn }
        );
    }
    
    /**
     * Get all users (admin only)
     */
    async getUsers(page = 1, limit = 10) {
        try {
            const skip = (page - 1) * limit;
            const users = await User.findActive()
                .select('-password')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit);
            
            const total = await User.countActive();
            
            return {
                users,
                pagination: {
                    page,
                    limit,
                    total,
                    pages: Math.ceil(total / limit)
                }
            };
        } catch (error) {
            throw new DatabaseError('Failed to fetch users');
        }
    }
}

module.exports = new AuthService();