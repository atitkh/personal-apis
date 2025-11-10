const vortexService = require('../services/vortexService');
const memoryService = require('../services/memoryService');
const { logger } = require('../utils/logger');

class VortexController {
  /**
   * Main chat endpoint - handles conversation with Vortex AI
   */
  async chat(req, res, next) {
    try {
      const { message, conversation_id, context, debug } = req.body;
      const userId = req.user.id;

      logger.info('Vortex chat request', {
        correlationId: req.correlationId,
        userId,
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
        metadata: result.metadata
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
      const userId = req.user.id;

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
      const userId = req.user.id;

      const memoryService = require('../services/memoryService');
      
      // Get recent conversation data
      const recentMessages = await memoryService.getRecentConversation({
        userId,
        conversationId: conversation_id,
        limit: 10
      });

      // Get relevant memories for a test query
      const relevantMemories = await memoryService.getRelevantContext({
        userId,
        query: "coffee preferences",
        conversationId: conversation_id,
        limit: 10
      });

      res.json({
        conversation_id,
        userId,
        recent_messages: {
          count: recentMessages.length,
          messages: recentMessages.map(msg => ({
            role: msg.metadata?.role,
            content: msg.content?.substring(0, 100) + '...',
            timestamp: msg.metadata?.timestamp,
            conversation_id: msg.metadata?.conversation_id
          }))
        },
        relevant_memories: {
          count: relevantMemories.length,
          memories: relevantMemories.map(mem => ({
            type: mem.type,
            content: mem.content?.substring(0, 100) + '...',
            conversation_id: mem.metadata?.conversation_id,
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
   * Retrieve memory records
   */
  async getMemory(req, res, next) {
    try {
      const { conversation_id, type, limit = 20 } = req.query;
      const userId = req.user.id;

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
}

module.exports = new VortexController();