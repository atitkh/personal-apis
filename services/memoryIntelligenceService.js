/**
 * Memory Intelligence Service
 * 
 * Provides LLM-powered memory evaluation, importance scoring,
 * categorization, query enhancement, and summarization.
 */

const { logger } = require('../utils/logger');

class MemoryIntelligenceService {
  constructor() {
    this.llmService = null;
    this.isInitialized = false;
    
    // Importance thresholds
    this.thresholds = {
      HIGH: 7,      // Score >= 7: Store in preferences/events
      MEDIUM: 4,    // Score 4-6: Store in conversations
      LOW: 0        // Score < 4: Don't store or use TTL
    };
    
    // Memory categories
    this.categories = {
      FACT: 'fact',                 // Facts about the user
      PREFERENCE: 'preference',     // User preferences
      TASK: 'task',                 // Tasks or reminders
      EVENT: 'event',               // Significant events
      INSTRUCTION: 'instruction',   // How user wants to be helped
      RELATIONSHIP: 'relationship', // Relationships mentioned
      CHITCHAT: 'chitchat',         // Casual conversation
      QUESTION: 'question',         // Questions asked
      CONTEXT: 'context'            // Contextual information
    };
  }

  /**
   * Initialize with LLM service
   */
  async initialize(llmService) {
    this.llmService = llmService;
    this.isInitialized = true;
    logger.info('MemoryIntelligenceService initialized');
  }

  /**
   * Ensure service is initialized
   */
  async ensureInitialized() {
    if (!this.isInitialized || !this.llmService) {
      const llmService = require('./llmService');
      await this.initialize(llmService);
    }
  }

  /**
   * Evaluate a message for memory importance and categorization
   * 
   * @param {Object} params
   * @param {string} params.message - The message to evaluate
   * @param {string} params.role - 'user' or 'assistant'
   * @param {Object} params.context - Additional context
   * @returns {Object} Evaluation result with importance, category, summary, shouldStore
   */
  async evaluateMessage({ message, role, context = {} }) {
    await this.ensureInitialized();

    try {
      const prompt = this.buildEvaluationPrompt(message, role, context);
      const systemPrompt = this.getEvaluationSystemPrompt();
      
      // Debug: Log what we're sending to LLM
      console.log('\n========== MEMORY INTELLIGENCE: EVALUATE MESSAGE ==========');
      console.log('📤 SENDING TO LLM:');
      console.log('System Prompt:', systemPrompt.substring(0, 200) + '...');
      console.log('User Prompt:', prompt);
      console.log('============================================================');
      
      const response = await this.llmService.generateResponse({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: systemPrompt,
        temperature: 0.1,  // Low temperature for consistent scoring
        maxTokens: 300
      });

      // Debug: Log what we received from LLM
      console.log('\n📥 RECEIVED FROM LLM:');
      console.log('Raw Response:', response.content);
      console.log('============================================================\n');

      const evaluation = this.parseEvaluationResponse(response.content);
      
      // Debug: Log parsed evaluation result
      console.log('\n🎯 PARSED EVALUATION RESULT:');
      console.log('  Importance:', evaluation.importance);
      console.log('  Category:', evaluation.category);
      console.log('  Should Store:', evaluation.shouldStore);
      console.log('  Storage Type:', evaluation.storageType);
      console.log('  Summary:', evaluation.summary);
      console.log('  Key Facts:', evaluation.keyFacts);
      console.log('  Explicit Action:', evaluation.explicitAction || 'none');
      console.log('  Reasoning:', evaluation.reasoning);
      console.log('============================================================\n');

      logger.debug('Message evaluated', {
        role,
        messagePreview: message.substring(0, 50),
        importance: evaluation.importance,
        category: evaluation.category,
        shouldStore: evaluation.shouldStore,
        hasExplicitAction: !!evaluation.explicitAction
      });

      return evaluation;

    } catch (error) {
      logger.error('Message evaluation failed', { error: error.message });
      // Default to storing on error to avoid losing important info
      return {
        importance: 5,
        category: this.categories.CONTEXT,
        summary: message.substring(0, 200),
        shouldStore: true,
        storageType: 'conversations',
        explicitAction: null,
        error: error.message
      };
    }
  }

