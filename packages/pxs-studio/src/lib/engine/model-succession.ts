/**
 * SUCCESSOR DETECTION — noticing that the model you route to has been superseded.
 *
 * The refresh pass answers "does this model still exist?" and "are there ids we have never seen?".
 * Neither question catches the thing that actually degrades output quality: a model we curated is
 * still live, still working, still confirmed — and a NEWER VERSION of it shipped beside it.
 *
 * That failure has now happened four times in this project. FLUX sat two generations stale. Recraft
 * V3 was routed to while V4.1 had been the API default for months. Happy Horse was seeded at 1.0 with
 * 1.1 live. And Seedance 2.0 was in the registry while 2.5 — double the clip length — was one page
 * away. Every one was caught by a person reading a docs site, which is precisely the labour this
 * system exists to eliminate.
 *
 * The reason discovery misses it: `bytedance/seedance-2.5/...` is simply an unfamiliar id. Nothing
 * connects it to `bytedance/seedance-2.0/...`, so it lands as a candidate among dozens rather than as
 * "the model you are using, but newer".
 *
 * So: parse ids into (family, version) and compare. Pure + deterministic — this is a string question,
 * and answering it with an LLM call would be both slower and less reliable.
 */

/** A model id split into the part that identifies it and the part that versions it. */
export interface ParsedModelId {
  /** The id with version numbers removed — what makes two ids the same MODEL. */
  family: string;
  /** Version components, most significant first. Empty when the id carries no version. */
  version: number[];
  raw: string;
}

/**
 * Split an id into family + version. Handles the shapes providers actually use:
 *   bytedance/seedance-2.5/text-to-video → family 'bytedance/seedance/text-to-video', v [2,5]
 *   gemini-3.1-flash-image               → family 'gemini-flash-image',                v [3,1]
 *   recraftv4_1                          → family 'recraft',                           v [4,1]
 *   flux-2-pro                           → family 'flux-pro',                          v [2]
 */
export function parseModelId(id: string): ParsedModelId {
  // Some providers glue the version straight onto the name with no separator ('recraftv4_1',
  // 'recraftv3'). Insert one so a single rule handles both conventions — without this, 'recraftv4_1'
  // parses as family 'recraftv4' version 1, and never matches 'recraftv3' as its predecessor.
  const lowered = id.toLowerCase().trim().replace(/([a-z])v(\d)/g, '$1-v$2');
  const version: number[] = [];

  // Capture the FIRST version-looking token (2.5 · 3.1 · v4_1 · -2-), then strip every such token so
  // the remainder is a stable family name.
  const versionToken = /(?:^|[^a-z0-9])v?(\d+(?:[._]\d+)*)(?=$|[^a-z0-9]|[a-z])/;
  const m = lowered.match(versionToken);
  if (m) for (const part of m[1].split(/[._]/)) version.push(Number(part));

  const family = lowered
    .replace(/(?:^|[^a-z0-9])v?\d+(?:[._]\d+)*(?=$|[^a-z0-9]|[a-z])/g, '-')
    .replace(/[-_/]+/g, '-')
    .replace(/^-|-$/g, '')
    // Rejoin path segments so 'bytedance-seedance-text-to-video' compares cleanly.
    .replace(/-+/g, '-');

  return { family, version, raw: id };
}

