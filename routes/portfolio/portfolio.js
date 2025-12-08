const router = require('express').Router();
const verify = require('../auth/verifyToken');
const publicationService = require('./publicationService');

router.get('/', (req, res) => {
    res.send('Welcome to Portfolio API');
});

router.get('/atit', (req, res) => {
    const atitPortfolio = require('./atit/atit.json');
    res.json(atitPortfolio);
});

router.get('/atit/md', (req, res) => {
    const id = req.query.id;
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, 'atit', 'md', id + '.md');
    
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Error');
        }
        res.send(data);
    });
});

router.get('/atit/pdf', (req, res) => {
    const id = req.query.id;
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, 'atit', 'pdf', id + '.pdf');

    fs.readFile(filePath, (err, data) => {
        if (err) {
            return res.status(500).send('Error');
        }
        res.contentType('application/pdf');
        res.send(data);
    });
});

router.get('/atit/img', (req, res) => {
    const id = req.query.id;
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, 'atit', 'img', id + '.png');

    fs.readFile(filePath, (err, data) => {
        if (err) {
            return res.status(500).send('Error');
        }
        // Set CORS headers for cross-origin image requests
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Cross-Origin-Resource-Policy', 'cross-origin');
        res.contentType('image/png');
        res.send(data);
    });
});

router.get('/ashlesha', (req, res) => {
    const ashleshaPortfolio = require('./ashlesha/ashlesha.json');
    res.json(ashleshaPortfolio);
});

// NEW: Get publications from ORCID
router.get('/atit/publications', async (req, res) => {
    try {
        const atitPortfolio = require('./atit/atit.json');
        const orcidId = atitPortfolio.social_links.orcid.split('/').pop(); // Extract ORCID ID from URL
        const useCache = req.query.cache !== 'false'; // Allow cache bypass with ?cache=false
        
        const publications = await publicationService.getPublications(orcidId, useCache);
        
        res.json({
            success: true,
            count: publications.length,
            cache: publicationService.getCacheStatus(),
            publications
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch publications',
            message: error.message
        });
    }
});

// NEW: Merge publications with existing portfolio
router.get('/atit/full', async (req, res) => {
    try {
        const useCache = req.query.cache !== 'false';
        
        // Get static portfolio
        const atitPortfolio = require('./atit/atit.json');
        const orcidId = atitPortfolio.social_links.orcid.split('/').pop(); // Extract ORCID ID from URL
        
        // Get dynamic publications
        const publications = await publicationService.getPublications(orcidId, useCache);
        
        // Find highest ID in existing portfolio
        let maxId = Math.max(...atitPortfolio.portfolio.map(p => p.id || 0));
        
        // Add IDs and images to publications
        const enhancedPublications = publications.map((pub, index) => {
            maxId++;
            return {
                id: maxId,
                image: 'https://i.imgur.com/cyFcMd7.jpeg', // Default research image
                video: '',
                ...pub
            };
        });
        
        // Merge portfolios
        const merged = {
            ...atitPortfolio,
            portfolio: [...atitPortfolio.portfolio, ...enhancedPublications]
        };
        
        res.json(merged);
    } catch (error) {
        // If publication fetch fails, return static portfolio only
        const atitPortfolio = require('./atit/atit.json');
        res.json(atitPortfolio);
    }
});

// NEW: Clear publications cache
router.post('/atit/publications/refresh', (req, res) => {
    publicationService.clearCache();
    res.json({
        success: true,
        message: 'Publications cache cleared'
    });
});


module.exports = router;