  /**
   * Build the evaluation prompt
   */
  buildEvaluationPrompt(message, role, context) {
    const roleContext = role === 'user' ? 'The user said' : 'The AI assistant responded';
    
    return `${roleContext}:
"${message}"

${context.previousMessage ? `Previous message: "${context.previousMessage}"` : ''}
${context.conversationSummary ? `Conversation context: ${context.conversationSummary}` : ''}

Analyze this message and respond in JSON format:
{
  "importance": <1-10 score>,
  "category": "<category>",
  "summary": "<concise summary if important, otherwise null>",
  "key_facts": [<list of extractable facts, or empty array>],
  "explicit_action": <null OR {"type": "remember|remind|note", "content": "what to remember/remind/note"} if user explicitly requests it>,
  "reasoning": "<brief explanation>"
}`;
  }

  /**
   * Get the system prompt for evaluation
   */
  getEvaluationSystemPrompt() {
    return `You are a memory importance evaluator for a personal AI assistant named Vortex.

Your job is to analyze messages and determine:
1. IMPORTANCE (1-10 scale):
   - 9-10: Critical personal info (name, birthday, family, major life events)
   - 7-8: Important preferences, recurring topics, significant requests
   - 5-6: Useful context, moderate preferences, task-related info
   - 3-4: General conversation, low-value context
   - 1-2: Chitchat, greetings, filler, acknowledgments

2. CATEGORY (one of):
   - fact: Factual information about the user
   - preference: User likes, dislikes, preferences
   - task: Tasks, reminders, action items
   - event: Significant events or experiences
   - instruction: How user wants to be helped
   - relationship: Information about people in user's life
   - chitchat: Casual conversation, small talk
   - question: Questions without lasting value
   - context: Situational context

3. SUMMARY: For importance >= 5, provide a concise, detailed summary. Otherwise null.

4. KEY_FACTS: Extract any concrete facts (names, dates, preferences, etc.)

5. EXPLICIT_ACTION: Detect if user explicitly requests MEMORY-related actions:
   - "Remember that..." or "Don't forget..." → {"type": "remember", "content": "what to remember"}
   - "Remind me to..." or "Set a reminder..." → {"type": "remind", "content": "what to remind"}
   - "Note that..." or "Make a note..." → {"type": "note", "content": "what to note"}
   
   IMPORTANT - These are NOT explicit memory actions (set to null):
   - Questions like "What did I ask you to remember?" 
   - Device/tool commands like "turn on the light", "play music", "set temperature"
   - General requests like "help me with...", "can you..."
   
   Only set explicit_action when user is explicitly asking to STORE something in memory.

Respond ONLY with valid JSON. Be consistent and objective.`;
  }

  /**
   * Parse the LLM evaluation response
   */
  parseEvaluationResponse(response) {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      
      // Try to find JSON object in response
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      }

      const parsed = JSON.parse(jsonStr);
      
      const importance = Math.min(10, Math.max(1, parseInt(parsed.importance) || 5));
      const category = this.validateCategory(parsed.category);
      
      // Parse explicit action if present
      let explicitAction = null;
      if (parsed.explicit_action && parsed.explicit_action.type && parsed.explicit_action.content) {
        explicitAction = {
          type: parsed.explicit_action.type,
          content: parsed.explicit_action.content,
          confidence: 0.9 // LLM-detected actions have high confidence
        };
      }
      