/** Is `a` a strictly newer version than `b`? Compares component by component. */
export function isNewerVersion(a: number[], b: number[]): boolean {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export interface Succession {
  /** The registry id currently in use. */
  currentId: string;
  /** The newer id found live at the provider. */
  successorId: string;
  currentVersion: string;
  successorVersion: string;
  /** What the two ids have in common — evidence the match is not a coincidence. */
  family: string;
}

/**
 * Find live ids that are NEWER VERSIONS of models we already curate.
 *
 * Deliberately conservative: a succession is only reported when the family matches exactly and the
 * version is strictly higher. A newer version is a PROMPT TO RESEARCH, never an automatic swap —
 * Seedance 2.5 doubles clip length but drops 4K, so "newer" is not always "better for this job", and
 * deciding that requires reading the docs, which is the research pass's work.
 */
export function findSuccessors(curatedIds: string[], liveIds: string[]): Succession[] {
  const curated = curatedIds.map(parseModelId).filter((p) => p.version.length > 0);
  const live = liveIds.map(parseModelId).filter((p) => p.version.length > 0);
  const out: Succession[] = [];

  for (const c of curated) {
    // The newest live id in the same family, if it beats what we have.
    let best: ParsedModelId | null = null;
    for (const l of live) {
      if (l.family !== c.family) continue;
      if (!isNewerVersion(l.version, c.version)) continue;
      if (!best || isNewerVersion(l.version, best.version)) best = l;
    }
    if (best) {
      out.push({
        currentId: c.raw,
        successorId: best.raw,
        currentVersion: c.version.join('.'),
        successorVersion: best.version.join('.'),
        family: c.family,
      });
    }
  }
  // De-duplicate: several endpoint variants of one model collapse to one finding.
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.family}:${s.successorVersion}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── THE SWEEP ────────────────────────────────────────────────────────────────────────────────────

/** What a succession sweep found, per provider. */
export interface SuccessionReport {
  provider: string;
  successions: Succession[];
  /** Families checked — so "found nothing" is distinguishable from "never looked". */
  checkedFamilies: string[];
}

export interface SuccessionDeps {
  /**
   * Ask a provider what it has in a model family. Injected so the sweep is testable without network.
   * Providers differ: some publish a full listing, fal takes a keyword. Either way the caller returns
   * live ids for that family.
   */
  search: (provider: string, familyKeyword: string) => Promise<string[]>;
}

/** The searchable keyword for a family — the distinctive word, not the whole path. */
export function familyKeyword(id: string): string {
  const family = parseModelId(id).family;
  // 'bytedance-seedance-text-to-video' → 'seedance'. Drop vendor prefixes and endpoint suffixes so
  // the query is the model NAME, which is what a search index actually matches on.
  const noise = new Set([
    'text', 'to', 'video', 'image', 'reference', 'edit', 'fast', 'pro', 'dev', 'lite', 'turbo',
    'bytedance', 'alibaba', 'google', 'openai', 'black', 'forest', 'labs', 'fal', 'ai',
  ]);
  const words = family.split('-').filter((w) => w && !noise.has(w));
  return words[0] ?? family;
}

/**
 * Sweep every curated model's family for a newer version.
 *
 * Targeted rather than exhaustive: it asks "is there a newer X?" for each X we actually route to,
 * instead of pulling entire catalogues and diffing. That works with keyword-only APIs like fal's, and
 * it asks the question that matters — a provider's full listing is mostly models we will never use.
 */
export async function sweepForSuccessors(
  models: { id: string; provider: string; providerModelId?: string }[],
  deps: SuccessionDeps,
): Promise<SuccessionReport[]> {
  const byProvider = new Map<string, typeof models>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  const reports: SuccessionReport[] = [];
  for (const [provider, list] of byProvider) {
    const successions: Succession[] = [];
    const checkedFamilies: string[] = [];
    const seenKeyword = new Set<string>();

    for (const m of list) {
      const curatedId = m.providerModelId ?? m.id;
      const keyword = familyKeyword(curatedId);
      if (!keyword || seenKeyword.has(keyword)) continue;
      seenKeyword.add(keyword);
      checkedFamilies.push(keyword);
      try {
        const live = await deps.search(provider, keyword);
        // Map any successor back to OUR registry id, so the report names the record to update.
        for (const s of findSuccessors([curatedId], live)) {
          successions.push({ ...s, currentId: m.id });
        }
      } catch {
        /* a provider that will not answer is not a finding — the next pass tries again */
      }
    }
    reports.push({ provider, successions, checkedFamilies });
  }
  return reports;
}
