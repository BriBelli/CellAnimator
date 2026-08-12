/**
 * Research + persist REAL capabilities for every image model (Tavily + Claude, grounded, provenance).
 * Usage: node --env-file=.env.local --import tsx scripts/refresh-capabilities.ts
 */
import { getDb } from '../src/lib/db';
import { IMAGE_MODELS } from '../src/lib/engine/model-registry';
import { refreshCapabilities } from '../src/lib/agents/capability-refresh';

async function main() {
  const db = await getDb();
  console.log(`\nResearching ${IMAGE_MODELS.length} models from the live web (grounded + sourced) …\n`);
  const results = await refreshCapabilities(IMAGE_MODELS, db, { now: Date.now() });
  for (const r of results) {
    const mark = r.applied ? '✓ applied' : `· ${r.confidence}`;
    const patch = Object.keys(r.patch).length ? JSON.stringify(r.patch) : '(no grounded facts)';
    console.log(`  ${mark.padEnd(11)} ${r.modelId.padEnd(26)} ${patch}`);
  }
  const applied = results.filter((r) => r.applied).length;
  console.log(`\n${applied}/${results.length} models updated with SOURCED capabilities (low-confidence left as seed).\n`);
}

void main();
