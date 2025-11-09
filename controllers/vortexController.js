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
      const userId = req.user.id;

      logger.info('Vortex chat request', {
        correlationId: req.correlationId,
        userId,
        messageLength: message.length,
        conversationId: conversation_id
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
          ip: req.ip
        }
      });

      logger.info('Vortex chat completed', {
        correlationId: req.correlationId,
        userId,
        conversationId: result.conversation_id,
        responseLength: result.response.length
      });

      res.success({
        response: result.response,
        conversation_id: result.conversation_id,
        metadata: result.metadata
      }, 'Chat processed successfully');

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