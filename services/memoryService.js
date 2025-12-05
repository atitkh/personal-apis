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

      // Load embedding function properly using the official ChromaDB approach
      let embeddingFunction = null;
      
      try {
        logger.info('Loading ChromaDB DefaultEmbeddingFunction...');
        
        // Import the official DefaultEmbeddingFunction from @chroma-core/default-embed
        logger.info('Importing DefaultEmbeddingFunction from @chroma-core/default-embed...');
        const { DefaultEmbeddingFunction } = await import('@chroma-core/default-embed');
        
        if (!DefaultEmbeddingFunction) {
          throw new Error('DefaultEmbeddingFunction not found in @chroma-core/default-embed package');
        }
        
        if (typeof DefaultEmbeddingFunction !== 'function') {
          throw new Error(`DefaultEmbeddingFunction is not a constructor, got: ${typeof DefaultEmbeddingFunction}`);
        }
        
        // Create instance with default settings (all-MiniLM-L6-v2 model)
        logger.info('Creating DefaultEmbeddingFunction instance...');
        embeddingFunction = new DefaultEmbeddingFunction();
        logger.info('Successfully initialized DefaultEmbeddingFunction with default model');
        
        // Test the embedding function
        logger.info('Testing embedding function...');
        const testEmbedding = await embeddingFunction.generate(['test']);
        if (!testEmbedding || !Array.isArray(testEmbedding) || testEmbedding.length === 0) {
          throw new Error('Embedding function test failed - invalid output');
        }
        logger.info('Embedding function test passed', { 
          outputType: typeof testEmbedding,
          outputLength: testEmbedding.length,
          firstEmbeddingLength: testEmbedding[0]?.length 
        });
        
      } catch (error) {
        logger.error('Failed to load ChromaDB DefaultEmbeddingFunction', { 
          error: error.message,
          stack: error.stack 
        });
        throw error; // Don't continue without embeddings - this is a real fix, not a workaround
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

      // Facts collection - for concrete facts about the user
      const factsCollectionConfig = {
        metadata: { description: 'User facts - name, location, relationships, etc.' }
      };
      if (embeddingFunction) {
        factsCollectionConfig.embeddingFunction = embeddingFunction;
      }

      this.collections.facts = await this.client.getOrCreateCollection({
        name: 'vortex_facts',
        ...factsCollectionConfig
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

      // Knowledge collection - for injected knowledge base documents
      const knowledgeCollectionConfig = {
        metadata: { description: 'Knowledge base documents - manually injected reference material' }
      };
      if (embeddingFunction) {
        knowledgeCollectionConfig.embeddingFunction = embeddingFunction;
      }

      this.collections.knowledge = await this.client.getOrCreateCollection({
        name: 'vortex_knowledge',
        ...knowledgeCollectionConfig
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
   * Store a conversation message (with deduplication for user messages)
   */
  async storeConversation({ userId, conversationId, role, content, context = {} }) {
    await this.ensureInitialized();

    try {
      // Check for duplicates only for user messages (assistant messages are always unique responses)
      if (role === 'user') {
        const dupCheck = await this.checkDuplicate(
          this.collections.conversations,
          content,
          userId,
          0.1 // Threshold for conversations
        );
        
        if (dupCheck.isDuplicate) {
          console.log('⏭️ SKIPPED DUPLICATE CONVERSATION:', content.substring(0, 50));
          logger.debug('Skipping duplicate conversation message', {
            content: content.substring(0, 50),
            existingContent: dupCheck.existingContent?.substring(0, 50)
          });
          return { skipped: true, reason: 'duplicate', existingContent: dupCheck.existingContent };
        }
      }

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
      if (context.importance) metadata.importance = context.importance;
      if (context.category) metadata.category = context.category;

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

      console.log('✅ STORED CONVERSATION:', role, '-', content.substring(0, 50));
      logger.info('Conversation stored successfully', { 
        id, 
        role, 
        userId: userId?.toString(), 
        conversationId 
      });
      return { id, skipped: false };

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
   * Store an event memory (with deduplication)
   */
  async storeEvent({ userId, eventType, domain, userIntent, systemResponse, context = {} }) {
    await this.ensureInitialized();

    try {
      const document = `Event: ${eventType} in ${domain}. User: "${userIntent}" System: "${systemResponse}"`;
      
      // Check for duplicates
      const dupCheck = await this.checkDuplicate(
        this.collections.events,
        userIntent, // Check based on user intent, not the full document
        userId,
        0.12
      );
      
      if (dupCheck.isDuplicate) {
        console.log('⏭️ SKIPPED DUPLICATE EVENT:', userIntent.substring(0, 50));
        logger.debug('Skipping duplicate event', {
          userIntent: userIntent.substring(0, 50),
          existingContent: dupCheck.existingContent?.substring(0, 50)
        });
        return { skipped: true, reason: 'duplicate', existingContent: dupCheck.existingContent };
      }

      const id = `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
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
      if (context.importance) metadata.importance = context.importance;

      await this.collections.events.add({
        ids: [id],
        documents: [document],
        metadatas: [metadata]
      });

      console.log('✅ STORED EVENT:', eventType, '-', userIntent.substring(0, 50));
      logger.debug('Event stored', { id, eventType, domain, userId });
      return { id, skipped: false };

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
   * Check if similar content already exists in a collection
   * @returns {boolean} true if duplicate exists
   */
  async checkDuplicate(collection, content, userId, similarityThreshold = 0.15) {
    try {
      // Query for similar content
      const results = await collection.query({
        queryTexts: [content],
        nResults: 3,
        where: { user_id: userId?.toString() || userId },
        include: ['documents', 'distances']
      });

      if (results.documents && results.documents[0] && results.documents[0].length > 0) {
        // Check if any result is very similar (low distance = high similarity)
        for (let i = 0; i < results.distances[0].length; i++) {
          const distance = results.distances[0][i];
          const existingDoc = results.documents[0][i];
          
          // If distance is very low, it's likely a duplicate
          if (distance < similarityThreshold) {
            logger.debug('Duplicate detected', {
              newContent: content.substring(0, 50),
              existingContent: existingDoc?.substring(0, 50),
              distance,
              threshold: similarityThreshold
            });
            return { isDuplicate: true, existingContent: existingDoc, distance };
          }
          
          // Also check for exact or near-exact text match
          if (existingDoc && this.textSimilarity(content, existingDoc) > 0.9) {
            logger.debug('Text similarity duplicate detected', {
              newContent: content.substring(0, 50),
              existingContent: existingDoc?.substring(0, 50)
            });
            return { isDuplicate: true, existingContent: existingDoc, distance };
          }
        }
      }
      
      return { isDuplicate: false };
    } catch (error) {
      logger.warn('Duplicate check failed, proceeding with storage', { error: error.message });
      return { isDuplicate: false };
    }
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
   * Store a user preference or important fact (with deduplication)
   */
  async storePreference({ userId, category, preference, context = {} }) {
    await this.ensureInitialized();

    try {
      // Check for duplicates first
      const dupCheck = await this.checkDuplicate(
        this.collections.preferences,
        preference,
        userId,
        0.12 // Stricter threshold for preferences
      );
      
      if (dupCheck.isDuplicate) {
        console.log('⏭️ SKIPPED DUPLICATE PREFERENCE:', preference.substring(0, 50));
        logger.debug('Skipping duplicate preference', {
          preference: preference.substring(0, 50),
          existingContent: dupCheck.existingContent?.substring(0, 50)
        });
        return { skipped: true, reason: 'duplicate', existingContent: dupCheck.existingContent };
      }

      const id = `pref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      const metadata = {
        schema_version: '1.0',
        memory_type: 'preference',
        timestamp: new Date().toISOString(),
        user_id: userId?.toString() || userId,
        source: context.source || 'extracted',
        category: category,
        importance: context.importance || 5
      };

      // Add optional context fields
      if (context.extractedFrom) metadata.extracted_from = context.extractedFrom;

      await this.collections.preferences.add({
        ids: [id],
        documents: [preference],
        metadatas: [metadata]
      });

      console.log('✅ STORED PREFERENCE:', preference.substring(0, 50));
      logger.debug('Preference stored', { id, category, userId, preference: preference.substring(0, 50) });
      return { id, skipped: false };

    } catch (error) {
      logger.error('Failed to store preference', { 
        userId, 
        category, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Store a user fact (name, location, relationships, etc.) with deduplication
   */
  async storeFact({ userId, fact, category, context = {} }) {
    await this.ensureInitialized();

    try {
      // Check for duplicates first
      const dupCheck = await this.checkDuplicate(
        this.collections.facts,
        fact,
        userId,
        0.10 // Very strict threshold for facts - they should be unique
      );
      
      if (dupCheck.isDuplicate) {
        console.log('⏭️ SKIPPED DUPLICATE FACT:', fact.substring(0, 50));
        logger.debug('Skipping duplicate fact', {
          fact: fact.substring(0, 50),
          existingContent: dupCheck.existingContent?.substring(0, 50)
        });
        return { skipped: true, reason: 'duplicate', existingContent: dupCheck.existingContent };
      }

      const id = `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      const metadata = {
        schema_version: '1.0',
        memory_type: 'fact',
        timestamp: new Date().toISOString(),
        user_id: userId?.toString() || userId,
        source: context.source || 'extracted',
        category: category || 'general',
        importance: context.importance || 8 // Facts are generally high importance
      };

      // Add optional context fields
      if (context.extractedFrom) metadata.extracted_from = context.extractedFrom;

      await this.collections.facts.add({
        ids: [id],
        documents: [fact],
        metadatas: [metadata]
      });

      console.log('✅ STORED FACT:', fact.substring(0, 50));
      logger.debug('Fact stored', { id, category, userId, fact: fact.substring(0, 50) });
      return { id, skipped: false };

    } catch (error) {
      logger.error('Failed to store fact', { 
        userId, 
        category, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Store knowledge base document (for RAG retrieval)
   * Unlike other stores, knowledge is global (not user-specific)
   * Documents are automatically chunked for better retrieval
   * @param {Object} options
   * @param {string} options.content - The document content to store
   * @param {string} options.title - Document title for identification
   * @param {string} [options.category] - Category for organization (e.g., 'documentation', 'reference', 'guide')
   * @param {string} [options.source] - Source of the document (e.g., 'manual', 'imported', 'file:path')
   * @param {Object} [options.metadata] - Additional metadata to store
   */
  async storeKnowledge({ content, title, category = 'general', source = 'manual', metadata = {} }) {
    await this.ensureInitialized();

    try {
      // Generate a unique document ID for all chunks
      const documentId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      // Check for duplicates based on title (exact match)
      if (this.collections.knowledge) {
        try {
          const existingDocs = await this.collections.knowledge.get({
            where: { title: title },
            limit: 1
          });
          
          if (existingDocs.ids && existingDocs.ids.length > 0) {
            console.log('⏭️ SKIPPED DUPLICATE KNOWLEDGE (same title):', title);
            logger.debug('Skipping duplicate knowledge by title', { title });
            return { skipped: true, reason: 'duplicate', existingTitle: title };
          }
        } catch (dupError) {
          logger.debug('Duplicate check failed, proceeding with store', { error: dupError.message });
        }
      }

      // Chunk the content
      const chunks = this.chunkText(content, {
        chunkSize: 500,      // ~500 tokens per chunk
        chunkOverlap: 50     // 50 token overlap for context continuity
      });

      logger.info('Chunking document', { 
        title, 
        contentLength: content.length, 
        chunkCount: chunks.length 
      });

      // Store each chunk with metadata linking to parent document
      const chunkIds = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${documentId}_chunk_${i}`;
        chunkIds.push(chunkId);
        
        const chunkMetadata = {
          schema_version: '1.0',
          memory_type: 'knowledge',
          timestamp: new Date().toISOString(),
          title: title,
          category: category,
          source: source,
          document_id: documentId,
          chunk_index: i,
          total_chunks: chunks.length,
          content_length: content.length,
          chunk_length: chunks[i].length,
          ...metadata
        };

        await this.collections.knowledge.add({
          ids: [chunkId],
          documents: [chunks[i]],
          metadatas: [chunkMetadata]
        });
      }

      console.log(`✅ STORED KNOWLEDGE: ${title} (${chunks.length} chunks)`);
      logger.info('Knowledge document stored', { 
        documentId, 
        title, 
        category, 
        source, 
        contentLength: content.length,
        chunkCount: chunks.length 
      });
      
      return { 
        id: documentId, 
        skipped: false, 
        title, 
        chunkCount: chunks.length,
        chunkIds 
      };

    } catch (error) {
      logger.error('Failed to store knowledge', { 
        title, 
        category, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Split text into overlapping chunks for better retrieval
   * @param {string} text - Text to chunk
   * @param {Object} options - Chunking options
   * @returns {string[]} Array of text chunks
   */
  chunkText(text, { chunkSize = 500, chunkOverlap = 50 } = {}) {
    if (!text || text.length === 0) {
      return [text];
    }

    // Approximate tokens as words (rough estimate: 1 token ≈ 4 chars or ~0.75 words)
    // We'll use character-based chunking with ~2000 chars per chunk (~500 tokens)
    const charsPerChunk = chunkSize * 4;
    const overlapChars = chunkOverlap * 4;

    // If content is small enough, return as single chunk
    if (text.length <= charsPerChunk) {
      return [text];
    }

    const chunks = [];
    let startIndex = 0;

    while (startIndex < text.length) {
      let endIndex = startIndex + charsPerChunk;
      
      // Try to break at a natural boundary (paragraph, sentence, or word)
      if (endIndex < text.length) {
        // Look for paragraph break first
        const paragraphBreak = text.lastIndexOf('\n\n', endIndex);
        if (paragraphBreak > startIndex + charsPerChunk * 0.5) {
          endIndex = paragraphBreak + 2;
        } else {
          // Look for sentence break
          const sentenceBreak = text.lastIndexOf('. ', endIndex);
          if (sentenceBreak > startIndex + charsPerChunk * 0.5) {
            endIndex = sentenceBreak + 2;
          } else {
            // Look for word break
            const wordBreak = text.lastIndexOf(' ', endIndex);
            if (wordBreak > startIndex + charsPerChunk * 0.5) {
              endIndex = wordBreak + 1;
            }
          }
        }
      }

      chunks.push(text.slice(startIndex, endIndex).trim());
      
      // Move start with overlap
      startIndex = endIndex - overlapChars;
      
      // Prevent infinite loop
      if (startIndex >= text.length - overlapChars) {
        break;
      }
    }

    // Handle any remaining text
    if (startIndex < text.length && chunks.length > 0) {
      const lastChunk = text.slice(startIndex).trim();
      if (lastChunk.length > overlapChars) {
        chunks.push(lastChunk);
      }
    }

    return chunks.filter(chunk => chunk.length > 0);
  }

  /**
   * Get all knowledge documents (for browsing/management)
   * Aggregates chunks back into documents for display
   */
  async browseKnowledge({ limit = 100, category = null } = {}) {
    await this.ensureInitialized();

    try {
      if (!this.collections.knowledge) {
        return { documents: [], count: 0 };
      }

      const options = {
        limit: limit * 10, // Get more to account for chunks
        include: ['metadatas', 'documents']
      };

      if (category) {
        options.where = { category: category };
      }

      const results = await this.collections.knowledge.get(options);
      
      // Aggregate chunks by document_id
      const documentMap = new Map();
      
      if (results.documents && results.ids) {
        results.documents.forEach((doc, index) => {
          const meta = results.metadatas?.[index] || {};
          const docId = meta.document_id || results.ids[index];
          
          if (!documentMap.has(docId)) {
            documentMap.set(docId, {
              id: docId,
              title: meta.title || 'Untitled',
              category: meta.category || 'general',
              source: meta.source || 'unknown',
              timestamp: meta.timestamp,
              totalChunks: meta.total_chunks || 1,
              contentLength: meta.content_length || doc.length,
              chunks: []
            });
          }
          
          documentMap.get(docId).chunks.push({
            index: meta.chunk_index || 0,
            content: doc,
            chunkId: results.ids[index]
          });
        });
      }

      // Sort chunks and reconstruct content preview
      const documents = [];
      documentMap.forEach((doc, docId) => {
        doc.chunks.sort((a, b) => a.index - b.index);
        const fullContent = doc.chunks.map(c => c.content).join(' ');
        documents.push({
          id: docId,
          content: fullContent.substring(0, 500) + (fullContent.length > 500 ? '...' : ''),
          fullContent: fullContent,
          metadata: {
            title: doc.title,
            category: doc.category,
            source: doc.source,
            timestamp: doc.timestamp,
            total_chunks: doc.totalChunks,
            content_length: doc.contentLength
          },
          title: doc.title,
          chunkCount: doc.chunks.length,
          chunkIds: doc.chunks.map(c => c.chunkId)
        });
      });

      // Sort by timestamp (newest first) and limit
      documents.sort((a, b) => new Date(b.metadata.timestamp) - new Date(a.metadata.timestamp));
      
      return { 
        documents: documents.slice(0, limit), 
        count: documents.length 
      };

    } catch (error) {
      logger.error('Failed to browse knowledge', { error: error.message });
      throw error;
    }
  }

  /**
   * Delete a knowledge document and all its chunks
   */
  async deleteKnowledge(id) {
    await this.ensureInitialized();

    try {
      // First, find all chunks belonging to this document
      const results = await this.collections.knowledge.get({
        where: { document_id: id },
        include: ['metadatas']
      });

      let idsToDelete = [];
      
      if (results.ids && results.ids.length > 0) {
        // Found chunks by document_id
        idsToDelete = results.ids;
      } else {
        // Maybe it's a legacy single-chunk document or direct chunk ID
        idsToDelete = [id];
      }

      await this.collections.knowledge.delete({
        ids: idsToDelete
      });
      
      logger.info('Knowledge document deleted', { id, chunksDeleted: idsToDelete.length });
      return { deleted: true, id, chunksDeleted: idsToDelete.length };

    } catch (error) {
      logger.error('Failed to delete knowledge', { id, error: error.message });
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

      // Build ChromaDB where clause - try different formats based on the stored data you showed
      let conversationWhere = {};
      
      // Convert userId to exact format that's stored (based on your browse data)
      let userIdStr;
      if (typeof userId === 'object' && userId !== null) {
        userIdStr = userId.toString();
      } else {
        userIdStr = String(userId || '').trim();
      }
      
      // Validate the final user ID string
      if (!userIdStr || userIdStr === 'undefined' || userIdStr === 'null' || userIdStr === '') {
        throw new Error(`Invalid userId for ChromaDB query: ${JSON.stringify(userId)}`);
      }
      
      // Use the same pattern as browseMemories which works
      // Start with just user_id (like browseMemories does)
      conversationWhere = {
        user_id: userIdStr
      };
      
      // TEMPORARILY skip conversation_id to test if that's the issue
      // Based on browse memories working with just user_id
      if (conversationId) {
        let conversationIdStr;
        if (typeof conversationId === 'object' && conversationId !== null) {
          conversationIdStr = conversationId.toString();
        } else {
          conversationIdStr = String(conversationId || '').trim();
        }
        
        if (conversationIdStr && conversationIdStr !== 'undefined' && conversationIdStr !== 'null' && conversationIdStr !== '') {
          // Try using $and operator for multiple conditions as per ChromaDB docs
          // ALSO filter by role='user' to only retrieve user messages for context
          conversationWhere = {
            "$and": [
              { "user_id": userIdStr },
              { "conversation_id": conversationIdStr },
              { "role": "user" }
            ]
          };
        } else {
          // No conversation ID, but still filter by role='user'
          conversationWhere = {
            "$and": [
              { "user_id": userIdStr },
              { "role": "user" }
            ]
          };
        }
      } else {
        // No conversation ID provided, filter by user and role
        conversationWhere = {
          "$and": [
            { "user_id": userIdStr },
            { "role": "user" }
          ]
        };
      }
      
      logger.debug('ChromaDB where clause constructed', {
        whereClause: conversationWhere,
        userIdOriginal: userId,
        userIdFinal: userIdStr,
        conversationId: conversationId
      });

      logger.debug('ChromaDB semantic search query parameters', {
        queryTexts: [query],
        nResults: Math.floor(limit * 0.4),
        where: conversationWhere,
        userIdType: typeof conversationWhere.user_id,
        conversationIdType: typeof conversationWhere.conversation_id
      });

      // Perform semantic search with embeddings (with error handling)
      let conversationResults;
      try {
        // First, try without where clause to see what data exists
        logger.debug('Attempting ChromaDB query with where clause', {
          whereClause: conversationWhere,
          query: query.substring(0, 50)
        });
        
        conversationResults = await this.collections.conversations.query({
          queryTexts: [query],
          nResults: Math.floor(limit * 0.5), // 50% from conversations
          where: conversationWhere,
          include: ['metadatas', 'documents', 'distances']
        });
      } catch (queryError) {
        logger.error('ChromaDB conversation query failed, trying without where clause', {
          error: queryError.message,
          whereClause: conversationWhere,
          query: query.substring(0, 100)
        });
        
        // Try without where clause to see what data actually exists
        try {
          const allResults = await this.collections.conversations.query({
            queryTexts: [query],
            nResults: Math.floor(limit * 0.4),
            include: ['metadatas', 'documents', 'distances']
          });
          
          logger.debug('Query without where clause successful', {
            resultCount: allResults.documents?.[0]?.length || 0,
            sampleMetadata: allResults.metadatas?.[0]?.[0] || null
          });
          
          // Filter results manually if we got any
          if (allResults.documents && allResults.documents[0] && allResults.documents[0].length > 0) {
            const filteredIndices = [];
            allResults.metadatas[0].forEach((metadata, index) => {
              const matchesUser = metadata.user_id === conversationWhere.user_id || 
                                  (conversationWhere.$and && metadata.user_id === conversationWhere.$and.find(c => c.user_id)?.user_id);
              const matchesConversation = !conversationId || metadata.conversation_id === conversationId;
              const matchesRole = metadata.role === 'user'; // Only retrieve user messages
              if (matchesUser && matchesConversation && matchesRole) {
                filteredIndices.push(index);
              }
            });
            
            // Build filtered results
            conversationResults = {
              documents: [filteredIndices.map(i => allResults.documents[0][i])],
              metadatas: [filteredIndices.map(i => allResults.metadatas[0][i])],
              ids: [filteredIndices.map(i => allResults.ids[0][i])],
              distances: [filteredIndices.map(i => allResults.distances[0][i])]
            };
            
            logger.debug('Manual filtering applied', {
              originalCount: allResults.documents[0].length,
              filteredCount: filteredIndices.length
            });
          } else {
            conversationResults = {
              documents: [[]],
              metadatas: [[]],
              ids: [[]],
              distances: [[]]
            };
          }
        } catch (fallbackError) {
          logger.error('Even query without where clause failed', {
            error: fallbackError.message
          });
          // Return empty results if everything fails
          conversationResults = {
            documents: [[]],
            metadatas: [[]],
            ids: [[]],
            distances: [[]]
          };
        }
      }

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
          nResults: Math.floor(limit * 0.25), // 25% from events  
          where: eventWhere,
          include: ['metadatas', 'documents', 'distances']
        });
        
        logger.debug('Event semantic search results', {
          documentsCount: eventResults.documents?.[0]?.length || 0,
          avgDistance: eventResults.distances?.[0]?.reduce((a, b) => a + b, 0) / (eventResults.distances?.[0]?.length || 1)
        });
      }

      // Search facts for relevant context
      let factsResults = { documents: [[]], metadatas: [[]], ids: [[]], distances: [[]] };
      if (this.collections.facts && eventUserIdStr) {
        try {
          factsResults = await this.collections.facts.query({
            queryTexts: [query],
            nResults: Math.floor(limit * 0.25), // 25% from facts
            where: { user_id: eventUserIdStr },
            include: ['metadatas', 'documents', 'distances']
          });
          
          logger.debug('Facts semantic search results', {
            documentsCount: factsResults.documents?.[0]?.length || 0
          });
        } catch (factsError) {
          logger.debug('Facts query failed (collection may be new)', { error: factsError.message });
        }
      }

      // Search preferences for relevant context
      let prefsResults = { documents: [[]], metadatas: [[]], ids: [[]], distances: [[]] };
      if (this.collections.preferences && eventUserIdStr) {
        try {
          prefsResults = await this.collections.preferences.query({
            queryTexts: [query],
            nResults: Math.floor(limit * 0.25), // 25% from preferences
            where: { user_id: eventUserIdStr },
            include: ['metadatas', 'documents', 'distances']
          });
          
          logger.debug('Preferences semantic search results', {
            documentsCount: prefsResults.documents?.[0]?.length || 0
          });
        } catch (prefsError) {
          logger.debug('Preferences query failed', { error: prefsError.message });
        }
      }

      // Search knowledge base for relevant context (global knowledge, no user filter)
      let knowledgeResults = { documents: [[]], metadatas: [[]], ids: [[]], distances: [[]] };
      if (this.collections.knowledge) {
        try {
          knowledgeResults = await this.collections.knowledge.query({
            queryTexts: [query],
            nResults: Math.floor(limit * 0.3), // 30% from knowledge base
            include: ['metadatas', 'documents', 'distances']
          });
          
          logger.debug('Knowledge base semantic search results', {
            documentsCount: knowledgeResults.documents?.[0]?.length || 0
          });
        } catch (knowledgeError) {
          logger.debug('Knowledge query failed (collection may be empty)', { error: knowledgeError.message });
        }
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

      // Add fact memories
      if (factsResults.documents && factsResults.documents[0]) {
        factsResults.documents[0].forEach((doc, index) => {
          relevantMemories.push({
            type: 'fact',
            content: doc,
            metadata: factsResults.metadatas[0][index],
            distance: factsResults.distances[0][index]
          });
        });
      }

      // Add preference memories
      if (prefsResults.documents && prefsResults.documents[0]) {
        prefsResults.documents[0].forEach((doc, index) => {
          relevantMemories.push({
            type: 'preference',
            content: doc,
            metadata: prefsResults.metadatas[0][index],
            distance: prefsResults.distances[0][index]
          });
        });
      }

      // Add knowledge base memories
      if (knowledgeResults.documents && knowledgeResults.documents[0]) {
        knowledgeResults.documents[0].forEach((doc, index) => {
          relevantMemories.push({
            type: 'knowledge',
            content: doc,
            metadata: knowledgeResults.metadatas[0][index],
            distance: knowledgeResults.distances[0][index]
          });
        });
      }

      // Sort by relevance (lower distance = more relevant)
      relevantMemories.sort((a, b) => a.distance - b.distance);

      logger.debug('Retrieved relevant context - detailed', { 
        userId, 
        query, 
        memoryCount: relevantMemories.length,
        memories: relevantMemories.slice(0, 3).map(m => ({
          type: m.type,
          distance: m.distance,
          preview: m.content?.substring(0, 100) + '...'
        }))
      });

      // If no relevant memories found with semantic search, try fallback with recent memories
      if (relevantMemories.length === 0) {
        logger.info('No memories found via semantic search, trying fallback with recent memories');
        
        try {
          const fallbackMemories = await this.getRecentConversation({
            userId: userIdStr,
            conversationId: null, // Get from any conversation
            limit: Math.min(limit, 3)
          });
          
          // Convert to same format as semantic search results
          fallbackMemories.forEach(memory => {
            relevantMemories.push({
              type: 'conversation',
              content: memory.document || memory.content,
              metadata: memory.metadata,
              distance: 1.0 // Mark as fallback with moderate relevance
            });
          });
          
          logger.debug('Added fallback memories', {
            fallbackCount: fallbackMemories.length,
            totalMemories: relevantMemories.length
          });
        } catch (fallbackError) {
          logger.warn('Fallback memory retrieval also failed', { error: fallbackError.message });
        }
      }

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
        limit: limit,
        include: ['documents', 'metadatas']
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
  async getRecentConversation({ userId, conversationId, limit = 12 }) {
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

      // Build ChromaDB where clause with enhanced validation  
      // Convert userId to string and validate
      let userIdStr;
      if (typeof userId === 'object' && userId !== null) {
        userIdStr = userId.toString();
      } else {
        userIdStr = String(userId || '').trim();
      }
      
      if (!userIdStr || userIdStr === 'undefined' || userIdStr === 'null' || userIdStr === '') {
        throw new Error(`Invalid userId for getRecentConversation: ${JSON.stringify(userId)}`);
      }
      
      // Sanitize user ID to prevent ChromaDB issues
      if (!/^[a-zA-Z0-9_-]+$/.test(userIdStr)) {
        logger.warn('User ID contains special characters, sanitizing for ChromaDB', { originalUserId: userIdStr });
        userIdStr = userIdStr.replace(/[^a-zA-Z0-9_-]/g, '_');
      }
      
      // Convert conversationId to string and validate
      let conversationIdStr;
      if (typeof conversationId === 'object' && conversationId !== null) {
        conversationIdStr = conversationId.toString();
      } else {
        conversationIdStr = String(conversationId || '').trim();
      }
      
      if (!conversationIdStr || conversationIdStr === 'undefined' || conversationIdStr === 'null' || conversationIdStr === '') {
        throw new Error(`Invalid conversationId for getRecentConversation: ${JSON.stringify(conversationId)}`);
      }
      
      // Use $and operator for multiple conditions (following ChromaDB docs)
      const whereClause = {
        "$and": [
          { "user_id": userIdStr },
          { "conversation_id": conversationIdStr }
        ]
      };

      logger.debug('ChromaDB get where clause', {
        where: whereClause,
        userIdType: typeof whereClause.user_id,
        conversationIdType: typeof whereClause.conversation_id
      });

      let results;
      try {
        logger.debug('Attempting ChromaDB get with where clause', {
          whereClause: whereClause,
          limit: limit
        });
        
        // Get more than needed, then sort and slice - ChromaDB get() doesn't guarantee order
        results = await this.collections.conversations.get({
          where: whereClause,
          limit: limit * 3, // Get 3x to ensure we have enough after sorting
          include: ['documents', 'metadatas']
        });
      } catch (getError) {
        logger.error('ChromaDB get conversation failed, trying without where clause', {
          error: getError.message,
          whereClause: whereClause,
          userId: userIdStr,
          conversationId: conversationIdStr
        });
        
        // Try to get all documents and filter manually
        try {
          const allResults = await this.collections.conversations.get({
            limit: limit * 3, // Get more to filter from
            include: ['documents', 'metadatas']
          });
          
          logger.debug('Get without where clause successful', {
            totalCount: allResults.documents?.length || 0,
            sampleMetadata: allResults.metadatas?.[0] || null
          });
          
          // Filter manually
          const filteredIndices = [];
          if (allResults.metadatas) {
            allResults.metadatas.forEach((metadata, index) => {
              const matchesUser = metadata.user_id === userIdStr;
              const matchesConversation = metadata.conversation_id === conversationIdStr;
              if (matchesUser && matchesConversation) {
                filteredIndices.push(index);
              }
            });
          }
          
          // Build filtered results
          results = {
            documents: filteredIndices.map(i => allResults.documents[i]),
            metadatas: filteredIndices.map(i => allResults.metadatas[i]),
            ids: filteredIndices.map(i => allResults.ids[i])
          };
          
          // Limit to requested size
          if (results.documents.length > limit) {
            results.documents = results.documents.slice(-limit); // Keep most recent
            results.metadatas = results.metadatas.slice(-limit);
            results.ids = results.ids.slice(-limit);
          }
          
          logger.debug('Manual filtering for get applied', {
            totalCount: allResults.documents?.length || 0,
            filteredCount: filteredIndices.length,
            finalCount: results.documents.length
          });
        } catch (fallbackError) {
          logger.error('Even get without where clause failed', {
            error: fallbackError.message
          });
          results = {
            documents: [],
            metadatas: [],
            ids: []
          };
        }
      }

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