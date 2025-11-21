const memoryService = require('./memoryService');
const llmService = require('./llmService');
const { logger } = require('../utils/logger');
const crypto = require('crypto');

class VortexService {
  constructor() {
    this.personality = {
      name: "Vortex",
      role: "Personal AI Assistant",
      description: "A proactive personal AI assistant with excellent memory and technical expertise",
      traits: [
        "Helpful and knowledgeable",
        "Direct but friendly communication",
        "Excellent memory for context",
        "Proactive in offering assistance",
        "Technical expertise in development"
      ]
    };
  }

  /**
   * Process a chat message through the full Vortex pipeline
   */
  async processChat({ userId, message, conversationId, context = {}, debug = false }) {
    try {
      // Generate conversation ID if not provided
      if (!conversationId) {
        conversationId = `conv_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      }

      // Store the user message in memory
      await memoryService.storeConversation({
        userId,
        conversationId,
        role: 'user',
        content: message,
        context
      });

      // Retrieve relevant context from memory
      const relevantMemories = await memoryService.getRelevantContext({
        userId,
        query: message,
        conversationId,
        limit: 5 // Reduced to prevent information overload
      });

      // Build conversation context for LLM
      const conversationContext = await this.buildConversationContext({
        currentMessage: message,
        conversationId,
        relevantMemories,
        userContext: context
      });

      // Build proper system prompt with memory context using llmService
      const systemPrompt = llmService.buildSystemPrompt({
        userContext: context.user || { name: 'User' },
        relevantMemories,
        currentTime: new Date().toISOString(),
        personality: this.personality
      });

      // Capture debug information if requested
      let debugInfo = null;
      if (debug) {
        debugInfo = {
          prompt: {
            system: systemPrompt,
            messages: conversationContext,
            message_count: conversationContext.length,
            total_chars: JSON.stringify(conversationContext).length
          },
          memory: {
            relevant_memories_count: relevantMemories.length,
            memories: relevantMemories.map(m => ({
              type: m.metadata?.type,
              content_preview: m.document?.substring(0, 100) + '...',
              distance: m.distance
            }))
          },
          timestamp: new Date().toISOString()
        };
      }

      // Get LLM response with focused parameters
      const llmResponse = await llmService.generateResponse({
        messages: conversationContext,
        userId,
        systemPrompt,
        temperature: 0.3, // Lower temperature for more focused responses
        maxTokens: 500    // Shorter response length to encourage conciseness
      });

      // Store the assistant response in memory
      await memoryService.storeConversation({
        userId,
        conversationId,
        role: 'assistant',
        content: llmResponse.content,
        context: {
          ...context,
          model_used: llmResponse.model,
          tokens_used: llmResponse.usage?.total_tokens
        }
      });

      // Extract any action commands using LLM classification
      const detectedActions = await llmService.extractActionCommands(message);
      
      // Process detected actions
      for (const action of detectedActions) {
        await this.handleDetectedAction(action, llmResponse.content, userId, conversationId, context);
      }

      // Add LLM response to debug info if debug mode is enabled
      if (debug && debugInfo) {
        debugInfo.llm_response = {
          model: llmResponse.model,
          tokens_used: llmResponse.usage?.total_tokens,
          response_chars: llmResponse.content.length,
          actions_detected: detectedActions.length,
          actions: detectedActions.map(a => ({ type: a.type, content: a.content?.substring(0, 50) + '...' }))
        };
      }

      const result = {
        response: llmResponse.content,
        conversation_id: conversationId,
        actions: detectedActions,
        metadata: {
          tokens_used: llmResponse.usage?.total_tokens,
          model: llmResponse.model,
          memories_retrieved: relevantMemories.length,
          actions_detected: detectedActions.length,
          timestamp: new Date().toISOString()
        }
      };

      // Include debug info if requested
      if (debug && debugInfo) {
        result.debug = debugInfo;
      }

      return result;

    } catch (error) {
      logger.error('Vortex chat processing error', { 
        userId, 
        conversationId, 
        error: error.message 
      });
      throw error;
    }
  }



  /**
   * Build conversation context for LLM
   */
  async buildConversationContext({ currentMessage, conversationId, relevantMemories, userContext }) {
    const context = [];

    // Don't add memories here - they're handled in the system prompt via llmService.buildSystemPrompt
    // This prevents duplication of memory context

    // Get recent conversation turns from this session
    try {
      const recentMessages = await memoryService.getRecentConversation({
        userId: userContext.user?._id?.toString() || userContext.userId || userContext.user,
        conversationId,
        limit: 4 // Last 2 exchanges (4 messages) - reduced to prevent repetitive context
      });
      
      // Add recent conversation turns
      if (recentMessages.length > 0) {
        recentMessages.forEach(msg => {
          const role = msg.metadata?.role || 'user';
          context.push({
            role: role === 'assistant' ? 'assistant' : 'user',
            content: msg.document || msg.content
          });
        });
      }
    } catch (error) {
      // If recent messages retrieval fails, continue without them
      console.warn('Could not retrieve recent messages:', error.message);
    }

    // Add current message
    context.push({
      role: 'user',
      content: currentMessage
    });

    return context;
  }

  /**
   * Handle detected action commands using LLM classification
   */
  async handleDetectedAction(action, assistantResponse, userId, conversationId, context) {
    try {
      const { type, content, confidence } = action;
      
      logger.info('Processing detected action', {
        userId,
        actionType: type,
        content,
        confidence
      });

      switch (type) {
        case 'remember':
          // Store as preference or important information
          await memoryService.storeEvent({
            userId,
            eventType: 'information_storage',
            domain: 'preferences',
            userIntent: `Remember: ${content}`,
            systemResponse: assistantResponse,
            context: {
              ...context,
              action_type: 'remember',
              confidence
            }
          });
          break;

        case 'remind':
          // Store as reminder/note
          await memoryService.storeEvent({
            userId,
            eventType: 'reminder_set',
            domain: 'productivity',
            userIntent: `Remind: ${content}`,
            systemResponse: assistantResponse,
            context: {
              ...context,
              action_type: 'remind',
              confidence
            }
          });
          break;

        case 'search':
          // Log search request for learning patterns
          await memoryService.storeEvent({
            userId,
            eventType: 'memory_search',
            domain: 'information_retrieval',
            userIntent: `Search: ${content}`,
            systemResponse: assistantResponse,
            context: {
              ...context,
              action_type: 'search',
              confidence
            }
          });
          break;

        case 'note':
          // Store general note
          await memoryService.storeEvent({
            userId,
            eventType: 'note_creation',
            domain: 'general',
            userIntent: `Note: ${content}`,
            systemResponse: assistantResponse,
            context: {
              ...context,
              action_type: 'note',
              confidence
            }
          });
          break;

        default:
          logger.warn('Unknown action type detected', { type, content });
      }

    } catch (error) {
      logger.error('Action handling error', {
        userId,
        action,
        error: error.message
      });
    }
  }

  /**
   * Get system status
   */
  async getSystemStatus() {
    try {
      const memoryStatus = await memoryService.getStatus();
      const llmStatus = await llmService.getStatus();

      return {
        vortex: {
          status: 'operational',
          version: '1.0.0',
          personality: this.personality.name
        },
        memory: memoryStatus,
        llm: llmStatus,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Status check error', { error: error.message });
      return {
        vortex: {
          status: 'error',
          error: error.message
        },
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get personality configuration (exposed for testing)
   */
  getPersonality() {
    return this.personality;
  }

  /**
   * Extract action commands from messages (exposed for testing)
   */
  async extractActionCommands(message) {
    return await llmService.extractActionCommands(message);
  }
}

module.exports = new VortexService();