      return {
        importance,
        category,
        summary: parsed.summary || null,
        keyFacts: parsed.key_facts || [],
        reasoning: parsed.reasoning || '',
        shouldStore: importance >= this.thresholds.LOW,
        storageType: this.determineStorageType(importance, category),
        explicitAction
      };

    } catch (error) {
      logger.warn('Failed to parse evaluation response', { 
        error: error.message,
        response: response.substring(0, 200)
      });
      
      return {
        importance: 5,
        category: this.categories.CONTEXT,
        summary: null,
        keyFacts: [],
        reasoning: 'Parse error - defaulting',
        shouldStore: true,
        storageType: 'conversations',
        explicitAction: null
      };
    }
  }

  /**
   * Validate and normalize category
   */
  validateCategory(category) {
    const normalized = (category || '').toLowerCase().trim();
    return Object.values(this.categories).includes(normalized) 
      ? normalized 
      : this.categories.CONTEXT;
  }

  /**
   * Determine storage type based on importance and category
   */
  determineStorageType(importance, category) {
    if (importance >= this.thresholds.HIGH) {
      // Facts about the user (name, age, location, relationships)
      if ([this.categories.FACT, this.categories.RELATIONSHIP].includes(category)) {
        return 'facts';
      }
      // Preferences and instructions
      if ([this.categories.PREFERENCE, this.categories.INSTRUCTION].includes(category)) {
        return 'preferences';
      }
      // Events and tasks
      if ([this.categories.EVENT, this.categories.TASK].includes(category)) {
        return 'events';
      }
      return 'conversations';
    }
    
    if (importance >= this.thresholds.MEDIUM) {
      // Medium importance facts still go to facts collection
      if ([this.categories.FACT, this.categories.RELATIONSHIP].includes(category)) {
        return 'facts';
      }
      return 'conversations';
    }
    
    // Low importance - store with TTL or skip
    return 'ephemeral';
  }

  /**
   * Enhance a retrieval query for better memory search
   * 
   * @param {string} query - Original query
   * @param {Object} context - Additional context
   * @returns {Object} Enhanced query data
   */
  async enhanceQuery(query, context = {}) {
    await this.ensureInitialized();

    try {
      const prompt = `Given this user query: "${query}"

Generate search variations to find relevant memories. Consider:
- Synonyms and related terms
- Different phrasings of the same intent
- Related topics that might be relevant

Respond in JSON:
{
  "queries": ["<query1>", "<query2>", "<query3>"],
  "keywords": ["<keyword1>", "<keyword2>"],
  "categories": ["<likely memory categories>"],
  "timeframe": "<if temporal, e.g., 'recent', 'last week', null>"
}`;

      const systemPrompt = 'You are a search query optimizer. Generate alternative queries to improve memory retrieval. Respond only with JSON.';

      // Debug: Log what we're sending to LLM
      console.log('\n========== MEMORY INTELLIGENCE: ENHANCE QUERY ==========');
      console.log('📤 SENDING TO LLM:');
      console.log('System Prompt:', systemPrompt);
      console.log('User Prompt:', prompt);
      console.log('==========================================================');

      const response = await this.llmService.generateResponse({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: systemPrompt,
        temperature: 0.3,
        maxTokens: 200
      });

      // Debug: Log what we received from LLM
      console.log('\n📥 RECEIVED FROM LLM:');
      console.log('Raw Response:', response.content);
      console.log('==========================================================\n');

      return this.parseQueryEnhancement(response.content, query);

    } catch (error) {
      logger.error('Query enhancement failed', { error: error.message });
      return {
        queries: [query],
        keywords: [],
        categories: [],
        timeframe: null
      };
    }
  }

  /**
   * Parse query enhancement response
   */
  parseQueryEnhancement(response, originalQuery) {
    try {
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];
      
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) jsonStr = objectMatch[0];

      const parsed = JSON.parse(jsonStr);
      
      return {
        queries: [originalQuery, ...(parsed.queries || [])].slice(0, 5),
        keywords: parsed.keywords || [],
        categories: parsed.categories || [],
        timeframe: parsed.timeframe || null
      };

    } catch (error) {
      return {
        queries: [originalQuery],
        keywords: [],
        categories: [],
        timeframe: null
      };
    }
  }

  /**
   * Re-rank retrieved memories based on relevance to query
   * 
   * @param {string} query - Original query
   * @param {Array} memories - Retrieved memories
   * @param {number} topK - Number of results to return
   * @returns {Array} Re-ranked memories
   */
  async rerankMemories(query, memories, topK = 5) {
    await this.ensureInitialized();

    if (memories.length <= topK) {
      return memories;
    }

    try {
      const memorySummaries = memories.slice(0, 15).map((m, i) => 
        `[${i}] ${(m.content || m.document || '').substring(0, 150)}`
      ).join('\n');

      const prompt = `Query: "${query}"

Memories:
${memorySummaries}

Rank the top ${topK} most relevant memories for this query.
Respond with JSON: { "rankings": [<indices in order of relevance>] }`;

      const systemPrompt = 'You are a relevance ranker. Select the most relevant memories for the query. Respond only with JSON.';

      // Debug: Log what we're sending to LLM
      console.log('\n========== MEMORY INTELLIGENCE: RERANK MEMORIES ==========');
      console.log('📤 SENDING TO LLM:');
      console.log('System Prompt:', systemPrompt);
      console.log('User Prompt:', prompt);
      console.log('===========================================================');

      const response = await this.llmService.generateResponse({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: systemPrompt,
        temperature: 0.1,
        maxTokens: 100
      });

      // Debug: Log what we received from LLM
      console.log('\n📥 RECEIVED FROM LLM:');
      console.log('Raw Response:', response.content);
      console.log('===========================================================\n');

      const rankings = this.parseRankings(response.content, memories.length, topK);
      
      return rankings.map(idx => memories[idx]).filter(Boolean);

    } catch (error) {
      logger.error('Memory reranking failed', { error: error.message });
      return memories.slice(0, topK);
    }
  }

  /**
   * Parse ranking response
   */
  parseRankings(response, maxIndex, topK) {
    try {
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];
      
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) jsonStr = objectMatch[0];

      const parsed = JSON.parse(jsonStr);
      const rankings = (parsed.rankings || [])
        .filter(idx => typeof idx === 'number' && idx >= 0 && idx < maxIndex)
        .slice(0, topK);
      
      return rankings.length > 0 ? rankings : [...Array(topK).keys()];

    } catch (error) {
      return [...Array(topK).keys()];
    }
  }

  /**
   * Summarize a conversation into key facts and insights
   * 
   * @param {Array} messages - Array of conversation messages
   * @param {Object} context - Additional context
   * @returns {Object} Conversation summary
   */
  async summarizeConversation(messages, context = {}) {
    await this.ensureInitialized();

    if (!messages || messages.length === 0) {
      return { summary: '', facts: [], preferences: [], tasks: [] };
    }

    try {
      const conversationText = messages.map(m => 
        `${m.role || m.metadata?.role || 'unknown'}: ${m.content || m.document || ''}`
      ).join('\n');

      const prompt = `Summarize this conversation, extracting key information:

${conversationText}

Respond in JSON:
{
  "summary": "<2-3 sentence summary of the conversation>",
  "facts": ["<factual info learned about the user>"],
  "preferences": ["<user preferences expressed>"],
  "tasks": ["<any tasks, reminders, or action items>"],
  "topics": ["<main topics discussed>"],
  "sentiment": "<overall sentiment: positive/neutral/negative>"
}`;

      const systemPrompt = 'You are a conversation summarizer. Extract key information and facts. Respond only with JSON.';

      // Debug: Log what we're sending to LLM
      console.log('\n========== MEMORY INTELLIGENCE: SUMMARIZE CONVERSATION ==========');
      console.log('📤 SENDING TO LLM:');
      console.log('System Prompt:', systemPrompt);
      console.log('User Prompt:', prompt);
      console.log('==================================================================');

      const response = await this.llmService.generateResponse({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: systemPrompt,
        temperature: 0.2,
        maxTokens: 400
      });

      // Debug: Log what we received from LLM
      console.log('\n📥 RECEIVED FROM LLM:');
      console.log('Raw Response:', response.content);
      console.log('==================================================================\n');

      return this.parseSummaryResponse(response.content);

    } catch (error) {
      logger.error('Conversation summarization failed', { error: error.message });
      return {
        summary: '',
        facts: [],
        preferences: [],
        tasks: [],
        topics: [],
        sentiment: 'neutral',
        error: error.message
      };
    }
  }

  /**
   * Parse summary response
   */
  parseSummaryResponse(response) {
    try {
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];
      
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) jsonStr = objectMatch[0];

      const parsed = JSON.parse(jsonStr);
      
      return {
        summary: parsed.summary || '',
        facts: parsed.facts || [],
        preferences: parsed.preferences || [],
        tasks: parsed.tasks || [],
        topics: parsed.topics || [],
        sentiment: parsed.sentiment || 'neutral'
      };

    } catch (error) {
      return {
        summary: '',
        facts: [],
        preferences: [],
        tasks: [],
        topics: [],
        sentiment: 'neutral'
      };
    }
  }

  /**
   * Extract and store key facts from evaluated messages
   * 
   * @param {Object} evaluation - Evaluation result
   * @param {Object} originalMessage - Original message data
   * @returns {Array} Extracted facts ready for storage
   */
  extractStorableMemories(evaluation, originalMessage) {
    const memories = [];
    
    // Store the summary if available and importance is high enough
    if (evaluation.summary && evaluation.importance >= this.thresholds.MEDIUM) {
      memories.push({
        type: evaluation.storageType,
        content: evaluation.summary,
        metadata: {
          category: evaluation.category,
          importance: evaluation.importance,
          originalLength: originalMessage.content?.length || 0,
          isSummary: true
        }
      });
    }

    // Store individual key facts if importance is high
    if (evaluation.keyFacts && evaluation.keyFacts.length > 0 && evaluation.importance >= this.thresholds.HIGH) {
      evaluation.keyFacts.forEach(fact => {
        memories.push({
          type: 'preferences',  // Key facts go to preferences for easy retrieval
          content: fact,
          metadata: {
            category: 'fact',
            importance: evaluation.importance,
            sourceCategory: evaluation.category,
            isExtractedFact: true
          }
        });
      });
    }

    return memories;
  }
}

// Export singleton instance
module.exports = new MemoryIntelligenceService();
