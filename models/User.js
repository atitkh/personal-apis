const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { baseSchemaFields, updateTimestamp, baseMethods, baseStatics } = require('./base');
const { ValidationError } = require('../utils/errors');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        minlength: [3, 'Name must be at least 3 characters long'],
        maxlength: [50, 'Name cannot exceed 50 characters']
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters long'],
        select: false // Don't include password in queries by default
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    profile: {
        avatar: String,
        bio: {
            type: String,
            maxlength: [500, 'Bio cannot exceed 500 characters']
        },
        website: {
            type: String,
            match: [/^https?:\/\/.+/, 'Please enter a valid URL']
        }
    },
    preferences: {
        notifications: {
            type: Boolean,
            default: true
        },
        theme: {
            type: String,
            enum: ['light', 'dark', 'auto'],
            default: 'auto'
        }
    },
    lastLoginAt: Date,
    loginAttempts: {
        type: Number,
        default: 0
    },
    lockUntil: Date,
    ...baseSchemaFields
}, {
    timestamps: true,
    toJSON: {
        transform: function(doc, ret) {
            delete ret.password;
            delete ret.__v;
            return ret;
        }
    }
});

// Add base methods and statics
userSchema.methods = { ...userSchema.methods, ...baseMethods };
userSchema.statics = { ...userSchema.statics, ...baseStatics };

// Pre-save middleware
userSchema.pre('save', updateTimestamp);

// Hash password before saving
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    
    try {
        const salt = await bcrypt.genSalt(12);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Instance methods
userSchema.methods.comparePassword = async function(candidatePassword) {
    if (!this.password) {
        throw new ValidationError('Password not available for comparison');
    }
    return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.updateLastLogin = function() {
    this.lastLoginAt = new Date();
    this.loginAttempts = 0;
    this.lockUntil = undefined;
    return this.save();
};

userSchema.methods.incrementLoginAttempts = function() {
    this.loginAttempts += 1;
    
    // Lock account after 5 failed attempts for 2 hours
    if (this.loginAttempts >= 5) {
        this.lockUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
    }
    
    return this.save();
};

userSchema.methods.isLocked = function() {
    return this.lockUntil && this.lockUntil > Date.now();
};

// Static methods
userSchema.statics.findByEmail = function(email) {
    return this.findOne({ email: email.toLowerCase(), isActive: true });
};

userSchema.statics.findByEmailWithPassword = function(email) {
    return this.findOne({ email: email.toLowerCase(), isActive: true }).select('+password');
};

// Indexes for performance
userSchema.index({ email: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ isActive: 1 });

module.exports = mongoose.model('User', userSchema);