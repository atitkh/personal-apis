/**
 * Publication Service
 * 
 * Fetches academic publications from ORCID and CrossRef APIs
 * Formats them to match portfolio structure
 * 
 * IMPORTANT NOTES:
 * - ORCID Public API only returns works that are set to PUBLIC visibility
 * - If the ORCID profile has no works or they're private, the API returns empty results
 * - No authentication is required for public data, but /read-limited scope is needed for private works
 * - CrossRef API provides additional metadata (abstracts, citations, etc.) when DOI is available
 * - Both APIs are free and don't require API keys for basic usage
 * - ORCID API: https://pub.orcid.org/v3.0/{orcid-id}/works
 * - CrossRef API: https://api.crossref.org/works/{doi}
 * 
 * @module routes/portfolio/publicationService
 */

const axios = require('axios');
const { logger } = require('../../utils/logger');

// Cache publications for 1 hour to reduce API calls
let publicationsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

class PublicationService {
  constructor() {
    this.orcidBaseUrl = 'https://pub.orcid.org/v3.0';
    this.crossrefBaseUrl = 'https://api.crossref.org/works';
  }

  /**
   * Get publications from ORCID ID
   * @param {string} orcidId - ORCID ID (e.g., '0009-0001-6174-7314')
   * @param {boolean} useCache - Whether to use cached data
   * @returns {Promise<Array>} - Array of publications in portfolio format
   */
  async getPublications(orcidId, useCache = true) {
    // Check cache
    if (useCache && publicationsCache && cacheTimestamp) {
      const now = Date.now();
      if (now - cacheTimestamp < CACHE_DURATION) {
        logger.info('Returning cached publications', { orcidId });
        return publicationsCache;
      }
    }

    try {
      logger.info('Fetching publications from ORCID', { orcidId });

      // Fetch works from ORCID
      const response = await axios.get(
        `${this.orcidBaseUrl}/${orcidId}/works`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Portfolio-API/1.0 (https://atitkharel.com.np; mailto:contact@atitkharel.com.np)'
          },
          timeout: 15000
        }
      );

      if (!response.data?.group || response.data.group.length === 0) {
        logger.info('No public works found in ORCID profile', { 
          orcidId,
          note: 'This may mean: (1) No works added to profile, (2) Works are private, or (3) Profile exists but empty'
        });
        return [];
      }

      // Process each work
      const publications = [];
      for (const group of response.data.group) {
        const workSummary = group['work-summary']?.[0];
        if (!workSummary) continue;

        try {
          const publication = await this.processWork(workSummary);
          if (publication) {
            publications.push(publication);
          }
        } catch (error) {
          logger.warn('Failed to process work', {
            putCode: workSummary['put-code'],
            error: error.message
          });
        }
      }

      // Sort by date (newest first)
      publications.sort((a, b) => {
        const dateA = new Date(a.rawDate || '1900-01-01');
        const dateB = new Date(b.rawDate || '1900-01-01');
        return dateB - dateA;
      });

      // Update cache
      publicationsCache = publications;
      cacheTimestamp = Date.now();

      logger.info('Successfully fetched publications', {
        count: publications.length,
        orcidId
      });

      return publications;
    } catch (error) {
      logger.error('Failed to fetch publications from ORCID', {
        orcidId,
        error: error.message
      });
      
      // Return cached data if available
      if (publicationsCache) {
        logger.info('Returning stale cached publications due to error');
        return publicationsCache;
      }
      
      throw error;
    }
  }

  /**
   * Process a single work from ORCID
   */
  async processWork(workSummary) {
    const title = workSummary.title?.title?.value || 'Untitled';
    const type = workSummary.type || 'publication';
    const publicationDate = workSummary['publication-date'];
    
    // Format date
    const year = publicationDate?.year?.value;
    const month = publicationDate?.month?.value;
    const day = publicationDate?.day?.value;
    
    let formattedDate = year || 'Unknown';
    let rawDate = null;
    
    if (year && month) {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                          'July', 'August', 'September', 'October', 'November', 'December'];
      const monthName = monthNames[parseInt(month) - 1] || month;
      formattedDate = day ? `${monthName} ${day}, ${year}` : `${monthName} ${year}`;
      rawDate = `${year}-${String(month).padStart(2, '0')}-${String(day || '01').padStart(2, '0')}`;
    }

    // Extract external IDs (DOI, etc.)
    const externalIds = workSummary['external-ids']?.['external-id'] || [];
    const doi = externalIds.find(id => id['external-id-type'] === 'doi');
    const doiValue = doi?.['external-id-value'];

    // Get additional metadata from CrossRef if DOI available
    let crossrefData = null;
    if (doiValue) {
      try {
        crossrefData = await this.fetchCrossRefMetadata(doiValue);
      } catch (error) {
        logger.warn('Failed to fetch CrossRef metadata', { doi: doiValue });
      }
    }

    // Extract journal/conference name
    const journalTitle = workSummary['journal-title']?.value ||
                         crossrefData?.['container-title']?.[0] ||
                         '';

    // Build project links
    const projectLinks = [];
    
    // Add PDF link - prioritize your own PDF endpoint if DOI is available
    if (doiValue) {
      // Your custom PDF endpoint using DOI as ID
      projectLinks.push(`https://api.atitkharel.com.np/portfolio/atit/pdf?id=${doiValue}`);
    }
    
    // Alternative: Check for direct PDF from CrossRef
    const pdfLink = this.extractPdfLink(crossrefData);
    if (pdfLink && !pdfLink.includes('ieee')) {
      projectLinks.push(pdfLink);
    }

    // Add standard DOI link
    if (doiValue) {
      projectLinks.push(`https://doi.org/${doiValue}`);
    }
    
    // Add URL if available
    const url = workSummary.url?.value;
    if (url && !projectLinks.includes(url)) {
      projectLinks.push(url);
    }

    // If we have 2+ DOI-based links, resolve the first DOI to actual destination
    const doiLinksCount = projectLinks.filter(link => link.includes('doi.org') || link.includes('atitkharel.com.np/portfolio/atit/pdf')).length;
    if (doiLinksCount >= 2 && doiValue) {
      try {
        const resolvedUrl = await this.resolveDOI(doiValue);
        if (resolvedUrl) {
          // Replace the generic doi.org link with the resolved URL
          const doiOrgIndex = projectLinks.findIndex(link => link === `https://doi.org/${doiValue}`);
          if (doiOrgIndex !== -1) {
            projectLinks[doiOrgIndex] = resolvedUrl;
          }
        }
      } catch (error) {
        logger.debug('DOI resolution failed', { doi: doiValue });
      }
    }

    // Determine categories based on type and publisher (prefer publisher over venue title)
    const categories = this.determineCategories(type, crossrefData);

    // Generate description
    const description = this.generateDescription(workSummary, crossrefData, journalTitle);

    // Generate image/thumbnail for publication
    const image = await this.generatePublicationImage(doiValue, type, crossrefData?.publisher);

    // Truncate title at colon for display, keep full title in metadata
    const titleParts = title.split(':');
    const displayTitle = titleParts[0].trim();
    const fullTitle = title;

    // Build the publication object in portfolio format
    const publication = {
      title: displayTitle,
      description,
      image,
      projectLink: projectLinks,
      categories,
      date: formattedDate,
      rawDate, // For sorting
      mainCategory: ['Research'],
      publicationType: type,
      // Additional metadata
      metadata: {
        fullTitle,
        doi: doiValue || null,
        abstract: crossrefData?.abstract || null,
        journal: journalTitle || null,
        authors: crossrefData?.author?.map(a => `${a.given} ${a.family}`).join(', ') || null,
        citations: crossrefData?.['is-referenced-by-count'] || 0,
        isReferencedByCount: crossrefData?.['is-referenced-by-count'] || 0,
        publisher: crossrefData?.publisher || null,
        issn: crossrefData?.ISSN?.[0] || null,
        volume: crossrefData?.volume || null,
        issue: crossrefData?.issue || null,
        pages: crossrefData?.page || null
      }
    };

    return publication;
  }

  /**
   * Generate publication thumbnail image
   * Strategy: Use arXiv thumbnail if available, otherwise generate colored badge
   */
  async generatePublicationImage(doi, type, publisher) {
    // TODO: Try other sources for image/cover data first
    // Fallback: Generate colored badge based on publication type
    return this.getLocalImageDOI(doi, type, publisher);
  }

  getLocalImageDOI(doi, type, publisher) {
    if (!doi) {
      return this.generatePublicationBadge(type);
    }

    // Use a local mapping for known publishers
    return "https://api.atitkharel.com.np/portfolio/atit/img?id=" + doi;
  }

  /**
   * Generate a colored badge image URL based on publication type
   * Uses a simple SVG-based badge generator
   */
  generatePublicationBadge(type) {
    // Type -> color mapping
    const typeColors = {
      'journal-article': '4A90E2',      // Blue
      'conference-paper': '7ED321',     // Green
      'book-chapter': 'F5A623',          // Orange
      'preprint': 'BD10E0',              // Purple
      'thesis': '50E3C2',                // Teal
      'dissertation': 'B8E986',          // Light Green
      'book': 'D0021B',                  // Red
      'report': '9013FE',                // Indigo
      'dataset': 'FF6B6B',               // Coral
      'software': '4ECDC4'               // Turquoise
    };

    const color = typeColors[type] || '808080'; // Default gray
    const label = type?.replace(/-/g, ' ').toUpperCase().substring(0, 15) || 'PUBLICATION';
    
    // Use shields.io for badge (reliable, no external dependencies)
    // Format: https://img.shields.io/badge/[label]-[color]
    const encodedLabel = encodeURIComponent(label);
    return `https://img.shields.io/badge/${encodedLabel}-${color}?style=flat-square&logo=academic`;
  }

  /**
   * Extract a PDF/full-text link from CrossRef metadata if available
   */
  extractPdfLink(crossrefData) {
    if (!crossrefData?.link || !Array.isArray(crossrefData.link)) return null;

    // Look for explicit PDF content-type first
    const pdf = crossrefData.link.find(l =>
      typeof l['content-type'] === 'string' && l['content-type'].includes('pdf')
    );
    if (pdf?.URL) return pdf.URL;

    // Fallback: any full-text URL if PDF not present
    const fullText = crossrefData.link.find(l => l.URL);
    return fullText?.URL || null;
  }

  /**
   * Resolve DOI to actual destination URL by following redirects
   * Returns the final URL where the DOI redirects to
   */
  async resolveDOI(doi) {
    try {
      // Use CrossRef API to get the actual URL directly (more reliable than following redirects)
      const response = await axios.get(
        `https://api.crossref.org/works/${doi}`,
        {
          timeout: 8000,
          headers: {
            'User-Agent': 'Portfolio-API/1.0 (https://atitkharel.com.np; mailto:contact@atitkharel.com.np)'
          }
        }
      );

      // Get the actual paper URL from CrossRef
      const url = response.data?.message?.URL;
      if (url && url !== `https://doi.org/${doi}`) {
        logger.debug('DOI resolved to URL', { doi, url });
        return url;
      }

      // Fallback: try the resource link
      const resourceUrl = response.data?.message?.resource?.primary?.URL;
      if (resourceUrl && resourceUrl !== `https://doi.org/${doi}`) {
        logger.debug('DOI resolved via resource link', { doi, url: resourceUrl });
        return resourceUrl;
      }

      return null;
    } catch (error) {
      logger.debug('DOI resolution error', { doi, error: error.message });
      return null;
    }
  }

  /**
   * Fetch additional metadata from CrossRef
   * Abstracts may be unavailable - CrossRef only returns abstracts that publishers have deposited
   */
  async fetchCrossRefMetadata(doi) {
    try {
      const response = await axios.get(
        `${this.crossrefBaseUrl}/${doi}`,
        {
          timeout: 10000,
          headers: {
            'User-Agent': 'Portfolio-API/1.0 (https://atitkharel.com.np; mailto:contact@atitkharel.com.np)'
          }
        }
      );
      
      if (!response.data?.message) {
        logger.debug('CrossRef returned empty message', { doi });
        return null;
      }
      
      let data = response.data.message;
      
      // If no abstract from CrossRef, try to fetch from Semantic Scholar API
      if (!data.abstract && doi) {
        try {
          const abstractData = await this.fetchSemanticScholarAbstract(doi);
          if (abstractData) {
            data.abstract = abstractData;
            logger.debug('Retrieved abstract from Semantic Scholar', { doi });
          }
        } catch (error) {
          logger.debug('Semantic Scholar lookup failed', { doi, error: error.message });
        }
      }
      
      return data;
    } catch (error) {
      if (error.response?.status === 404) {
        logger.debug('DOI not found in CrossRef', { doi });
      } else {
        logger.debug('CrossRef fetch failed', { doi, error: error.message });
      }
      return null;
    }
  }

  /**
   * Fetch abstract from Semantic Scholar API as fallback
   * Free API, no auth required
   */
  async fetchSemanticScholarAbstract(doi) {
    try {
      const response = await axios.get(
        `https://api.semanticscholar.org/graph/v1/paper/${doi}`,
        {
          params: {
            fields: 'abstract,title'
          },
          timeout: 8000,
          headers: {
            'User-Agent': 'Portfolio-API/1.0 (https://atitkharel.com.np; mailto:contact@atitkharel.com.np)'
          }
        }
      );
      
      return response.data?.abstract || null;
    } catch (error) {
      logger.debug('Semantic Scholar API error', { doi, error: error.message });
      return null;
    }
  }

  /**
   * Determine categories based on publication type
   */
  determineCategories(type, crossrefData) {
    const categories = [];

    // Type-based categories
    const typeMap = {
      'journal-article': 'Journal Article',
      'conference-paper': 'Conference Paper',
      'book-chapter': 'Book Chapter',
      'preprint': 'Preprint',
      'thesis': 'Thesis',
      'dissertation': 'Dissertation',
      'book': 'Book',
      'report': 'Technical Report',
      'dataset': 'Dataset',
      'software': 'Software'
    };

    const category = typeMap[type] || 'Publication';
    categories.push(category);

    // Prefer publisher as a category to surface venue/issuer
    if (crossrefData?.publisher) {
      categories.push(crossrefData.publisher);
    }

    // Add subject categories from CrossRef if available
    if (crossrefData?.subject) {
      crossrefData.subject.slice(0, 3).forEach(subject => {
        categories.push(subject);
      });
    }

    return categories;
  }

  /**
   * Generate description from available metadata
   */
  generateDescription(workSummary, crossrefData, journalTitle) {
    const parts = [];

    // Add abstract if available
    if (crossrefData?.abstract) {
      // Remove XML/HTML tags and truncate
      const abstract = crossrefData.abstract
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (abstract.length > 500) {
        parts.push(abstract.substring(0, 497) + '...');
      } else if (abstract) {
        parts.push(abstract);
      }
    }

    // Add journal/conference info if no abstract
    if (parts.length === 0 && journalTitle) {
      parts.push(`Published in ${journalTitle}`);
      
      if (crossrefData?.volume) {
        parts.push(`Volume ${crossrefData.volume}`);
      }
      if (crossrefData?.issue) {
        parts.push(`Issue ${crossrefData.issue}`);
      }
    }

    // Default description if nothing else
    if (parts.length === 0) {
      const type = workSummary.type || 'publication';
      parts.push(`Academic ${type.replace(/-/g, ' ')}`);
    }

    return parts.join('. ');
  }

  /**
   * Clear cache manually
   */
  clearCache() {
    publicationsCache = null;
    cacheTimestamp = null;
    logger.info('Publications cache cleared');
  }

  /**
   * Get cache status
   */
  getCacheStatus() {
    if (!publicationsCache || !cacheTimestamp) {
      return { cached: false };
    }

    const age = Date.now() - cacheTimestamp;
    const remaining = Math.max(0, CACHE_DURATION - age);

    return {
      cached: true,
      count: publicationsCache.length,
      ageSeconds: Math.floor(age / 1000),
      remainingSeconds: Math.floor(remaining / 1000)
    };
  }
}

module.exports = new PublicationService();
