const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Base schema with common fields for all models
 */
const baseSchemaFields = {
    createdAt: {
        type: Date,
        default: Date.now,
        immutable: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: true
    }
};

/**
 * Pre-save middleware to update 'updatedAt' field
 */
const updateTimestamp = function(next) {
    this.updatedAt = new Date();
    next();
};

/**
 * Common methods for all models
 */
const baseMethods = {
    softDelete() {
        this.isActive = false;
        return this.save();
    },
    
    restore() {
        this.isActive = true;
        return this.save();
    }
};

/**
 * Common static methods for all models
 */
const baseStatics = {
    findActive(filter = {}) {
        return this.find({ ...filter, isActive: true });
    },
    
    findActiveById(id) {
        return this.findOne({ _id: id, isActive: true });
    },
    
    countActive(filter = {}) {
        return this.countDocuments({ ...filter, isActive: true });
    }
};

module.exports = {
    baseSchemaFields,
    updateTimestamp,
    baseMethods,
    baseStatics
};