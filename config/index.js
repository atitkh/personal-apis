const Joi = require('joi');

// Configuration schema for validation
const configSchema = Joi.object({
    // Environment
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
    PORT: Joi.number().default(5000),
    
    // Database
    DB_CONNECTION: Joi.string().uri().required(),
    DB_MAX_POOL_SIZE: Joi.number().default(10),
    DB_MIN_POOL_SIZE: Joi.number().default(2),
    
    // JWT
    TOKEN_SECRET: Joi.string().min(8).required(),
    TOKEN_EXPIRY: Joi.string().default('24h'),
    
    // Rate Limiting
    RATE_LIMIT_WINDOW_MS: Joi.number().default(15 * 60 * 1000), // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: Joi.number().default(100),
    AUTH_RATE_LIMIT_MAX_REQUESTS: Joi.number().default(5),
    
    // External APIs
    EWELINK_EMAIL: Joi.string().email().optional(),
    EWELINK_PASSWORD: Joi.string().optional(),
    EWELINK_APP_ID: Joi.string().optional(),
    EWELINK_APP_SECRET: Joi.string().optional(),
    EWELINK_REGION: Joi.string().optional(),
    TUBELIGHT_ID: Joi.string().optional(),
    NFTPORTAL_KEY: Joi.string().optional(),
    OPENSEA_KEY: Joi.string().optional(),
    JSONRPCPROVIDER_ETH: Joi.string().uri().optional(),
    IFTTT_PHONE_KEY: Joi.string().optional(),
    SA_EMAIL: Joi.string().email().optional(),
    SA_PRIVATE_KEY: Joi.string().optional(),
    SHEETS_API_KEY: Joi.string().optional(),
    ATTENDANCE_CLIENT_ID: Joi.string().optional(),
    ATTENDANCE_CLIENT_SECRET: Joi.string().optional(),
    ATTENDANCE_SHEET_ID: Joi.string().optional(),
    UNOFFICIAL_API_KEY: Joi.string().optional(),
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
            this._config.DB_CONNECTION = this._config.DB_CONNECTION || 'mongodb://localhost:27017/test-personal-apis';
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
    
    getDatabaseConfig() {
        return {
            uri: this._config.DB_CONNECTION,
            options: {
                useNewUrlParser: true,
                useUnifiedTopology: true,
                maxPoolSize: this._config.DB_MAX_POOL_SIZE,
                minPoolSize: this._config.DB_MIN_POOL_SIZE,
                maxIdleTimeMS: 30000,
                serverSelectionTimeoutMS: 5000,
                socketTimeoutMS: 45000,
            }
        };
    }
    
    getRateLimitConfig() {
        return {
            windowMs: this._config.RATE_LIMIT_WINDOW_MS,
            max: this._config.RATE_LIMIT_MAX_REQUESTS,
            authMax: this._config.AUTH_RATE_LIMIT_MAX_REQUESTS
        };
    }
    
    getJWTConfig() {
        return {
            secret: this._config.TOKEN_SECRET,
            expiresIn: this._config.TOKEN_EXPIRY
        };
    }
}

// Export singleton instance
module.exports = new Config();