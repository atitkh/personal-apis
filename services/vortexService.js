const memoryService = require('./memoryService');
const llmService = require('./llmService');
const logger = require('../utils/logger');
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
  async processChat({ userId, message, conversationId, context = {} }) {
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
        limit: 10
      });

      // Build conversation context for LLM
      const conversationContext = await this.buildConversationContext({
        currentMessage: message,
        conversationId,
        relevantMemories,
        userContext: context
      });

      // Get LLM response
      const llmResponse = await llmService.generateResponse({
        messages: conversationContext,
        userId,
        systemPrompt: this.buildSystemPrompt(userId)
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

      return {
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
   * Build system prompt for Vortex personality
   */
  buildSystemPrompt(userId) {
    return `You are ${this.personality.name}, a personal AI assistant for ${userId}.

Your characteristics:
${this.personality.traits.map(trait => `- ${trait}`).join('\n')}

You have access to the user's conversation history and can remember previous interactions. 
You can control smart home devices, help with coding projects, and assist with various tasks.

Always be helpful, concise, and maintain context from previous conversations.
If you can help with smart home control, coding questions, or other technical tasks, offer to do so.

Current date: ${new Date().toISOString().split('T')[0]}`;
  }

  /**
   * Build conversation context for LLM
   */
  async buildConversationContext({ currentMessage, conversationId, relevantMemories, userContext }) {
    const context = [];

    // Add relevant memories as context
    if (relevantMemories.length > 0) {
      const memoryContext = relevantMemories
        .map(memory => `Previous: ${memory.content}`)
        .join('\n');
      
      context.push({
        role: 'system',
        content: `Relevant conversation history:\n${memoryContext}`
      });
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