const express = require('express');
const app = express();
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const { specs, swaggerUi } = require('./config/swagger');

// Import utilities and config
const config = require('./config');
const databaseManager = require('./utils/database');
const { requestLogger, errorLogger } = require('./utils/logger');
const { responseFormatter } = require('./middleware/responseFormatter');
const { BaseError } = require('./utils/errors');

//Import Routes
const apiRoutes = require('./routes/api');
const authRoute = require('./routes/auth/auth');
const ewelinkRoute = require('./routes/smarthome/ewelink');
const magichomeRoute = require('./routes/smarthome/magichome');
const nftlisterRoute = require('./routes/nft/nftsearch');
const phonecallRoute = require('./routes/phonecall/phonecallIFTTT');
const ipoResult = require('./routes/iporesult/iporesult');
const valorantRoute = require('./routes/valorant/info');
const karunRoute = require('./routes/karun/karun');
const portfolioRoute = require('./routes/portfolio/portfolio');
const attendanceRoute = require('./routes/kerkarcreations/attendance');

//Middleware
// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for API usage
    crossOriginEmbedderPolicy: false
}));

// Compression middleware
app.use(compression());

// Rate limiting
const rateLimitConfig = config.getRateLimitConfig();
const limiter = rateLimit({
    windowMs: rateLimitConfig.windowMs,
    max: rateLimitConfig.max,
    message: {
        error: 'Too many requests',
        message: 'Please try again later'
    },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
    windowMs: rateLimitConfig.windowMs,
    max: rateLimitConfig.authMax,
    message: {
        error: 'Too many authentication attempts',
        message: 'Please try again later'
    }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging and correlation ID
app.use(requestLogger);

// Response formatter
app.use(responseFormatter);

// HTTP request logging
if (config.isDevelopment()) {
    app.use(morgan('dev'));
} else {
    app.use(morgan('combined'));
}

app.use(express.static("html"));

// Vortex Web Interface Routes
app.get('/vortex', (req, res) => {
    res.sendFile(path.join(__dirname, 'html', 'vortex.html'));
});

app.get('/vortex/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'html', 'vortex', 'style.css'));
});

app.get('/vortex/app.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'html', 'vortex', 'app.js'));
});

app.use('/auth', authLimiter, authRoute);
app.use('/api/v1/smarthome/ewelink', ewelinkRoute);
app.use('/api/v1/smarthome/magichome', magichomeRoute);
app.use('/api/v1/nft', nftlisterRoute);
app.use('/api/v1/phonecall', phonecallRoute);
app.use('/api/v1/ipo', ipoResult);
app.use('/api/v1/valorant', valorantRoute);
app.use('/api/v1/karun', karunRoute);
app.use('/api/v1/portfolio', portfolioRoute);
app.use('/api/v1/kerkarcreations/attendance', attendanceRoute);

// Mount new versioned API routes
app.use('/api', apiRoutes);

// Legacy routes (for backward compatibility)
app.use('/smarthome/ewelink', ewelinkRoute);
app.use('/smarthome/magichome', magichomeRoute);
app.use('/nft', nftlisterRoute);
app.use('/phonecall', phonecallRoute);
app.use('/ipo', ipoResult);
app.use('/valorant', valorantRoute);
app.use('/karun', karunRoute);
app.use('/portfolio', portfolioRoute);
app.use('/kerkarcreations/attendance', attendanceRoute);

// Swagger API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Personal APIs Documentation'
}));

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: System health status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: OK
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 uptime:
 *                   type: number
 *                 database:
 *                   type: string
 *                   example: connected
 */
// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const dbHealth = await databaseManager.healthCheck();
        const healthCheck = {
            status: dbHealth.status === 'healthy' ? 'OK' : 'WARNING',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: config.get('NODE_ENV'),
            version: process.env.npm_package_version || '1.0.0',
            database: dbHealth
        };
        
        const statusCode = dbHealth.status === 'healthy' ? 200 : 503;
        res.status(statusCode).json(healthCheck);
    } catch (error) {
        res.status(503).json({
            status: 'ERROR',
            timestamp: new Date().toISOString(),
            error: error.message
        });
    }
});

/**
 * @swagger
 * /api:
 *   get:
 *     summary: API information and endpoints
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: API information and available endpoints
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 version:
 *                   type: string
 *                 description:
 *                   type: string
 *                 endpoints:
 *                   type: object
 */
// API Info endpoint
app.get('/api', (req, res) => {
    res.json({
        name: 'Personal APIs',
        version: '1.0.0',
        description: 'A collection of personal API endpoints',
        documentation: 'https://github.com/atitkh/personal-apis',
        endpoints: {
            health: '/health',
            auth: '/auth',
            v1: {
                nft: '/api/v1/nft',
                valorant: '/api/v1/valorant',
                smartHome: '/api/v1/smarthome',
                portfolio: '/api/v1/portfolio',
                ipo: '/api/v1/ipo',
                phonecall: '/api/v1/phonecall',
                attendance: '/api/v1/kerkarcreations/attendance'
            },
            legacy: {
                note: 'Legacy endpoints maintained for backward compatibility',
                nft: '/nft',
                valorant: '/valorant',
                smartHome: '/smarthome',
                portfolio: '/portfolio',
                ipo: '/ipo',
                phonecall: '/phonecall',
                attendance: '/kerkarcreations/attendance'
            }
        },
        rateLimit: {
            general: '100 requests per 15 minutes',
            auth: '5 requests per 15 minutes'
        }
    });
});

// Global error handling middleware
app.use(errorLogger);

app.use((err, req, res, next) => {
    // Handle errors using response formatter
    res.error(err);
});

// 404 handler
app.use('*', (req, res) => {
    res.notFound('Route');
});

//main route
// app.get('/', (req, res) => {
//     res.setHeader('Content-type','text/html')
//     res.sendFile(path.join(__dirname, '/html/index.html'));
// });

//Connect to DB
if (!config.isTest()) {
    databaseManager.connect()
        .then(async () => {
            // Initialize MCP service after database connection
            try {
                const mcpService = require('./services/mcpService');
                await mcpService.initialize();
                console.log('✅ MCP Service initialized');
            } catch (mcpError) {
                console.warn('⚠️ MCP Service initialization failed:', mcpError.message);
                // Continue without MCP - non-critical
            }
        })
        .catch(err => {
            console.error('Failed to start application:', err);
            if (config.isProduction()) {
                process.exit(1);
            }
        });
}

//listen
const port = config.get('PORT');

// Only start server if not in test environment
if (!config.isTest()) {
    const server = app.listen(port, () => {
        console.log(`🚀 Server running on port ${port}`);
    });

    // Graceful shutdown is handled by databaseManager
}

// Export app for testing
module.exports = app;
