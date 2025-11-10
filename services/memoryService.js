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

      // Create/get collections for different memory types
      this.collections.conversations = await this.client.getOrCreateCollection({
        name: 'vortex_conversations',
        metadata: { description: 'Chat conversations and messages' }
      });

      this.collections.events = await this.client.getOrCreateCollection({
        name: 'vortex_events', 
        metadata: { description: 'Significant events and actions' }
      });

      this.collections.preferences = await this.client.getOrCreateCollection({
        name: 'vortex_preferences',
        metadata: { description: 'User preferences and patterns' }
      });

      this.collections.context = await this.client.getOrCreateCollection({
        name: 'vortex_context',
        metadata: { description: 'Session and contextual information' }
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
        user_id: userId,
        source: context.source || 'api',
        conversation_id: conversationId,
        role: role,
        message_length: content.length,
        ...context
      };

      await this.collections.conversations.add({
        ids: [id],
        documents: [content],
        metadatas: [metadata]
      });

      logger.debug('Conversation stored', { id, role, userId });
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
        user_id: userId,
        source: context.source || 'system',
        event_type: eventType,
        domain: domain,
        user_intent: userIntent,
        system_response: systemResponse,
        ...context
      };

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
      // Search conversations for relevant context - FIXED: Include conversationId filter
      const conversationWhere = {
        user_id: userId
      };
      
      // If we have a conversationId, prioritize current conversation context
      if (conversationId) {
        conversationWhere.conversation_id = conversationId;
      }

      const conversationResults = await this.collections.conversations.query({
        queryTexts: [query],
        nResults: Math.floor(limit * 0.7), // 70% from conversations
        where: conversationWhere
      });

      // Search events for relevant context  
      const eventResults = await this.collections.events.query({
        queryTexts: [query],
        nResults: Math.floor(limit * 0.3), // 30% from events  
        where: {
          user_id: userId
        }
      });

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
      let whereClause = { user_id: userId };

      // Determine collection based on type
      if (type === 'conversation') {
        collection = this.collections.conversations;
        if (conversationId) {
          whereClause.conversation_id = conversationId;
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
      const results = await this.collections.conversations.get({
        where: {
          user_id: userId,
          conversation_id: conversationId
        },
        limit: limit
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
}

module.exports = new MemoryService();