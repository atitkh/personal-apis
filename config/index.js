const Joi = require('joi');

// Configuration schema for validation
const configSchema = Joi.object({
    // Environment
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
    PORT: Joi.number().default(5000),
    
    // Rate Limiting
    RATE_LIMIT_WINDOW_MS: Joi.number().default(15 * 60 * 1000), // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: Joi.number().default(100),
    
    // External APIs
    NFTPORTAL_KEY: Joi.string().optional(),
    OPENSEA_KEY: Joi.string().optional(),
    JSONRPCPROVIDER_ETH: Joi.string().uri().optional(),
    SA_EMAIL: Joi.string().email().optional(),
    SA_PRIVATE_KEY: Joi.string().optional(),
    SHEETS_API_KEY: Joi.string().optional(),
    ATTENDANCE_CLIENT_ID: Joi.string().optional(),
    ATTENDANCE_CLIENT_SECRET: Joi.string().optional(),
    ATTENDANCE_SHEET_ID: Joi.string().optional(),
    API_KEY: Joi.string().optional(),
    
    // Logging
    LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
    LOG_FORMAT: Joi.string().valid('combined', 'common', 'dev', 'short', 'tiny').default('combined'),
});

class Config {
    constructor() {
        // Load environment variables
        require('dotenv').config();
        
        // Validate configuration
        const { error, value } = configSchema.validate(process.env, {
            allowUnknown: true,
            stripUnknown: true
        });
        
        if (error) {
            throw new Error(`Configuration validation error: ${error.message}`);
        }
        
        // Store validated config
        this._config = value;
        
        // Environment specific configurations
        this._setEnvironmentDefaults();
    }
    
    _setEnvironmentDefaults() {
        if (this._config.NODE_ENV === 'test') {
            this._config.LOG_LEVEL = 'error';
        }
        
        if (this._config.NODE_ENV === 'production') {
            this._config.LOG_LEVEL = 'warn';
            this._config.RATE_LIMIT_MAX_REQUESTS = 50; // Stricter in production
        }
        
        if (this._config.NODE_ENV === 'development') {
            this._config.LOG_FORMAT = 'dev';
            this._config.RATE_LIMIT_MAX_REQUESTS = 200; // More lenient in dev
        }
    }
    
    get(key) {
        return this._config[key];
    }
    
    getAll() {
        return { ...this._config };
    }
    
    isDevelopment() {
        return this._config.NODE_ENV === 'development';
    }
    
    isProduction() {
        return this._config.NODE_ENV === 'production';
    }
    
    isTest() {
        return this._config.NODE_ENV === 'test';
    }
    
    getRateLimitConfig() {
        return {
            windowMs: this._config.RATE_LIMIT_WINDOW_MS,
            max: this._config.RATE_LIMIT_MAX_REQUESTS
        };
    }
}

// Export singleton instance
module.exports = new Config();