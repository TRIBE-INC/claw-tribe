import * as fs from 'fs/promises';

export interface VectorEntry {
  id: string;
  values: number[];
  metadata: Record<string, any>;
}

export interface QueryResult {
  id: string;
  score: number;
  metadata: Record<string, any>;
}

export interface VectorStore {
  upsert(entries: VectorEntry[]): Promise<void>;
  query(vector: number[], topK: number): Promise<QueryResult[]>;
  delete(ids: string[]): Promise<void>;
}

/**
 * Simple in-memory vector store using cosine similarity
 * For production, use Pinecone or similar
 */
export class InMemoryVectorStore implements VectorStore {
  private entries: Map<string, VectorEntry> = new Map();

  async upsert(entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  async query(vector: number[], topK: number): Promise<QueryResult[]> {
    const results: QueryResult[] = [];

    for (const [id, entry] of this.entries) {
      const score = this.cosineSimilarity(vector, entry.values);
      results.push({
        id,
        score,
        metadata: entry.metadata
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.entries.delete(id);
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Persist to disk
  async save(filepath: string): Promise<void> {
    const data = Array.from(this.entries.values());
    await fs.writeFile(filepath, JSON.stringify(data, null, 2));
  }

  async load(filepath: string): Promise<void> {
    try {
      const content = await fs.readFile(filepath, 'utf-8');
      const data: VectorEntry[] = JSON.parse(content);
      this.entries = new Map(data.map((e) => [e.id, e]));
    } catch (error) {
      // File doesn't exist yet, that's okay
      this.entries = new Map();
    }
  }
}
