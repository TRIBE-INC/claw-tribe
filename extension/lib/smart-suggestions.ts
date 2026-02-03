import { SemanticSearch, SearchResult } from './semantic-search.js';
import { Logger } from './logger.js';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{ type: string; text?: string }>;
}

export interface Suggestion {
  content: string;
  category: string;
  similarity: number;
  reason: string;
}

export class SmartSuggestions {
  private semanticSearch: SemanticSearch;
  private logger: Logger;

  constructor(semanticSearch: SemanticSearch, logger: Logger) {
    this.semanticSearch = semanticSearch;
    this.logger = logger;
  }

  /**
   * Extract message content as string
   */
  private extractContent(message: Message): string {
    if (typeof message.content === 'string') {
      return message.content;
    }

    // Handle content blocks
    if (Array.isArray(message.content)) {
      return message.content
        .filter(block => block.type === 'text' && block.text)
        .map(block => block.text)
        .join('\n');
    }

    return '';
  }

  /**
   * Extract topics from recent messages
   */
  extractTopics(messages: Message[]): string[] {
    const topics: string[] = [];

    // Get last 5 messages
    const recent = messages.slice(-5);

    for (const msg of recent) {
      if (msg.role === 'system') continue;

      const content = this.extractContent(msg);

      // Extract keywords and technical terms
      const words = content
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3)
        .filter(w => !this.isStopWord(w));

      // Look for technical patterns (PascalCase, camelCase)
      const technicalTerms = content.match(
        /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g
      ) || [];

      topics.push(...words, ...technicalTerms.map(t => t.toLowerCase()));
    }

    // Deduplicate and take top 5 most frequent
    const frequency = new Map<string, number>();
    for (const topic of topics) {
      frequency.set(topic, (frequency.get(topic) || 0) + 1);
    }

    return Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but',
      'in', 'with', 'to', 'for', 'of', 'as', 'by', 'this', 'that',
      'can', 'will', 'should', 'could', 'would', 'how', 'what', 'when',
      'where', 'why', 'who', 'there', 'here', 'from', 'into', 'about'
    ]);

    return stopWords.has(word);
  }

  /**
   * Suggest relevant knowledge based on conversation
   */
  async suggestRelevant(
    conversation: Message[],
    options: {
      limit?: number;
      minSimilarity?: number;
    } = {}
  ): Promise<Suggestion[]> {
    const limit = options.limit || 3;
    const minSimilarity = options.minSimilarity || 0.75;

    this.logger.debug('Generating smart suggestions');

    // Extract topics
    const topics = this.extractTopics(conversation);

    if (topics.length === 0) {
      return [];
    }

    this.logger.debug('Extracted topics', { topics });

    // Search for each topic
    const allResults: Map<string, SearchResult> = new Map();

    for (const topic of topics) {
      try {
        const results = await this.semanticSearch.search(topic, {
          limit: 5,
          minSimilarity
        });

        for (const result of results) {
          const existing = allResults.get(result.entry.id);
          if (!existing || result.similarity > existing.similarity) {
            allResults.set(result.entry.id, result);
          }
        }
      } catch (error) {
        this.logger.debug(`Search failed for topic: ${topic}`, error);
      }
    }

    // Sort by similarity and take top N
    const suggestions = Array.from(allResults.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(r => ({
        content: r.entry.content.substring(0, 300) + '...',
        category: r.entry.category,
        similarity: r.similarity,
        reason: this.generateReason(r, topics)
      }));

    this.logger.debug('Generated suggestions', { count: suggestions.length });

    return suggestions;
  }

  private generateReason(result: SearchResult, topics: string[]): string {
    // Find which topic matched
    const matchedTopics = topics.filter(t =>
      result.entry.content.toLowerCase().includes(t.toLowerCase())
    );

    if (matchedTopics.length > 0) {
      return `Related to: ${matchedTopics.slice(0, 2).join(', ')}`;
    }

    return `${result.relevance} relevance match`;
  }

  /**
   * Format suggestions for context injection
   */
  formatSuggestions(suggestions: Suggestion[]): string {
    if (suggestions.length === 0) {
      return '';
    }

    let formatted = '\n<relevant-knowledge>\n';
    formatted += 'You may find these past insights helpful:\n\n';

    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      formatted += `${i + 1}. [${s.category}] ${s.content}\n`;
      formatted += `   (${s.reason}, ${(s.similarity * 100).toFixed(0)}% match)\n\n`;
    }

    formatted += '</relevant-knowledge>\n';

    return formatted;
  }

  /**
   * Inject suggestions into context
   */
  async injectSuggestions(
    conversation: Message[],
    existingContext: string
  ): Promise<string> {
    // Don't suggest on very short conversations
    if (conversation.length < 2) {
      return existingContext;
    }

    try {
      const suggestions = await this.suggestRelevant(conversation, {
        limit: 3,
        minSimilarity: 0.75
      });

      if (suggestions.length === 0) {
        return existingContext;
      }

      const suggestionBlock = this.formatSuggestions(suggestions);

      return existingContext + suggestionBlock;
    } catch (error) {
      this.logger.error('Failed to inject suggestions', error);
      return existingContext;
    }
  }
}
