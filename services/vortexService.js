const memoryService = require('./memoryService');
const llmService = require('./llmService');
const memoryIntelligence = require('./memoryIntelligenceService');
const { logger } = require('../utils/logger');
const crypto = require('crypto');

class VortexService {
  constructor() {
    this.personality = {
      name: "Vortex",
      role: "friend",
      description: "a chill friend who happens to remember everything and knows a lot about tech",
      traits: [
        "Casual and genuine",
        "Gets straight to the point",
        "Remembers past conversations naturally",
        "Knows tech stuff but doesn't show off",
        "Talks like a real person, not a robot"
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

      // Validate message content
      const messageContent = message?.trim() || '';
      if (!messageContent) {
        logger.warn('Empty message received in processChat', { userId, conversationId, source: context.source });
      }

      logger.debug('Processing chat message', {
        userId,
        conversationId,
        messageLength: messageContent.length,
        messagePreview: messageContent.substring(0, 100),
        source: context.source
      });

      // STEP 1: Evaluate message importance (for storage decisions later, doesn't store yet)
      let userMessageEvaluation = null;
      let storageDecisions = []; // Track what we stored for debugging
      
      if (messageContent) {
        try {
          userMessageEvaluation = await memoryIntelligence.evaluateMessage({
            message: messageContent,
            role: 'user',
            context: {
              previousMessage: context.lastAssistantMessage || null,
              conversationSummary: context.conversationSummary || null
            }
          });

          logger.debug('User message evaluation', {
            importance: userMessageEvaluation.importance,
            category: userMessageEvaluation.category,
            shouldStore: userMessageEvaluation.shouldStore,
            storageType: userMessageEvaluation.storageType
          });
        } catch (evalError) {
          logger.warn('Message evaluation failed, using default storage', { error: evalError.message });
          userMessageEvaluation = { shouldStore: true, storageType: 'conversations', importance: 5, category: 'context' };
        }
      }

      // STEP 2: Retrieve relevant context BEFORE storing (to avoid self-references)
      let relevantMemories = [];
      let queryEnhancementDebug = null;
      try {
        // Enhance the query for better retrieval
        const enhancedQuery = await memoryIntelligence.enhanceQuery(
          messageContent || 'general conversation',
          { conversationId }
        );

        // Store for debug output
        queryEnhancementDebug = {
          originalQuery: messageContent,
          enhancedQueries: enhancedQuery.queries,
          keywords: enhancedQuery.keywords,
          categories: enhancedQuery.categories,
          timeframe: enhancedQuery.timeframe
        };

        logger.debug('Enhanced query for retrieval', {
          original: messageContent?.substring(0, 50),
          queries: enhancedQuery.queries,
          categories: enhancedQuery.categories
        });

        // Retrieve memories using all enhanced queries
        const allMemories = [];
        for (const query of enhancedQuery.queries.slice(0, 3)) { // Limit to top 3 queries
          const memories = await memoryService.getRelevantContext({
            userId,
            query,
            conversationId,
            limit: 10 // Increased from 5 - retrieve more, filter by relevance
          });
          allMemories.push(...memories);
        }

        // RELEVANCE THRESHOLD FILTER - Industry standard approach
        // Only include memories that are actually relevant (distance < 1.4)
        // Distance: 0 = perfect match, 1 = unrelated, >1 = very different
        // Using 1.4 while memory is building up - can tighten later
        const RELEVANCE_THRESHOLD = 1.4;
        const relevantOnly = allMemories.filter(m => {
          const distance = m.distance || 1;
          return distance < RELEVANCE_THRESHOLD;
        });

        // Console log for debugging
        console.log('\n🔍 RELEVANCE FILTER:');
        console.log(`  Retrieved: ${allMemories.length} memories`);
        console.log(`  After threshold (< ${RELEVANCE_THRESHOLD}): ${relevantOnly.length} memories`);
        console.log(`  Filtered out: ${allMemories.length - relevantOnly.length} irrelevant memories`);
        if (allMemories.length > 0) {
          console.log('  Distance range:', {
            min: Math.min(...allMemories.map(m => m.distance || 1)).toFixed(3),
            max: Math.max(...allMemories.map(m => m.distance || 1)).toFixed(3)
          });
        }

        logger.debug('Relevance filtering', {
          before: allMemories.length,
          after: relevantOnly.length,
          threshold: RELEVANCE_THRESHOLD,
          filtered: allMemories.length - relevantOnly.length
        });

        // Deduplicate by content
        const seenContent = new Set();
        const uniqueMemories = relevantOnly.filter(m => {
          const key = (m.content || m.document || '').substring(0, 100);
          if (seenContent.has(key)) return false;
          seenContent.add(key);
          return true;
        });

        // Re-rank memories for relevance (increased output limit)
        if (uniqueMemories.length > 5) {
          relevantMemories = await memoryIntelligence.rerankMemories(
            messageContent,
            uniqueMemories,
            8 // Increased from 5 - more context for complex queries
          );
        } else {
          relevantMemories = uniqueMemories;
        }

        // Sort memories chronologically (oldest first) so LLM understands the timeline
        // Distance was already used for selection/ranking, now order by time for display
        relevantMemories.sort((a, b) => {
          const timeA = new Date(a.metadata?.timestamp || 0);
          const timeB = new Date(b.metadata?.timestamp || 0);
          return timeA - timeB;
        });

        logger.debug('Smart retrieval complete', {
          totalRetrieved: allMemories.length,
          afterDedup: uniqueMemories.length,
          afterRerank: relevantMemories.length
        });

      } catch (retrievalError) {
        logger.warn('Smart retrieval failed, using basic retrieval', { error: retrievalError.message });
        // Fallback to basic retrieval
        relevantMemories = await memoryService.getRelevantContext({
          userId,
          query: messageContent || 'general conversation',
          conversationId,
          limit: 10
        });
        // Apply relevance threshold even in fallback
        relevantMemories = relevantMemories.filter(m => (m.distance || 1) < 1.4);
      }

      // Build conversation context for LLM
      const conversationContext = await this.buildConversationContext({
        currentMessage: messageContent,
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
              type: m.type || m.metadata?.type,
              content_preview: (m.content || m.document)?.substring(0, 100) + '...',
              distance: m.distance
            }))
          },
          memory_intelligence: {
            user_message_evaluation: userMessageEvaluation ? {
              importance: userMessageEvaluation.importance,
              category: userMessageEvaluation.category,
              shouldStore: userMessageEvaluation.shouldStore,
              storageType: userMessageEvaluation.storageType,
              summary: userMessageEvaluation.summary,
              keyFacts: userMessageEvaluation.keyFacts,
              reasoning: userMessageEvaluation.reasoning
            } : null,
            query_enhancement: queryEnhancementDebug
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

      // STEP 4: NOW store messages (after LLM response, so retrieval wasn't polluted)
      // Store user message based on evaluation
      if (messageContent && userMessageEvaluation) {
        const { importance, category, keyFacts, summary, storageType } = userMessageEvaluation;
        
        // HIGH IMPORTANCE (7-10): Store key facts appropriately + full message
        if (importance >= 7) {
          // Store extracted key facts based on category
          if (keyFacts && keyFacts.length > 0) {
            for (const fact of keyFacts) {
              let result;
              
              // Route facts to the appropriate collection
              if (['fact', 'relationship'].includes(category) || storageType === 'facts') {
                // Store as fact (name, location, relationships, etc.)
                result = await memoryService.storeFact({
                  userId,
                  fact: fact,
                  category: category,
                  context: { 
                    ...context, 
                    importance,
                    extractedFrom: 'conversation' 
                  }
                });
                if (result.skipped) {
                  storageDecisions.push({ type: 'fact', content: fact.substring(0, 30), importance, skipped: true, reason: 'duplicate' });
                } else {
                  storageDecisions.push({ type: 'fact', content: fact.substring(0, 30), importance, stored: true });
                }
              } else {
                // Store as preference (likes, dislikes, instructions)
                result = await memoryService.storePreference({
                  userId,
                  category: category,
                  preference: fact,
                  context: { 
                    ...context, 
                    importance,
                    extractedFrom: 'conversation' 
                  }
                });
                if (result.skipped) {
                  storageDecisions.push({ type: 'preference', content: fact.substring(0, 30), importance, skipped: true, reason: 'duplicate' });
                } else {
                  storageDecisions.push({ type: 'preference', content: fact.substring(0, 30), importance, stored: true });
                }
              }
            }
          }
          
          // Store in events if it's an event/task category
          if (['event', 'task', 'reminder'].includes(category)) {
            const result = await memoryService.storeEvent({
              userId,
              eventType: category,
              domain: 'user_stated',
              userIntent: summary || messageContent,
              systemResponse: llmResponse.content,
              context: { ...context, importance, category }
            });
            if (result.skipped) {
              storageDecisions.push({ type: 'event', category, importance, skipped: true, reason: 'duplicate' });
            } else {
              storageDecisions.push({ type: 'event', category, importance, stored: true });
            }
          }
          
          // Store in conversations - use summary as content if available, keep raw for reference
          const convResult = await memoryService.storeConversation({
            userId,
            conversationId,
            role: 'user',
            content: summary || messageContent,
            context: {
              ...context,
              importance,
              category,
              ...(summary && summary !== messageContent ? { rawMessage: messageContent } : {})
            }
          });
          if (convResult.skipped) {
            storageDecisions.push({ type: 'conversation', importance, skipped: true, reason: 'duplicate' });
          } else {
            storageDecisions.push({ type: 'conversation', importance, stored: true, hasSummary: !!summary });
          }
        }
        // MEDIUM IMPORTANCE (4-6): Store in conversations
        else if (importance >= 4) {
          const result = await memoryService.storeConversation({
            userId,
            conversationId,
            role: 'user',
            content: summary || messageContent,
            context: {
              ...context,
              importance,
              category,
              ...(summary && summary !== messageContent ? { rawMessage: messageContent } : {})
            }
          });
          if (result.skipped) {
            storageDecisions.push({ type: 'conversation', importance, skipped: true, reason: 'duplicate' });
          } else {
            storageDecisions.push({ type: 'conversation', importance, stored: true, hasSummary: !!summary });
          }
        }
        // LOW IMPORTANCE (1-3): Still store in conversations for working memory continuity
        // This ensures the AI can follow the conversation flow even for casual messages
        else {
          const result = await memoryService.storeConversation({
            userId,
            conversationId,
            role: 'user',
            content: messageContent, // Store original, no summary needed for simple messages
            context: {
              ...context,
              importance,
              category,
              isLowPriority: true // Mark as low priority for potential cleanup later
            }
          });
          if (result.skipped) {
            storageDecisions.push({ type: 'conversation', importance, skipped: true, reason: 'duplicate' });
          } else {
            storageDecisions.push({ type: 'conversation', importance, stored: true, note: 'working memory only' });
          }
          logger.debug('Stored low importance message for working memory', { importance, category });
        }
        
        // Log storage decisions
        console.log('\n📦 STORAGE DECISIONS:', JSON.stringify(storageDecisions, null, 2));
      }

      // Store assistant response
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

      // Use explicit action from evaluation (merged - no separate LLM call needed)
      const detectedActions = userMessageEvaluation?.explicitAction 
        ? [userMessageEvaluation.explicitAction] 
        : [];
      
      // Process detected actions
      for (const action of detectedActions) {
        await this.handleDetectedAction(action, llmResponse.content, userId, conversationId, context);
      }

      // Add LLM response to debug info if debug mode is enabled
      if (debug && debugInfo) {
        debugInfo.llm_request = {
          system_prompt: systemPrompt,
          messages: conversationContext.map(m => ({
            role: m.role,
            content: m.content
          })),
          temperature: 0.3,
          max_tokens: 500
        };
        debugInfo.llm_response = {
          model: llmResponse.model,
          tokens_used: llmResponse.usage?.total_tokens,
          response_chars: llmResponse.content.length,
          full_response: llmResponse.content,
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
        },
        // Always include memory intelligence summary for browser console debugging
        memory_intelligence: {
          user_evaluation: userMessageEvaluation ? {
            importance: userMessageEvaluation.importance,
            category: userMessageEvaluation.category,
            shouldStore: userMessageEvaluation.shouldStore,
            storageType: userMessageEvaluation.storageType,
            keyFacts: userMessageEvaluation.keyFacts || [],
            summary: userMessageEvaluation.summary || null,
            reasoning: userMessageEvaluation.reasoning || null
          } : null,
          storage_decisions: storageDecisions,
          query_enhancement: queryEnhancementDebug ? {
            queries_used: queryEnhancementDebug.enhancedQueries?.length || 1,
            categories: queryEnhancementDebug.categories || []
          } : null
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
        limit: 15 // Working memory: industry standard 10-15 messages for conversation context
      });
      
      // Filter and deduplicate - exclude messages that match current message
      const seenContent = new Set();
      const currentMsgNormalized = currentMessage?.toLowerCase().trim();
      
      if (recentMessages.length > 0) {
        // Take last 10 messages (5 exchanges) after filtering - industry standard working memory
        const filteredMessages = recentMessages.filter(msg => {
          const content = (msg.document || msg.content || '').toLowerCase().trim();
          
          // Skip if it's the same as current message (we'll add it at the end)
          if (content === currentMsgNormalized) {
            return false;
          }
          
          // Skip if we've already seen very similar content
          if (seenContent.has(content)) {
            return false;
          }
          
          // Skip if content is too similar to something we've seen (>80% word overlap)
          for (const seen of seenContent) {
            if (this.textSimilarity(content, seen) > 0.8) {
              return false;
            }
          }
          
          seenContent.add(content);
          return true;
        }).slice(-10); // Keep last 10 unique messages (5 exchanges)
        
        filteredMessages.forEach(msg => {
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

    // Add current message at the end (this is the new message being processed)
    context.push({
      role: 'user',
      content: currentMessage
    });

    return context;
  }

  /**
   * Simple text similarity check (Jaccard similarity on words)
   */
  textSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
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
      
      // Try to get voice service status (optional)
      let voiceStatus = null;
      try {
        const voiceService = require('./voiceService');
        voiceStatus = await voiceService.getStatus();
      } catch (voiceError) {
        // Voice service is optional, so don't fail the entire status check
        voiceStatus = { overall: 'not_available', error: voiceError.message };
      }

      return {
        vortex: {
          status: 'operational',
          version: '1.0.0',
          personality: this.personality.name
        },
        memory: memoryStatus,
        llm: llmStatus,
        voice: voiceStatus,
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
   * Summarize a conversation and store key facts
   * Call this when a conversation ends or periodically for long conversations
   */
  async summarizeAndCompactConversation({ userId, conversationId, forceRegenerate = false }) {
    try {
      logger.info('Starting conversation summarization', { userId, conversationId });

      // Get all messages from this conversation
      const conversationMessages = await memoryService.getRecentConversation({
        userId,
        conversationId,
        limit: 50 // Get last 50 messages for summarization
      });

      if (conversationMessages.length < 3) {
        logger.debug('Not enough messages to summarize', { count: conversationMessages.length });
        return { skipped: true, reason: 'Not enough messages' };
      }

      // Generate conversation summary
      const summary = await memoryIntelligence.summarizeConversation(
        conversationMessages,
        { userId, conversationId }
      );

      logger.debug('Generated conversation summary', {
        factCount: summary.facts?.length || 0,
        preferenceCount: summary.preferences?.length || 0,
        taskCount: summary.tasks?.length || 0,
        topics: summary.topics
      });

      // Store extracted facts as preferences
      if (summary.facts && summary.facts.length > 0) {
        for (const fact of summary.facts) {
          await memoryService.storePreference({
            userId,
            category: 'fact',
            preference: fact,
            context: {
              source: 'summarization',
              conversationId,
              importance: 8
            }
          });
        }
      }

      // Store preferences
      if (summary.preferences && summary.preferences.length > 0) {
        for (const pref of summary.preferences) {
          await memoryService.storePreference({
            userId,
            category: 'preference',
            preference: pref,
            context: {
              source: 'summarization',
              conversationId,
              importance: 7
            }
          });
        }
      }

      // Store tasks as events
      if (summary.tasks && summary.tasks.length > 0) {
        for (const task of summary.tasks) {
          await memoryService.storeEvent({
            userId,
            eventType: 'task_identified',
            domain: 'productivity',
            userIntent: task,
            systemResponse: 'Task extracted from conversation',
            context: {
              source: 'summarization',
              conversationId
            }
          });
        }
      }

      // Store the overall summary as an event
      if (summary.summary) {
        await memoryService.storeEvent({
          userId,
          eventType: 'conversation_summary',
          domain: 'meta',
          userIntent: `Conversation about: ${summary.topics?.join(', ') || 'various topics'}`,
          systemResponse: summary.summary,
          context: {
            source: 'summarization',
            conversationId,
            sentiment: summary.sentiment,
            messageCount: conversationMessages.length
          }
        });
      }

      logger.info('Conversation summarization complete', {
        userId,
        conversationId,
        factsStored: summary.facts?.length || 0,
        preferencesStored: summary.preferences?.length || 0,
        tasksStored: summary.tasks?.length || 0
      });

      return {
        success: true,
        summary: summary.summary,
        facts: summary.facts,
        preferences: summary.preferences,
        tasks: summary.tasks,
        topics: summary.topics,
        sentiment: summary.sentiment
      };

    } catch (error) {
      logger.error('Conversation summarization failed', {
        userId,
        conversationId,
        error: error.message
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Get memory intelligence status and statistics
   */
  async getMemoryIntelligenceStatus() {
    return {
      enabled: true,
      thresholds: memoryIntelligence.thresholds,
      categories: Object.values(memoryIntelligence.categories),
      features: {
        smartStorage: true,
        queryEnhancement: true,
        reranking: true,
        summarization: true
      }
    };
  }
}

module.exports = new VortexService();