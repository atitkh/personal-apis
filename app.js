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
const db = require('./db');
const { requestLogger, errorLogger } = require('./utils/logger');
const { responseFormatter } = require('./middleware/responseFormatter');
const { BaseError } = require('./utils/errors');

//Import Routes
const nftlisterRoute = require('./routes/nft/nftsearch');
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

// CORS comes before the rate limiter, so a 429 also carries the CORS headers. Without that a browser
// reports "blocked by CORS policy" and hides that the real problem is the limit.
app.use(cors());

// Behind a Cloudflare tunnel every request reaches the container from the Docker gateway. Trusting
// private/loopback hops makes req.ip the visitor's address (from X-Forwarded-For), so the limits below
// are per visitor and not one bucket shared by the whole internet.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

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
    // The portfolio's data, images and demo pages are public and static: a page view fetches a dozen
    // of them. Only the ORCID lookup (it calls an outside service) stays limited.
    skip: (req) => req.path.startsWith('/portfolio/') && !req.path.includes('/publications'),
});
app.use(limiter);

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

app.use('/api/v1/nft', nftlisterRoute);
app.use('/api/v1/portfolio', portfolioRoute);
app.use('/api/v1/kerkarcreations/attendance', attendanceRoute);

// Legacy routes (for backward compatibility)
app.use('/nft', nftlisterRoute);
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
 *                   type: object
 *                   example: { status: healthy, migrations: 1 }
 */
// Health check endpoint
app.get('/health', (req, res) => {
    try {
        const dbHealth = db.health();
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
            v1: {
                nft: '/api/v1/nft',
                portfolio: '/api/v1/portfolio',
                attendance: '/api/v1/kerkarcreations/attendance'
            },
            legacy: {
                note: 'Legacy endpoints maintained for backward compatibility',
                nft: '/nft',
                portfolio: '/portfolio',
                attendance: '/kerkarcreations/attendance'
            }
        },
        rateLimit: {
            general: '100 requests per 15 minutes'
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

// Open the hub database (and apply migrations) at boot. A failure is logged and shows up in /health, but
// the portfolio keeps serving: it does not depend on the database.
if (!config.isTest()) {
    try {
        db.get();
        require('./services/backup').start();
    } catch (err) {
        console.error('Hub database failed to open:', err);
    }
}

//listen
const port = config.get('PORT');

// Only start server if not in test environment
if (!config.isTest()) {
    const server = app.listen(port, () => {
        console.log(`🚀 Server running on port ${port}`);
    });

    const shutdown = () => {
        server.close();
        db.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

// Export app for testing
module.exports = app;
