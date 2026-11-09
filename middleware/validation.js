const Joi = require('joi');
const { ValidationError } = require('../utils/errors');

// Generic validation middleware
const validate = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, { 
            abortEarly: false,
            stripUnknown: true 
        });
        
        if (error) {
            const details = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message
            }));
            
            throw new ValidationError('Validation failed', details);
        }
        
        req.body = value;
        next();
    };
};

// Common validation schemas
const schemas = {
    // Auth validation
    register: Joi.object({
        username: Joi.string().alphanum().min(3).max(30).required(),
        email: Joi.string().email().required(),
        password: Joi.string().min(6).required(),
        role: Joi.string().valid('user', 'admin').default('user')
    }),

    login: Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().required()
    }),

    // Phone call validation
    phoneCall: Joi.object({
        message: Joi.string().min(1).max(500).required()
    }),

    // IPO result validation
    ipoResult: Joi.object({
        companyShareId: Joi.string().required(),
        boid: Joi.string().required(),
        userCaptcha: Joi.string().required(),
        captchaIdentifier: Joi.string().required()
    })
};

module.exports = {
    validate,
    schemas
};