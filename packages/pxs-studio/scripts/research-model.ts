/**
 * Prove the Model agent can RESEARCH a model's capabilities from the live web instead of a hand-typed
 * table. Usage: node --env-file=.env.local --import tsx scripts/research-model.ts [modelId]
 */
import { IMAGE_MODELS } from '../src/lib/engine/model-registry';
import { PROVIDERS, registryTag } from '../src/lib/engine/provider-roster';
import { researchModelCapabilities } from '../src/lib/agents/model-agent/research-capabilities';

async function main() {
  const id = process.argv[2] || 'grok-2-image';
  const m = IMAGE_MODELS.find((x) => x.id === id);
  if (!m) {
    console.error(`unknown model: ${id}`);
    process.exit(1);
  }
  const provider = PROVIDERS.find((p) => registryTag(p) === m.provider);

  console.log(`\nResearching ${m.label} (${m.provider}) from the live web …\n`);
  const r = await researchModelCapabilities({ id: m.id, label: m.label, provider: m.provider, docsUrl: provider?.docsUrl });

  console.log('── EXTRACTED (grounded in the sources below, NOT from memory) ──');
  console.log(
    JSON.stringify(
      { maxReferenceImages: r.maxReferenceImages, supportsEditing: r.supportsEditing, capabilities: r.capabilities, aspectRatios: r.aspectRatios, notes: r.notes, confidence: r.confidence },
      null,
      2,
    ),
  );
  console.log('\n── SOURCES (provenance) ──');
  if (r.sources.length === 0) console.log('  (none — Tavily returned nothing / no key)');
  for (const s of r.sources) console.log(`  - ${s.title} — ${s.url}`);
  console.log(`\n── vs the hand-typed registry ── maxRef=${m.maxReferenceImages} · editing=${m.supportsEditing}\n`);
}

void main();
