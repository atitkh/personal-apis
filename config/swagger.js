const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Personal APIs',
            version: '1.0.0',
            description: 'A comprehensive collection of personal API endpoints',
            contact: {
                name: 'Atit Kharel',
                url: 'https://atitkharel.com.np',
                email: 'mail@atitkharel.com.np'
            },
        },
        servers: [
            {
                url: 'http://localhost:3000',
                description: 'Development server',
            },
            {
                url: 'http://localhost:5000',
                description: 'Alternative development server',
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
                authToken: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'auth-token',
                },
            },
        },
        tags: [
            {
                name: 'Health',
                description: 'System health and information endpoints',
            },
            {
                name: 'Authentication',
                description: 'User authentication endpoints',
            },
            {
                name: 'Courses',
                description: 'Course management endpoints',
            },
            {
                name: 'Posts',
                description: 'Blog post management endpoints',
            },
            {
                name: 'NFT',
                description: 'Non-Fungible Token search endpoints',
            },
            {
                name: 'Valorant',
                description: 'Valorant game API endpoints',
            },
            {
                name: 'Smart Home',
                description: 'IoT and smart home control endpoints',
            },
            {
                name: 'Portfolio',
                description: 'Personal portfolio and project endpoints',
            },
        ],
    },
    apis: ['./routes/**/*.js', './app.js'], // paths to files containing OpenAPI definitions
};

const specs = swaggerJsdoc(options);

module.exports = {
    specs,
    swaggerUi,
};