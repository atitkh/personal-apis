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
   * UNIFIED MESSAGE ANALYSIS
   * Performs all message intelligence tasks in a single LLM call:
   * - Message importance evaluation
   * - Memory retrieval query generation
   * - MCP tool intent detection
   * 
   * This is 3x faster than separate calls and provides better context-aware analysis.
   * 
   * @param {Object} params
   * @param {string} params.message - The message to analyze
   * @param {string} params.role - 'user' or 'assistant'
   * @param {Object} params.context - Additional context
   * @returns {Object} Unified analysis result
   */
  async analyzeMessage({ message, role, context = {} }) {
    await this.ensureInitialized();

    try {
      const prompt = this.buildUnifiedAnalysisPrompt(message, role, context);
      const systemPrompt = this.getUnifiedAnalysisSystemPrompt();
      
      console.log('\n========== UNIFIED MESSAGE ANALYSIS ==========');
      console.log('📤 SENDING TO LLM (Single unified call - replaces 3 separate calls)');
      console.log('Message:', message);
      console.log('Role:', role);
      if (context.previousMessage) {
        console.log('Previous message:', context.previousMessage.substring(0, 100));
      }
      if (context.conversationSummary) {
        console.log('Conversation summary:', context.conversationSummary.substring(0, 100));
      }
      console.log('System Prompt:', systemPrompt.substring(0, 200) + '...');
      console.log('User Prompt:', prompt);
      console.log('==============================================');
      
      const response = await this.llmService.generateResponse({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: systemPrompt,
        temperature: 0.1,
        maxTokens: 400
      });

      console.log('\n📥 RECEIVED FROM LLM:');
      console.log('Raw Response:', response.content);
      console.log('==============================================\n');

      const analysis = this.parseUnifiedAnalysis(response.content, message);
      
      console.log('\n🎯 UNIFIED ANALYSIS RESULT:');
      console.log('  EVALUATION:');
      console.log('    Importance:', analysis.evaluation.importance);
      console.log('    Category:', analysis.evaluation.category);
      console.log('    Should Store:', analysis.evaluation.shouldStore);
      console.log('    Storage Type:', analysis.evaluation.storageType);
      console.log('    Summary:', analysis.evaluation.summary);
      console.log('    Key Facts:', analysis.evaluation.keyFacts);
      console.log('    Explicit Action:', analysis.evaluation.explicitAction || 'none');
      console.log('    Reasoning:', analysis.evaluation.reasoning);
      console.log('  RETRIEVAL:');
      console.log('    Original Query:', message.substring(0, 100));
      console.log('    Enhanced Queries:', analysis.retrieval.queries);
      console.log('    Keywords:', analysis.retrieval.keywords);
      console.log('    Categories:', analysis.retrieval.categories);
      console.log('  MCP INTENT:');
      console.log('    Needs Tools:', analysis.mcpIntent.needsTools);
      console.log('    Confidence:', analysis.mcpIntent.confidence);
      console.log('    Likely Tools:', analysis.mcpIntent.likelyTools);
      console.log('    Intent Type:', analysis.mcpIntent.intentType);
      console.log('    Reasoning:', analysis.mcpIntent.reasoning);
      console.log('==============================================\n');

      return analysis;

    } catch (error) {
      logger.error('Unified message analysis failed', { error: error.message });
      return this.getDefaultAnalysis(message);
    }
  }

  /**
   * Build unified analysis prompt
   */
  buildUnifiedAnalysisPrompt(message, role, context) {
    const roleContext = role === 'user' ? 'The user said' : 'The AI assistant responded';
    
    return `${roleContext}: "${message}"

${context.previousMessage ? `Previous message: "${context.previousMessage}"` : ''}
${context.conversationSummary ? `Conversation context: ${context.conversationSummary}` : ''}

Analyze this message comprehensively and respond in JSON format:
{
  "evaluation": {
    "importance": <1-10 score>,
    "category": "<category>",
    "summary": "<concise summary if important, otherwise null>",
    "key_facts": [<list of extractable facts>],
    "explicit_action": <null OR {"type": "remember|remind|note", "content": "..."} if user explicitly requests memory action>,
    "reasoning": "<brief explanation>"
  },
  "retrieval": {
    "queries": ["<best search query 1>", "<alternative search query 2>"],
    "keywords": ["<key1>", "<key2>"],
    "categories": ["<likely memory category 1>", "<category 2>"]
  },
  "mcp_intent": {
    "needs_tools": <true/false>,
    "confidence": <0.0-1.0>,
    "likely_tools": ["<tool1>", "<tool2>"],
    "intent_type": "<query|action|conversation>",
    "reasoning": "<why tools are/aren't needed>"
  }
}`;
  }

  /**
   * Get unified analysis system prompt
   */
  getUnifiedAnalysisSystemPrompt() {
    return `You are a comprehensive message analyzer for Vortex, a personal AI assistant.

Analyze messages in THREE dimensions simultaneously:

═══════════════════════════════════════════════════════════════════
1. EVALUATION - Message Importance & Storage
═══════════════════════════════════════════════════════════════════
IMPORTANCE (1-10):
- 9-10: Critical personal info (name, birthday, family, major life events)
- 7-8: Important preferences, recurring topics, significant requests
- 5-6: Useful context, moderate preferences, task-related info
- 3-4: General conversation, low-value context
- 1-2: Chitchat, greetings, filler, acknowledgments

CATEGORY: fact, preference, task, event, instruction, relationship, chitchat, question, context

SUMMARY: Concise summary if importance >= 5, otherwise null

KEY_FACTS: Extract concrete facts (names, dates, preferences)

EXPLICIT_ACTION: Only set if user explicitly says "remember that...", "remind me to...", "note that..."
- NOT for device commands ("turn on light")
- NOT for questions ("what did I say?")
- NOT for general requests ("help me with...")

═══════════════════════════════════════════════════════════════════
2. RETRIEVAL - Memory Search Queries
═══════════════════════════════════════════════════════════════════
Generate TWO context-aware search queries:
1. Direct query matching user's intent
2. Alternative phrasing or broader context

Consider:
- Synonyms and related terms
- Different phrasings of same intent
- Temporal context ("recent", "yesterday", etc.)
- Related topics that might be relevant

KEYWORDS: 2-4 key terms for filtering
CATEGORIES: Likely memory categories to search

═══════════════════════════════════════════════════════════════════
3. MCP INTENT - Tool/Action Detection
═══════════════════════════════════════════════════════════════════
NEEDS_TOOLS: true if message requires external tool execution

Example Set TRUE for:
- Device control: "turn on/off X", "set temperature", "dim lights"
- Home automation: "is X on?", "what's the temperature?"
- System actions: "play music", "set timer", "create reminder"
- Information retrieval requiring APIs: "weather", "calendar"

Example Set FALSE for:
- Pure conversation: "how are you?", "tell me about..."
- Questions about past: "what did we discuss?", "do you remember..."
- General knowledge: "explain X", "what is Y?"
- Memory operations: "remember that...", "note this..."

CONFIDENCE: 0.0-1.0 (how certain you are)
LIKELY_TOOLS: Guess which tools might be needed (homeassistant.*, etc.)
INTENT_TYPE: "action" (requires tools), "query" (information), or "conversation" (chat)
REASONING: Brief explanation

═══════════════════════════════════════════════════════════════════

Respond ONLY with valid JSON. Be consistent and objective.`;
  }

  /**
   * Parse unified analysis response
   */
  parseUnifiedAnalysis(response, originalMessage) {
    try {
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];
      
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) jsonStr = objectMatch[0];

      const parsed = JSON.parse(jsonStr);
      
      // Parse evaluation
      const importance = Math.min(10, Math.max(1, parseInt(parsed.evaluation?.importance) || 5));
      const category = this.validateCategory(parsed.evaluation?.category);
      
      let explicitAction = null;
      if (parsed.evaluation?.explicit_action?.type && parsed.evaluation?.explicit_action?.content) {
        explicitAction = {
          type: parsed.evaluation.explicit_action.type,
          content: parsed.evaluation.explicit_action.content,
          confidence: 0.9
        };
      }
      
      return {
        evaluation: {
          importance,
          category,
          summary: parsed.evaluation?.summary || null,
          keyFacts: parsed.evaluation?.key_facts || [],
          reasoning: parsed.evaluation?.reasoning || '',
          shouldStore: importance >= this.thresholds.LOW,
          storageType: this.determineStorageType(importance, category),
          explicitAction
        },
        retrieval: {
          queries: (parsed.retrieval?.queries || [originalMessage]).slice(0, 2),
          keywords: parsed.retrieval?.keywords || [],
          categories: parsed.retrieval?.categories || []
        },
        mcpIntent: {
          needsTools: parsed.mcp_intent?.needs_tools || false,
          confidence: Math.min(1.0, Math.max(0.0, parseFloat(parsed.mcp_intent?.confidence) || 0.5)),
          likelyTools: parsed.mcp_intent?.likely_tools || [],
          intentType: parsed.mcp_intent?.intent_type || 'conversation',
          reasoning: parsed.mcp_intent?.reasoning || ''
        }
      };

    } catch (error) {
      logger.warn('Failed to parse unified analysis', { 
        error: error.message,
        response: response.substring(0, 200)
      });
      return this.getDefaultAnalysis(originalMessage);
    }
  }

  /**
   * Get default analysis on error
   */
  getDefaultAnalysis(message) {
    return {
      evaluation: {
        importance: 5,
        category: this.categories.CONTEXT,
        summary: message.substring(0, 200),
        keyFacts: [],
        reasoning: 'Default - parse error',
        shouldStore: true,
        storageType: 'conversations',
        explicitAction: null
      },
      retrieval: {
        queries: [message],
        keywords: [],
        categories: []
      },
      mcpIntent: {
        needsTools: false,
        confidence: 0.5,
        likelyTools: [],
        intentType: 'conversation',
        reasoning: 'Default - assuming conversation'
      }
    };
  }

  /**
   * Evaluate a message for memory importance and categorization
   * 
   * @deprecated Use analyzeMessage() instead for better performance
   * @param {Object} params
   * @param {string} params.message - The message to evaluate
   * @param {string} params.role - 'user' or 'assistant'
   * @param {Object} params.context - Additional context
   * @returns {Object} Evaluation result with importance, category, summary, shouldStore
   */
  async evaluateMessage({ message, role, context = {} }) {
    // Wrapper for backward compatibility - calls unified analysis
    const analysis = await this.analyzeMessage({ message, role, context });
    return analysis.evaluation;
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
   * @deprecated Use analyzeMessage() instead for better performance (includes query generation)
   * @param {string} query - Original query
   * @param {Object} context - Additional context
   * @returns {Object} Enhanced query data
   */
  async enhanceQuery(query, context = {}) {
    // Wrapper for backward compatibility - calls unified analysis
    const analysis = await this.analyzeMessage({ 
      message: query, 
      role: 'user', 
      context 
    });
    
    return {
      queries: analysis.retrieval.queries,
      keywords: analysis.retrieval.keywords,
      categories: analysis.retrieval.categories,
      timeframe: null
    };
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
