/**
 * Tavily search client — the Model agent's EYES on the live web. This is what makes the agent REAL
 * instead of a hand-typed table: capability facts (reference limits, file-size caps, features, prompt
 * formulas) come from FETCHED provider docs, grounded + provenance-stamped, never from an LLM's memory
 * (which hallucinates — the exact failure that had Brian correcting Grok's limits by hand).
 *
 * Server-side only (reads TAVILY_API_KEY). Never throws — a failed search returns [] so research
 * degrades to "unverified", never a crash.
 */

export interface WebResult {
  title: string;
  url: string;
  /** Tavily's extracted, cleaned content for the page (the grounding text). */
  content: string;
}

/** True when a Tavily key is present (the agent can actually research). */
export function tavilyConfigured(): boolean {
  return !!process.env.TAVILY_API_KEY;
}

/**
 * Search the web and return grounded results (title · url · extracted content). `query` should be
 * specific (e.g. "xAI Grok images edits API maximum reference images file size limit"). Returns [] on
 * any failure or missing key.
 */
export async function tavilySearch(query: string, opts: { maxResults?: number } = {}): Promise<WebResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'advanced',
        max_results: Math.max(1, Math.min(10, opts.maxResults ?? 5)),
        include_answer: false,
      }),
    });
    if (!res.ok) {
      console.warn(`[tavily] ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return [];
    }
    const data = (await res.json().catch(() => null)) as { results?: Array<{ title?: string; url?: string; content?: string }> } | null;
    return (data?.results ?? [])
      .filter((r) => typeof r.url === 'string' && typeof r.content === 'string')
      .map((r) => ({ title: r.title ?? '', url: r.url as string, content: r.content as string }));
  } catch (err) {
    console.warn('[tavily] search failed:', err);
    return [];
  }
}
