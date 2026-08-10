const vortexService = require('../services/vortexService');
const memoryService = require('../services/memoryService');
const { logger } = require('../utils/logger');

class VortexController {
  /**
   * Main chat endpoint - handles conversation with Vortex AI
   */
  async chat(req, res, next) {
    try {
      const { message, conversation_id, context } = req.body;
      // Check both body and query param for debug flag
      const debug = req.body.debug || req.query.debug === 'true';
      const userId = req.user._id || req.user.id; // Handle both _id and id formats

      logger.info('Vortex chat request - user details', {
        correlationId: req.correlationId,
        userId,
        userIdType: typeof userId,
        userObject: JSON.stringify(req.user),
        messageLength: message.length,
        conversationId: conversation_id,
        debugMode: debug || false
      });

      // Process the chat request through Vortex service
      const result = await vortexService.processChat({
        userId,
        message,
        conversationId: conversation_id,
        context: {
          ...context,
          source: 'api',
          userAgent: req.get('User-Agent'),
          ip: req.ip,
          user: req.user  // Pass user info for system prompt
        },
        debug: debug || false
      });

      logger.info('Vortex chat completed', {
        correlationId: req.correlationId,
        userId,
        conversationId: result.conversation_id,
        responseLength: result.response.length
      });

      const responseData = {
        response: result.response,
        conversation_id: result.conversation_id,
        metadata: result.metadata,
        memory_intelligence: result.memory_intelligence
      };

      // Include debug information if requested
      if (debug && result.debug) {
        responseData.debug = result.debug;
      }

      res.success(responseData, 'Chat processed successfully');

    } catch (error) {
      logger.error('Vortex chat error', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Debug chat endpoint - always includes debug information
   */
  async debugChat(req, res, next) {
    try {
      const { message, conversation_id, context } = req.body;
      const userId = req.user._id || req.user.id; // Handle both _id and id formats

      logger.info('Vortex debug chat request', {
        correlationId: req.correlationId,
        userId,
        messageLength: message.length,
        conversationId: conversation_id
      });

      // Always enable debug mode
      const result = await vortexService.processChat({
        userId,
        message,
        conversationId: conversation_id,
        context: {
          ...context,
          source: 'debug-api',
          userAgent: req.get('User-Agent'),
          ip: req.ip,
          user: req.user  // Pass user info for system prompt
        },
        debug: true
      });

      logger.info('Vortex debug chat completed', {
        correlationId: req.correlationId,
        userId,
        conversationId: result.conversation_id,
        responseLength: result.response.length,
        debugDataIncluded: !!result.debug
      });

      res.success({
        response: result.response,
        conversation_id: result.conversation_id,
        metadata: result.metadata,
        debug: result.debug
      }, 'Debug chat processed successfully');

    } catch (error) {
      logger.error('Vortex debug chat error', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Debug conversation data endpoint
   */
  async debugConversation(req, res, next) {
    try {
      const { conversation_id } = req.params;
      const userId = req.user._id || req.user.id; // Handle both _id and id formats

      logger.info('Debug conversation request', {
        conversation_id,
        userId,
        userIdType: typeof userId
      });

      const memoryService = require('../services/memoryService');
      
      // Get recent conversation data
      const recentMessages = await memoryService.getRecentConversation({
        userId: userId?.toString(),
        conversationId: conversation_id,
        limit: 10
      });

      // Get relevant memories for a test query
      const relevantMemories = await memoryService.getRelevantContext({
        userId: userId?.toString(),
        query: "coffee preferences",
        conversationId: conversation_id,
        limit: 10
      });

      // Also try getting all memories for this user to see if anything is stored
      const allUserMemories = await memoryService.getRelevantContext({
        userId: userId?.toString(),
        query: "morning coffee",
        limit: 20
      });

      res.json({
        conversation_id,
        userId: userId?.toString(),
        recent_messages: {
          count: recentMessages.length,
          messages: recentMessages.map(msg => ({
            role: msg.metadata?.role,
            content: msg.content || msg.document || '[no content]',
            timestamp: msg.metadata?.timestamp,
            conversation_id: msg.metadata?.conversation_id
          }))
        },
        relevant_memories: {
          count: relevantMemories.length,
          memories: relevantMemories.map(mem => ({
            type: mem.type,
            content: mem.content || mem.document || '[no content]',
            conversation_id: mem.metadata?.conversation_id,
            distance: mem.distance
          }))
        },
        all_user_memories: {
          count: allUserMemories.length,
          memories: allUserMemories.slice(0, 5).map(mem => ({
            type: mem.type,
            content: mem.content || mem.document || '[no content]',
            conversation_id: mem.metadata?.conversation_id,
            user_id: mem.metadata?.user_id,
            distance: mem.distance
          }))
        }
      });

    } catch (error) {
      logger.error('Debug conversation error', {
        error: error.message,
        userId: req.user?.id
      });
      next(error);
    }
  }

  /**
   * Test endpoint to manually store conversation data
   */
  async testStoreConversation(req, res, next) {
    try {
      const { message, conversation_id } = req.body;
      const userId = req.user._id || req.user.id; // Handle both _id and id formats

      logger.info('Test store conversation', {
        userId: userId?.toString(),
        conversationId: conversation_id,
        messageLength: message?.length
      });

      const memoryService = require('../services/memoryService');
      
      // Try to store a test conversation
      const result = await memoryService.storeConversation({
        userId: userId?.toString(),
        conversationId: conversation_id,
        role: 'user',
        content: message,
        context: { source: 'test' }
      });

      // Try to retrieve it immediately
      const retrieved = await memoryService.getRecentConversation({
        userId: userId?.toString(),
        conversationId: conversation_id,
        limit: 10
      });

      res.json({
        stored_id: result,
        retrieved_count: retrieved.length,
        retrieved_messages: retrieved.map(msg => ({
          content: msg.content,
          role: msg.metadata?.role,
          user_id: msg.metadata?.user_id,
          conversation_id: msg.metadata?.conversation_id
        }))
      });

    } catch (error) {
      logger.error('Test store conversation error', {
        error: error.message,
        userId: req.user?.id
      });
      next(error);
    }
  }

  /**
   * Retrieve memory records
   */
  async getMemory(req, res, next) {
    try {
      const { conversation_id, type, limit = 20 } = req.query;
      const userId = req.user._id || req.user.id; // Handle both _id and id formats

      const memories = await memoryService.getMemories({
        userId,
        conversationId: conversation_id,
        type,
        limit: parseInt(limit)
      });

      res.success({
        memories,
        count: memories.length
      }, 'Memories retrieved successfully');

    } catch (error) {
      logger.error('Memory retrieval error', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Browse memories - get recent memories by type
   */
  async browseMemories(req, res, next) {
    try {
      const { type = 'conversations', limit = 20 } = req.query;
      const userId = req.user._id || req.user.id;

      logger.info('Browse memories request', {
        correlationId: req.correlationId,
        userId,
        type,
        limit
      });

      const memories = await memoryService.browseMemories(userId, type, parseInt(limit));

      res.success({
        memories,
        type,
        count: memories.length,
        userId
      }, `Retrieved ${memories.length} ${type} memories`);

    } catch (error) {
      logger.error('Browse memories error', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Search memories - semantic search across memories
   */
  async searchMemories(req, res, next) {
    try {
      const { query, type = 'conversations', limit = 20 } = req.body;
      const userId = req.user._id || req.user.id;

      if (!query) {
        return res.badRequest('Search query is required');
      }

      logger.info('Search memories request', {
        correlationId: req.correlationId,
        userId,
        query: query.substring(0, 100), // Log first 100 chars only
        type,
        limit
      });

      const memories = await memoryService.searchMemories(userId, query, type, parseInt(limit));

      res.success({
        memories,
        query,
        type,
        count: memories.length,
        userId
      }, `Found ${memories.length} matching memories`);

    } catch (error) {
      logger.error('Search memories error', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Get Vortex system status
   */
  async getStatus(req, res, next) {
    try {
      const status = await vortexService.getSystemStatus();
      
      res.success(status, 'System status retrieved');

    } catch (error) {
      logger.error('Status check error', {
        correlationId: req.correlationId,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Summarize a conversation and extract key information
   */
  async summarizeConversation(req, res, next) {
    try {
      const { conversation_id } = req.params;
      const userId = req.user._id || req.user.id;
      const { forceRegenerate } = req.body || {};

      logger.info('Summarize conversation request', {
        correlationId: req.correlationId,
        userId,
        conversationId: conversation_id,
        forceRegenerate
      });

      const result = await vortexService.summarizeAndCompactConversation({
        userId: userId?.toString(),
        conversationId: conversation_id,
        forceRegenerate: forceRegenerate || false
      });

      if (result.skipped) {
        res.success(result, 'Summarization skipped');
      } else if (result.success) {
        res.success(result, 'Conversation summarized successfully');
      } else {
        res.status(500).json({
          success: false,
          error: result.error,
          message: 'Summarization failed'
        });
      }

    } catch (error) {
      logger.error('Summarize conversation error', {
        correlationId: req.correlationId,
        userId: req.user?.id,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Get memory intelligence status
   */
  async getMemoryIntelligenceStatus(req, res, next) {
    try {
      const status = await vortexService.getMemoryIntelligenceStatus();
      
      res.success(status, 'Memory intelligence status retrieved');

    } catch (error) {
      logger.error('Memory intelligence status error', {
        correlationId: req.correlationId,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Get all knowledge documents
   */
  async browseKnowledge(req, res, next) {
    try {
      const { limit, category } = req.query;

      logger.info('Browse knowledge request', {
        correlationId: req.correlationId,
        limit,
        category
      });

      const result = await memoryService.browseKnowledge({
        limit: limit ? parseInt(limit) : 100,
        category: category || null
      });

      res.success(result, 'Knowledge documents retrieved');

    } catch (error) {
      logger.error('Browse knowledge error', {
        correlationId: req.correlationId,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Add a knowledge document
   */
  async addKnowledge(req, res, next) {
    try {
      const { content, title, category, source, metadata } = req.body;

      if (!content || !title) {
        return res.status(400).json({
          success: false,
          error: 'Content and title are required'
        });
      }

      logger.info('Add knowledge request', {
        correlationId: req.correlationId,
        title,
        category,
        contentLength: content.length
      });

      const result = await memoryService.storeKnowledge({
        content,
        title,
        category: category || 'general',
        source: source || 'manual',
        metadata: metadata || {}
      });

      if (result.skipped) {
        res.success(result, 'Knowledge document skipped (duplicate)');
      } else {
        res.success(result, 'Knowledge document added successfully');
      }

    } catch (error) {
      logger.error('Add knowledge error', {
        correlationId: req.correlationId,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Delete a knowledge document
   */
  async deleteKnowledge(req, res, next) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'Knowledge document ID is required'
        });
      }

      logger.info('Delete knowledge request', {
        correlationId: req.correlationId,
        id
      });

      const result = await memoryService.deleteKnowledge(id);

      res.success(result, 'Knowledge document deleted successfully');

    } catch (error) {
      logger.error('Delete knowledge error', {
        correlationId: req.correlationId,
        error: error.message
      });
      next(error);
    }
  }

  /**
   * Search knowledge documents
   */
  async searchKnowledge(req, res, next) {
    try {
      const { query, limit } = req.query;

      if (!query) {
        return res.status(400).json({
          success: false,
          error: 'Search query is required'
        });
      }

      logger.info('Search knowledge request', {
        correlationId: req.correlationId,
        query,
        limit
      });

      await memoryService.ensureInitialized();
      
      const results = await memoryService.collections.knowledge.query({
        queryTexts: [query],
        nResults: limit ? parseInt(limit) : 10,
        include: ['metadatas', 'documents', 'distances']
      });

      const documents = [];
      if (results.documents?.[0]) {
        results.documents[0].forEach((doc, index) => {
          documents.push({
            id: results.ids[0][index],
            content: doc,
            metadata: results.metadatas?.[0]?.[index] || {},
            distance: results.distances?.[0]?.[index],
            title: results.metadatas?.[0]?.[index]?.title || 'Untitled'
          });
        });
      }

      res.success({ documents, count: documents.length, query }, 'Knowledge search completed');

    } catch (error) {
      logger.error('Search knowledge error', {
        correlationId: req.correlationId,
        error: error.message
      });
      next(error);
    }
  }
}

module.exports = new VortexController();