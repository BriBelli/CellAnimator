/** Prove the roster reasons by CLASS, not tier. Prints the top-3 fan for several request classes. */
import { IMAGE_MODELS } from '../src/lib/engine/model-registry';
import { classifyRequest, pickRoster } from '../src/lib/engine/selection';
import type { RoutingRequest } from '../src/lib/engine/routing';

const cases: { name: string; req: Partial<RoutingRequest> }[] = [
  { name: 'Photoreal character sheet from a photo', req: { needs: ['photorealism', 'multi_reference'], references: ['x', 'y'], editing: true } },
  { name: 'Vector logo / brand mark', req: { needs: ['vector'] } },
  { name: 'Poster with legible headline text', req: { needs: ['text_in_image'] } },
  { name: 'Fast cheap exploration drafts', req: { needs: ['fast', 'cheap'] } },
  { name: 'Plain "make an image" (no needs)', req: { needs: [] } },
];

for (const c of cases) {
  const req = { intent: c.name, count: 3, ...c.req } as RoutingRequest;
  const profile = classifyRequest(req);
  const picks = pickRoster(IMAGE_MODELS, profile, 3);
  console.log(`\n■ ${c.name}`);
  const top = Object.entries(profile.weights).filter(([, w]) => w > 0.15).sort((a, b) => b[1] - a[1]).map(([k, w]) => `${k} ${w.toFixed(1)}`);
  console.log(`  needs: ${top.join(', ')}`);
  for (const p of picks) {
    console.log(`   → ${p.model.label.padEnd(34)} tier ${p.model.tier}  fit ${(p.fit.score * 100).toFixed(0)}  ${p.fit.confident ? 'CORROBORATED' : 'partial'}  [${p.fit.topAxes.join(', ')}]`);
  }
}
