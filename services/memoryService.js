const { ChromaClient } = require('chromadb');
const { logger } = require('../utils/logger');

class MemoryService {
  constructor() {
    this.client = null;
    this.collections = {};
    this.isInitialized = false;
  }

  /**
   * Initialize ChromaDB connection and collections
   */
  async initialize() {
    try {
      this.client = new ChromaClient({
        path: process.env.CHROMADB_URL || 'http://localhost:8000'
      });

      // Load embedding function properly - no fallbacks, fix the root issue
      let embeddingFunction = null;
      
      try {
        logger.info('Loading ChromaDB embedding function...');
        
        // Check if chromadb-default-embed is installed
        try {
          require.resolve('chromadb-default-embed');
          logger.info('chromadb-default-embed module found');
        } catch (resolveError) {
          throw new Error('chromadb-default-embed module not found. Please install it with: npm install chromadb-default-embed');
        }
        
        // Load the embedding function with detailed error reporting
        logger.info('Attempting to require chromadb-default-embed...');
        const embeddingModule = require('chromadb-default-embed');
        logger.info('Module loaded successfully', { 
          moduleKeys: Object.keys(embeddingModule),
          hasDefaultEmbeddingFunction: 'DefaultEmbeddingFunction' in embeddingModule,
          defaultEmbeddingFunctionType: typeof embeddingModule.DefaultEmbeddingFunction
        });
        
        const { DefaultEmbeddingFunction } = embeddingModule;
        
        if (!DefaultEmbeddingFunction) {
          throw new Error('DefaultEmbeddingFunction not found in chromadb-default-embed module');
        }
        
        if (typeof DefaultEmbeddingFunction !== 'function') {
          throw new Error(`DefaultEmbeddingFunction is not a constructor, got: ${typeof DefaultEmbeddingFunction}`);
        }
        
        logger.info('Creating DefaultEmbeddingFunction instance...');
        embeddingFunction = new DefaultEmbeddingFunction();
        logger.info('Successfully initialized DefaultEmbeddingFunction instance');
        
        // Test the embedding function
        try {
          const testEmbedding = await embeddingFunction.generate(['test']);
          if (!testEmbedding || !Array.isArray(testEmbedding) || testEmbedding.length === 0) {
            throw new Error('Embedding function test failed - invalid output');
          }
          logger.info('Embedding function test passed', { 
            outputType: typeof testEmbedding,
            outputLength: testEmbedding.length,
            firstEmbeddingLength: testEmbedding[0]?.length 
          });
        } catch (testError) {
          throw new Error(`Embedding function test failed: ${testError.message}`);
        }
        
      } catch (error) {
        logger.error('Failed to load embedding function - this will break semantic search', { 
          error: error.message,
          stack: error.stack 
        });
        throw error; // Don't continue without embeddings
      }

      // Create/get collections for different memory types
      const collectionConfig = {
        metadata: { description: 'Chat conversations and messages' }
      };
      
      // Add embedding function to collection config
      collectionConfig.embeddingFunction = embeddingFunction;

      this.collections.conversations = await this.client.getOrCreateCollection({
        name: 'vortex_conversations',
        ...collectionConfig
      });

      const eventCollectionConfig = {
        metadata: { description: 'Significant events and actions' }
      };
      if (embeddingFunction) {
        eventCollectionConfig.embeddingFunction = embeddingFunction;
      }

      this.collections.events = await this.client.getOrCreateCollection({
        name: 'vortex_events', 
        ...eventCollectionConfig
      });

      const prefCollectionConfig = {
        metadata: { description: 'User preferences and patterns' }
      };
      if (embeddingFunction) {
        prefCollectionConfig.embeddingFunction = embeddingFunction;
      }

      this.collections.preferences = await this.client.getOrCreateCollection({
        name: 'vortex_preferences',
        ...prefCollectionConfig
      });

      const contextCollectionConfig = {
        metadata: { description: 'Session and contextual information' }
      };
      if (embeddingFunction) {
        contextCollectionConfig.embeddingFunction = embeddingFunction;
      }

      this.collections.context = await this.client.getOrCreateCollection({
        name: 'vortex_context',
        ...contextCollectionConfig
      });

      this.isInitialized = true;
      logger.info('MemoryService initialized successfully');

    } catch (error) {
      logger.error('MemoryService initialization failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Ensure service is initialized
   */
  async ensureInitialized() {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * Store a conversation message
   */
  async storeConversation({ userId, conversationId, role, content, context = {} }) {
    await this.ensureInitialized();

    try {
      const id = `${conversationId}_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      const metadata = {
        schema_version: '1.0',
        memory_type: 'conversation',
        timestamp: new Date().toISOString(),
        user_id: userId?.toString() || userId, // Ensure string format
        source: context.source || 'api',
        conversation_id: conversationId?.toString() || conversationId, // Ensure string format
        role: role,
        message_length: content.length
        // Don't spread context directly - it might contain problematic data
      };

      // Add safe context fields only
      if (context.userAgent) metadata.user_agent = context.userAgent;
      if (context.ip) metadata.ip_address = context.ip;

      // Debug log the data being sent to ChromaDB
      logger.debug('Storing conversation in ChromaDB', {
        id,
        contentLength: content.length,
        metadata: JSON.stringify(metadata),
        collectionReady: !!this.collections.conversations
      });

      // Verify collection exists before adding
      if (!this.collections.conversations) {
        throw new Error('Conversations collection not initialized');
      }

      await this.collections.conversations.add({
        ids: [id],
        documents: [content],
        metadatas: [metadata]
      });

      logger.info('Conversation stored successfully', { 
        id, 
        role, 
        userId: userId?.toString(), 
        conversationId 
      });
      return id;

    } catch (error) {
      logger.error('Failed to store conversation', { 
        userId, 
        conversationId, 
        role, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Store an event memory
   */
  async storeEvent({ userId, eventType, domain, userIntent, systemResponse, context = {} }) {
    await this.ensureInitialized();

    try {
      const id = `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      const document = `Event: ${eventType} in ${domain}. User: "${userIntent}" System: "${systemResponse}"`;
      
      const metadata = {
        schema_version: '1.0',
        memory_type: 'event',
        timestamp: new Date().toISOString(),
        user_id: userId?.toString() || userId, // Ensure string format
        source: context.source || 'system',
        event_type: eventType,
        domain: domain,
        user_intent: userIntent,
        system_response: systemResponse
        // Don't spread context directly - it might contain problematic data
      };

      // Add safe context fields only
      if (context.confidence) metadata.confidence = context.confidence;
      if (context.model_used) metadata.model_used = context.model_used;

      await this.collections.events.add({
        ids: [id],
        documents: [document],
        metadatas: [metadata]
      });

      logger.debug('Event stored', { id, eventType, domain, userId });
      return id;

    } catch (error) {
      logger.error('Failed to store event', { 
        userId, 
        eventType, 
        domain, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get relevant context for a query
   */
  async getRelevantContext({ userId, query, conversationId, limit = 10 }) {
    await this.ensureInitialized();

    try {
      logger.debug('Getting relevant context - input parameters', {
        userId,
        userIdType: typeof userId,
        userIdValue: JSON.stringify(userId),
        query,
        conversationId,
        limit
      });

      // Build ChromaDB where clause with proper validation
      const conversationWhere = {};
      
      // Convert userId to string and validate
      const userIdStr = userId?.toString?.() || String(userId || '');
      if (!userIdStr || userIdStr === 'undefined' || userIdStr === 'null' || userIdStr === '') {
        throw new Error(`Invalid userId for ChromaDB query: ${userId}`);
      }
      conversationWhere.user_id = userIdStr;
      
      // If we have a conversationId, add it to the filter
      if (conversationId) {
        const conversationIdStr = conversationId?.toString?.() || String(conversationId || '');
        if (conversationIdStr && conversationIdStr !== 'undefined' && conversationIdStr !== 'null' && conversationIdStr !== '') {
          conversationWhere.conversation_id = conversationIdStr;
        }
      }

      logger.debug('ChromaDB semantic search query parameters', {
        queryTexts: [query],
        nResults: Math.floor(limit * 0.7),
        where: conversationWhere,
        userIdType: typeof conversationWhere.user_id,
        conversationIdType: typeof conversationWhere.conversation_id
      });

      // Perform semantic search with embeddings
      const conversationResults = await this.collections.conversations.query({
        queryTexts: [query],
        nResults: Math.floor(limit * 0.7), // 70% from conversations
        where: conversationWhere,
        include: ['metadatas', 'documents', 'distances']
      });

      logger.debug('ChromaDB semantic search results', {
        documentsCount: conversationResults.documents?.[0]?.length || 0,
        idsCount: conversationResults.ids?.[0]?.length || 0,
        distances: conversationResults.distances?.[0] || [],
        avgDistance: conversationResults.distances?.[0]?.reduce((a, b) => a + b, 0) / (conversationResults.distances?.[0]?.length || 1)
      });

      // Search events for relevant context  
      let eventResults;
      const eventWhere = {};
      
      // Build proper where clause for events
      const eventUserIdStr = userId?.toString?.() || String(userId || '');
      if (!eventUserIdStr || eventUserIdStr === 'undefined' || eventUserIdStr === 'null' || eventUserIdStr === '') {
        logger.warn('No valid userId for event query, skipping events');
        eventResults = {
          documents: [[]],
          metadatas: [[]],
          ids: [[]],
          distances: [[]]
        };
      } else {
        eventWhere.user_id = eventUserIdStr;
        
        // Perform semantic search on events
        eventResults = await this.collections.events.query({
          queryTexts: [query],
          nResults: Math.floor(limit * 0.3), // 30% from events  
          where: eventWhere,
          include: ['metadatas', 'documents', 'distances']
        });
        
        logger.debug('Event semantic search results', {
          documentsCount: eventResults.documents?.[0]?.length || 0,
          avgDistance: eventResults.distances?.[0]?.reduce((a, b) => a + b, 0) / (eventResults.distances?.[0]?.length || 1)
        });
      }

      // Combine and format results
      const relevantMemories = [];

      // Add conversation memories
      if (conversationResults.documents && conversationResults.documents[0]) {
        conversationResults.documents[0].forEach((doc, index) => {
          relevantMemories.push({
            type: 'conversation',
            content: doc,
            metadata: conversationResults.metadatas[0][index],
            distance: conversationResults.distances[0][index]
          });
        });
      }

      // Add event memories
      if (eventResults.documents && eventResults.documents[0]) {
        eventResults.documents[0].forEach((doc, index) => {
          relevantMemories.push({
            type: 'event',
            content: doc,
            metadata: eventResults.metadatas[0][index],
            distance: eventResults.distances[0][index]
          });
        });
      }

      // Sort by relevance (lower distance = more relevant)
      relevantMemories.sort((a, b) => a.distance - b.distance);

      logger.debug('Retrieved relevant context', { 
        userId, 
        query, 
        memoryCount: relevantMemories.length 
      });

      return relevantMemories.slice(0, limit);

    } catch (error) {
      logger.error('Failed to get relevant context', { 
        userId, 
        query, 
        error: error.message 
      });
      return []; // Return empty array on error to avoid breaking chat
    }
  }

  /**
   * Get memories by filters
   */
  async getMemories({ userId, conversationId, type, limit = 20 }) {
    await this.ensureInitialized();

    try {
      let collection;
      
      // Build proper where clause with validation
      const userIdStr = userId?.toString?.() || String(userId || '');
      if (!userIdStr || userIdStr === 'undefined' || userIdStr === 'null' || userIdStr === '') {
        throw new Error(`Invalid userId for getMemories: ${userId}`);
      }
      
      const whereClause = { user_id: userIdStr };

      // Determine collection based on type
      if (type === 'conversation') {
        collection = this.collections.conversations;
        if (conversationId) {
          const conversationIdStr = conversationId?.toString?.() || String(conversationId || '');
          if (conversationIdStr && conversationIdStr !== 'undefined' && conversationIdStr !== 'null' && conversationIdStr !== '') {
            whereClause.conversation_id = conversationIdStr;
          }
        }
      } else if (type === 'event') {
        collection = this.collections.events;
      } else if (type === 'preference') {
        collection = this.collections.preferences;
      } else {
        // Search all conversations by default
        collection = this.collections.conversations;
      }

      const results = await collection.get({
        where: whereClause,
        limit: limit
      });

      const memories = [];
      if (results.documents) {
        results.documents.forEach((doc, index) => {
          memories.push({
            id: results.ids[index],
            content: doc,
            metadata: results.metadatas[index]
          });
        });
      }

      return memories;

    } catch (error) {
      logger.error('Failed to get memories', { userId, type, error: error.message });
      throw error;
    }
  }

  /**
   * Get recent conversation messages for context building
   */
  async getRecentConversation({ userId, conversationId, limit = 6 }) {
    await this.ensureInitialized();

    try {
      logger.debug('Getting recent conversation - input parameters', {
        userId,
        userIdType: typeof userId,
        userIdValue: JSON.stringify(userId),
        conversationId,
        conversationIdType: typeof conversationId,
        limit,
        collectionReady: !!this.collections.conversations
      });

      // Build ChromaDB where clause with proper data types
      const whereClause = {};
      
      // Convert userId to string and validate
      const userIdStr = userId?.toString?.() || String(userId || '');
      if (!userIdStr || userIdStr === 'undefined' || userIdStr === 'null' || userIdStr === '') {
        throw new Error(`Invalid userId for getRecentConversation: ${userId}`);
      }
      whereClause.user_id = userIdStr;
      
      // Convert conversationId to string and validate
      const conversationIdStr = conversationId?.toString?.() || String(conversationId || '');
      if (!conversationIdStr || conversationIdStr === 'undefined' || conversationIdStr === 'null' || conversationIdStr === '') {
        throw new Error(`Invalid conversationId for getRecentConversation: ${conversationId}`);
      }
      whereClause.conversation_id = conversationIdStr;

      logger.debug('ChromaDB get where clause', {
        where: whereClause,
        userIdType: typeof whereClause.user_id,
        conversationIdType: typeof whereClause.conversation_id
      });

      const results = await this.collections.conversations.get({
        where: whereClause,
        limit: limit
      });

      logger.debug('ChromaDB get results', {
        documentsCount: results.documents?.length || 0,
        idsCount: results.ids?.length || 0,
        metadatasCount: results.metadatas?.length || 0
      });

      const messages = [];
      if (results.documents) {
        // Combine documents with metadata, sorted by timestamp
        const combined = results.documents.map((doc, index) => ({
          document: doc,
          metadata: results.metadatas[index],
          id: results.ids[index]
        }));

        // Sort by timestamp (newest first, then reverse for chronological order)
        combined.sort((a, b) => {
          const timeA = new Date(a.metadata?.timestamp || 0);
          const timeB = new Date(b.metadata?.timestamp || 0);
          return timeA - timeB; // Chronological order
        });

        // Take the most recent messages and return in order
        const recentMessages = combined.slice(-limit);
        
        recentMessages.forEach(item => {
          messages.push({
            content: item.document,
            document: item.document,
            metadata: item.metadata,
            id: item.id
          });
        });
      }

      return messages;

    } catch (error) {
      logger.error('Failed to get recent conversation', { 
        userId, 
        conversationId, 
        error: error.message 
      });
      return []; // Return empty array on error
    }
  }

  /**
   * Get service status
   */
  async getStatus() {
    try {
      if (!this.isInitialized) {
        return { status: 'not_initialized' };
      }

      // Try to ping ChromaDB
      const heartbeat = await this.client.heartbeat();
      
      // Get collection stats
      const stats = {};
      for (const [name, collection] of Object.entries(this.collections)) {
        try {
          const count = await collection.count();
          stats[name] = { count };
        } catch (error) {
          stats[name] = { error: error.message };
        }
      }

      return {
        status: 'operational',
        chromadb: {
          heartbeat: heartbeat,
          url: process.env.CHROMADB_URL || 'http://localhost:8000'
        },
        collections: stats
      };

    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  /**
   * Browse memories - get recent memories by type
   */
  async browseMemories(userId, type = 'conversations', limit = 20) {
    try {
      await this.initialize();
      
      if (!userId) {
        throw new Error('UserId is required for browsing memories');
      }

      const collection = this.collections[type];
      
      if (!collection) {
        logger.warn(`Collection ${type} not found, available collections:`, Object.keys(this.collections));
        return [];
      }

      // Build proper where clause
      const userIdStr = userId?.toString?.() || String(userId || '');
      if (!userIdStr || userIdStr === 'undefined' || userIdStr === 'null' || userIdStr === '') {
        throw new Error(`Invalid userId for browsing memories: ${userId}`);
      }

      const whereClause = { user_id: userIdStr };
      logger.debug('Browsing memories', { userId: userIdStr, type, limit, whereClause });

      // Get recent memories for this user
      const results = await collection.get({
        where: whereClause,
        limit: parseInt(limit),
        include: ['metadatas', 'documents']
      });

      if (!results || !results.ids || results.ids.length === 0) {
        logger.debug('No memories found for user', { userId: userIdStr, type });
        return [];
      }

      // Format results
      const memories = results.ids.map((id, index) => ({
        id,
        content: results.documents[index],
        metadata: results.metadatas ? results.metadatas[index] : {},
        type
      }));

      logger.debug(`Retrieved ${memories.length} memories for browsing`, { userId: userIdStr, type });
      return memories;

    } catch (error) {
      logger.error('Error browsing memories', { 
        error: error.message,
        userId,
        type,
        limit
      });
      return [];
    }
  }

  /**
   * Search memories - semantic search across memories
   */
  async searchMemories(userId, query, type = 'conversations', limit = 20) {
    try {
      await this.initialize();
      
      if (!userId || !query) {
        throw new Error('UserId and query are required for searching memories');
      }

      const collection = this.collections[type];
      
      if (!collection) {
        logger.warn(`Collection ${type} not found, available collections:`, Object.keys(this.collections));
        return [];
      }

      // Build proper where clause
      const userIdStr = userId?.toString?.() || String(userId || '');
      if (!userIdStr || userIdStr === 'undefined' || userIdStr === 'null' || userIdStr === '') {
        throw new Error(`Invalid userId for searching memories: ${userId}`);
      }

      const whereClause = { user_id: userIdStr };
      logger.debug('Searching memories', { userId: userIdStr, query: query.substring(0, 100), type, limit, whereClause });

      // Perform semantic search
      const results = await collection.query({
        queryTexts: [query],
        nResults: parseInt(limit),
        where: whereClause,
        include: ['metadatas', 'documents', 'distances']
      });
      
      logger.debug('Semantic search completed', {
        query: query.substring(0, 50),
        resultsCount: results.ids?.[0]?.length || 0,
        avgDistance: results.distances?.[0]?.reduce((a, b) => a + b, 0) / (results.distances?.[0]?.length || 1)
      });

      if (!results || !results.ids || results.ids.length === 0 || !results.ids[0] || results.ids[0].length === 0) {
        logger.debug('No matching memories found', { userId: userIdStr, query: query.substring(0, 50), type });
        return [];
      }

      // Format results (query returns nested arrays)
      const memories = results.ids[0].map((id, index) => ({
        id,
        content: results.documents[0][index],
        metadata: results.metadatas ? results.metadatas[0][index] : {},
        distance: results.distances ? results.distances[0][index] : null,
        type,
        relevanceScore: results.distances ? (1 - results.distances[0][index]) : null
      }));

      logger.debug(`Found ${memories.length} matching memories`, { userId: userIdStr, type });
      return memories;

    } catch (error) {
      logger.error('Error searching memories', { 
        error: error.message,
        userId,
        query: query ? query.substring(0, 100) : 'undefined',
        type,
        limit
      });
      return [];
    }
  }


}

module.exports = new MemoryService();