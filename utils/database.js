const mongoose = require('mongoose');
const config = require('../config');
const { customLogger } = require('../utils/logger');

class DatabaseManager {
    constructor() {
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectInterval = 5000; // 5 seconds
    }
    
    /**
     * Connect to MongoDB with retry logic
     */
    async connect() {
        if (config.isTest()) {
            customLogger.info('Skipping database connection in test environment');
            return;
        }
        
        const dbConfig = config.getDatabaseConfig();
        
        try {
            // Set mongoose options
            mongoose.set('strictQuery', false);
            
            // Connect to MongoDB
            await mongoose.connect(dbConfig.uri, {
                ...dbConfig.options,
                // Connection pool settings
                maxPoolSize: 10, // Maximum number of connections
                minPoolSize: 2,  // Minimum number of connections
                maxIdleTimeMS: 30000, // Close connections after 30s of inactivity
                serverSelectionTimeoutMS: 5000, // How long to try to select a server
                socketTimeoutMS: 45000, // How long to wait for a response
                family: 4, // Use IPv4, skip trying IPv6
                
                // Retry settings
                retryWrites: true,
                retryReads: true,
                
                // Buffer settings - enable buffering until connection is ready
                bufferCommands: true, // Enable mongoose buffering
            });
            
            this.isConnected = true;
            this.reconnectAttempts = 0;
            
            customLogger.database('Connected to MongoDB', {
                host: this.getConnectionHost(),
                database: this.getConnectionDatabase()
            });
            
            this.setupEventHandlers();
            
        } catch (error) {
            this.isConnected = false;
            customLogger.error('Failed to connect to MongoDB', error, {
                attempt: this.reconnectAttempts + 1,
                maxAttempts: this.maxReconnectAttempts
            });
            
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                await this.handleReconnection();
            } else {
                customLogger.error('Max reconnection attempts reached. Exiting...');
                if (config.isProduction()) {
                    process.exit(1);
                }
                throw error;
            }
        }
    }
    
    /**
     * Handle reconnection logic
     */
    async handleReconnection() {
        this.reconnectAttempts++;
        
        customLogger.warn('Attempting to reconnect to MongoDB', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxReconnectAttempts,
            retryIn: this.reconnectInterval
        });
        
        return new Promise((resolve) => {
            setTimeout(async () => {
                try {
                    await this.connect();
                    resolve();
                } catch (error) {
                    // Error handling is done in connect method
                    resolve();
                }
            }, this.reconnectInterval);
        });
    }
    
    /**
     * Setup MongoDB event handlers
     */
    setupEventHandlers() {
        // Connection events
        mongoose.connection.on('connected', () => {
            this.isConnected = true;
            customLogger.database('Mongoose connected to MongoDB');
        });
        
        mongoose.connection.on('error', (error) => {
            this.isConnected = false;
            customLogger.error('MongoDB connection error', error);
        });
        
        mongoose.connection.on('disconnected', () => {
            this.isConnected = false;
            customLogger.warn('MongoDB disconnected');
            
            // Attempt to reconnect if not in test environment
            if (!config.isTest() && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.handleReconnection();
            }
        });
        
        mongoose.connection.on('reconnected', () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            customLogger.database('MongoDB reconnected');
        });
        
        // Process termination handlers
        process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    }
    
    /**
     * Graceful shutdown
     */
    async gracefulShutdown(signal) {
        customLogger.info(`${signal} received. Closing MongoDB connection...`);
        
        try {
            await mongoose.connection.close();
            customLogger.database('MongoDB connection closed gracefully');
            process.exit(0);
        } catch (error) {
            customLogger.error('Error during MongoDB connection closure', error);
            process.exit(1);
        }
    }
    
    /**
     * Check connection status
     */
    isConnectionReady() {
        return this.isConnected && mongoose.connection.readyState === 1;
    }
    
    /**
     * Get connection info
     */
    getConnectionInfo() {
        return {
            isConnected: this.isConnected,
            readyState: mongoose.connection.readyState,
            host: this.getConnectionHost(),
            database: this.getConnectionDatabase(),
            states: {
                0: 'disconnected',
                1: 'connected',
                2: 'connecting',
                3: 'disconnecting'
            }[mongoose.connection.readyState]
        };
    }
    
    /**
     * Get connection host
     */
    getConnectionHost() {
        return mongoose.connection.host || 'Unknown';
    }
    
    /**
     * Get connection database name
     */
    getConnectionDatabase() {
        return mongoose.connection.name || 'Unknown';
    }
    
    /**
     * Health check for database
     */
    async healthCheck() {
        try {
            if (!this.isConnectionReady()) {
                throw new Error('Database not connected');
            }
            
            // Perform a simple ping
            await mongoose.connection.db.admin().ping();
            
            return {
                status: 'healthy',
                connection: this.getConnectionInfo(),
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            customLogger.error('Database health check failed', error);
            return {
                status: 'unhealthy',
                error: error.message,
                connection: this.getConnectionInfo(),
                timestamp: new Date().toISOString()
            };
        }
    }
    
    /**
     * Get database statistics
     */
    async getStats() {
        try {
            if (!this.isConnectionReady()) {
                throw new Error('Database not connected');
            }
            
            const stats = await mongoose.connection.db.stats();
            return {
                collections: stats.collections,
                dataSize: stats.dataSize,
                storageSize: stats.storageSize,
                indexes: stats.indexes,
                indexSize: stats.indexSize,
                objects: stats.objects
            };
        } catch (error) {
            customLogger.error('Failed to get database stats', error);
            throw error;
        }
    }
}

// Export singleton instance
const databaseManager = new DatabaseManager();

module.exports = databaseManager;