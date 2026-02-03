import OpenAI from 'openai';
import { VectorStore, InMemoryVectorStore } from './vector-store.js';
import { Logger } from './logger.js';
import * as path from 'path';

export interface KBEntry {
  id: string;
  content: string;
  category: string;
  tags: string[];
  timestamp: number;
}

export interface SearchResult {
  entry: KBEntry;
  similarity: number;
  relevance: 'high' | 'medium' | 'low';
}

export class SemanticSearch {
  private openai: OpenAI;
  private vectorStore: VectorStore;
  private logger: Logger;
  private indexPath: string;
  private initialized: boolean = false;

  constructor(logger: Logger) {
    this.logger = logger;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || ''
    });
    this.vectorStore = new InMemoryVectorStore();
    this.indexPath = path.join(
      process.env.HOME || '~',
      '.openclaw',
      'tribe-vector-index.json'
    );

    // Load existing index
    this.loadIndex();
  }

  /**
   * Generate embedding for text
   */
  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float'
      });

      return response.data[0].embedding;
    } catch (error: any) {
      this.logger.error('Embedding failed', error);
      throw error;
    }
  }

  /**
   * Index a knowledge base entry
   */
  async indexEntry(entry: KBEntry): Promise<void> {
    this.logger.debug('Indexing KB entry', { id: entry.id });

    const embedding = await this.embed(entry.content);

    await this.vectorStore.upsert([{
      id: entry.id,
      values: embedding,
      metadata: {
        category: entry.category,
        tags: entry.tags,
        timestamp: entry.timestamp,
        content: entry.content.substring(0, 500) // Store snippet
      }
    }]);

    // Persist index
    await this.saveIndex();
  }

  /**
   * Index all KB entries
   */
  async indexKnowledge(entries: KBEntry[]): Promise<void> {
    this.logger.info('Indexing knowledge base', { count: entries.length });

    // Batch embeddings for efficiency
    const batchSize = 100;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);

      const embeddings = await Promise.all(
        batch.map(e => this.embed(e.content))
      );

      await this.vectorStore.upsert(
        batch.map((entry, idx) => ({
          id: entry.id,
          values: embeddings[idx],
          metadata: {
            category: entry.category,
            tags: entry.tags,
            timestamp: entry.timestamp,
            content: entry.content.substring(0, 500)
          }
        }))
      );

      this.logger.debug(`Indexed batch ${Math.floor(i / batchSize) + 1}`, {
        processed: i + batch.length,
        total: entries.length
      });
    }

    await this.saveIndex();
    this.initialized = true;
    this.logger.info('Indexing complete');
  }

  /**
   * Semantic search
   */
  async search(
    query: string,
    options: {
      limit?: number;
      minSimilarity?: number;
      categories?: string[];
      tags?: string[];
    } = {}
  ): Promise<SearchResult[]> {
    const limit = options.limit || 10;
    const minSimilarity = options.minSimilarity || 0.7;

    this.logger.debug('Semantic search', { query, limit });

    // Embed query
    const queryEmbedding = await this.embed(query);

    // Search vector store
    const results = await this.vectorStore.query(queryEmbedding, limit * 2);

    // Filter and map results
    const filtered = results
      .filter(r => {
        // Similarity threshold
        if (r.score < minSimilarity) return false;

        // Category filter
        if (options.categories && !options.categories.includes(r.metadata.category)) {
          return false;
        }

        // Tag filter
        if (options.tags) {
          const entryTags = r.metadata.tags || [];
          const hasTag = options.tags.some((t: string) => entryTags.includes(t));
          if (!hasTag) return false;
        }

        return true;
      })
      .slice(0, limit)
      .map(r => ({
        entry: {
          id: r.id,
          content: r.metadata.content,
          category: r.metadata.category,
          tags: r.metadata.tags,
          timestamp: r.metadata.timestamp
        },
        similarity: r.score,
        relevance: this.scoreToRelevance(r.score)
      }));

    this.logger.debug('Search complete', { resultCount: filtered.length });

    return filtered;
  }

  private scoreToRelevance(score: number): 'high' | 'medium' | 'low' {
    if (score >= 0.85) return 'high';
    if (score >= 0.7) return 'medium';
    return 'low';
  }

  private async loadIndex(): Promise<void> {
    try {
      await (this.vectorStore as InMemoryVectorStore).load(this.indexPath);
      this.initialized = true;
      this.logger.info('Loaded vector index');
    } catch (error) {
      this.logger.warn('No existing vector index found');
    }
  }

  private async saveIndex(): Promise<void> {
    try {
      await (this.vectorStore as InMemoryVectorStore).save(this.indexPath);
    } catch (error: any) {
      this.logger.error('Failed to save vector index', error);
    }
  }

  /**
   * Delete entry from index
   */
  async deleteEntry(id: string): Promise<void> {
    await this.vectorStore.delete([id]);
    await this.saveIndex();
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
