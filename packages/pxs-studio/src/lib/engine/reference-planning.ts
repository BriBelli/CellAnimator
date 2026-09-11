/**
 * REFERENCE PLANNING — mapping what the user attached onto what the model actually accepts.
 *
 * The problem this ends: a user attaches "these 3 style refs and my character" and the system either
 * (a) benches the model, (b) silently drops images, or (c) pushes them into whatever channel exists
 * and the model quietly ignores half of them. All three are how references "mysteriously don't work".
 *
 * The rule (Brian's graceful specialist): NEVER dead-end. Send each model up to its real per-slot
 * maximum, fill the closest compatible channel when an exact-role slot doesn't exist, honor
 * provider-enforced exclusivity, and REPORT every compromise in plain language so the shortfall is
 * visible up front — never discovered after the render is paid for.
 *
 * Pure + deterministic → unit-tested, safe on any path.
 */

import type { ImageModel, InputSlot, SlotRole } from './model-registry';

/** One reference the user attached, with the role they intend it to play. */
export interface AttachedReference {
  url: string;
  /** What the user means it to do. 'general' when unspecified. */
  role?: SlotRole;
}

/** One reference, assigned to a real slot on the target model. */
export interface PlannedReference {
  url: string;
  requestedRole: SlotRole;
  /** The provider param it will actually be sent as. */
  param: string;
  /** The slot's role — differs from `requestedRole` when we fell back to a compatible channel. */
  slotRole: SlotRole;
  slotLabel: string;
}

export interface ReferencePlan {
  modelId: string;
  planned: PlannedReference[];
  /** References that could NOT be placed (no capacity / no compatible channel). */
  dropped: { url: string; role: SlotRole; reason: string }[];
  /** Plain-language notes about every compromise — surfaced to the user BEFORE spending. */
  notices: string[];
  /** Total images this model can take across all non-mask slots. */
  capacity: number;
}

/** Fallback order per requested role: try the exact role, then the closest honest channels. */
const FALLBACK: Record<SlotRole, SlotRole[]> = {
  character: ['character', 'subject', 'object', 'general'],
  style: ['style', 'general'],
  object: ['object', 'general', 'subject'],
  subject: ['subject', 'general', 'object'],
  sketch: ['sketch', 'subject', 'general'],
  general: ['general', 'object', 'subject'],
  mask: ['mask'],
};

/** Slots that carry picture CONTENT (masks are control data, not reference imagery). */
const contentSlots = (model: ImageModel): InputSlot[] => (model.inputSlots ?? []).filter((s) => s.role !== 'mask');

/**
 * The model's real reference capacity. `inputSlots` (structural truth) wins; then the legacy
 * Gemini-shaped `referenceLimits`; then the flat `maxReferenceImages`. Slots with an unpublished
 * `max` count as 1 — the honest floor for "documented but the count isn't published".
 */
export function referenceCapacity(model: ImageModel): number {
  const slots = contentSlots(model);
  if (slots.length > 0) {
    // A per-role model can still cap the TOTAL below the sum of its slots (Gemini: 10+5+3 but 14 max).
    const slotSum = slots.reduce((n, s) => n + (s.max ?? 1), 0);
    return model.maxReferenceImages > 0 ? Math.min(slotSum, model.maxReferenceImages) : slotSum;
  }
  const rl = model.referenceLimits;
  if (rl) return rl.object + rl.character + rl.style;
  return model.maxReferenceImages;
}

/** Does this model offer a real channel for this role (exactly, or by fallback)? */
export function acceptsRole(model: ImageModel, role: SlotRole): boolean {
  const slots = model.inputSlots ?? [];
  if (slots.length === 0) return role !== 'mask' && referenceCapacity(model) > 0;
  return FALLBACK[role].some((r) => slots.some((s) => s.role === r && (s.max ?? 1) > 0));
}

/**
 * Plan the attached references onto the model's real slots. Deterministic: exact-role slots fill
 * first (so a character ref never displaces a style ref), then fallbacks, honoring per-slot caps,
 * the model's total cap, and provider exclusivity.
 */
export function planReferences(model: ImageModel, refs: AttachedReference[]): ReferencePlan {
  const plan: ReferencePlan = { modelId: model.id, planned: [], dropped: [], notices: [], capacity: referenceCapacity(model) };
  if (refs.length === 0) return plan;

  const slots = contentSlots(model);

  // No declared slots → the flat pool (legacy/unresearched models). Clamp and say so.
  if (slots.length === 0) {
    const cap = plan.capacity;
    refs.slice(0, cap).forEach((r) =>
      plan.planned.push({ url: r.url, requestedRole: r.role ?? 'general', param: 'reference', slotRole: 'general', slotLabel: 'Reference images' }),
    );
    refs.slice(cap).forEach((r) => plan.dropped.push({ url: r.url, role: r.role ?? 'general', reason: cap === 0 ? 'this model takes no reference images' : `only ${cap} reference${cap === 1 ? '' : 's'} fit` }));
    if (plan.dropped.length > 0) {
      plan.notices.push(
        cap === 0
          ? `${model.label} doesn't accept reference images — the prompt has to carry the whole brief.`
          : `${model.label} takes ${cap} reference${cap === 1 ? '' : 's'}; sending the first ${cap} of ${refs.length}.`,
      );
    }
    return plan;
  }

  const used = new Map<InputSlot, number>();
  const remaining = (s: InputSlot) => (s.max ?? 1) - (used.get(s) ?? 0);
  const blocked = new Set<string>(); // params disabled by an exclusivity rule already triggered

  // Exact-role first across ALL refs, then fallbacks — so specific intent always wins a real slot.
  const order: AttachedReference[] = [...refs];
  const place = (ref: AttachedReference, roles: SlotRole[]): boolean => {
    for (const role of roles) {
      const slot = slots.find((s) => s.role === role && remaining(s) > 0 && !blocked.has(s.param));
      if (!slot) continue;
      if (plan.planned.length >= plan.capacity) return false;
      used.set(slot, (used.get(slot) ?? 0) + 1);
      for (const c of slot.conflictsWith ?? []) blocked.add(c);
      plan.planned.push({
        url: ref.url,
        requestedRole: ref.role ?? 'general',
        param: slot.param,
        slotRole: slot.role,
        slotLabel: slot.label,
      });
      if (slot.role !== (ref.role ?? 'general') && (ref.role ?? 'general') !== 'general') {
        plan.notices.push(`${model.label} has no dedicated ${ref.role} channel — sending it as "${slot.label}".`);
      }
      return true;
    }
    return false;
  };

  const unplaced: AttachedReference[] = [];
  for (const ref of order) {
    const role = ref.role ?? 'general';
    if (!place(ref, [role])) unplaced.push(ref);
  }
  for (const ref of unplaced) {
    const role = ref.role ?? 'general';
    if (!place(ref, FALLBACK[role].slice(1))) {
      const exact = slots.find((s) => s.role === role);
      plan.dropped.push({
        url: ref.url,
        role,
        reason: exact
          ? `${model.label} accepts ${exact.max ?? 1} ${exact.label.toLowerCase()} — that slot is full`
          : `${model.label} has no channel for a ${role} reference`,
      });
    }
  }

  if (plan.dropped.length > 0) {
    const byReason = new Map<string, number>();
    for (const d of plan.dropped) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) plan.notices.push(`${n} reference${n === 1 ? '' : 's'} not sent — ${reason}.`);
  }
  // Usage facts that decide whether references actually WORK (index-addressing, first-image masks…).
  for (const slot of slots) {
    if ((used.get(slot) ?? 0) > 0 && slot.notes) plan.notices.push(`${slot.label}: ${slot.notes}`);
  }
  return plan;
}

/** A compact human summary of a model's input channels — for the Guide and the picker. */
export function describeSlots(model: ImageModel): string {
  const slots = model.inputSlots ?? [];
  if (slots.length === 0) {
    const cap = referenceCapacity(model);
    return cap > 0 ? `Up to ${cap} reference image${cap === 1 ? '' : 's'} (single pool)` : 'No reference images';
  }
  return slots
    .map((s) => `${s.label}: ${s.max ?? '?'}${s.conflictsWith?.length ? ` (excludes ${s.conflictsWith.join(', ')})` : ''}`)
    .join(' · ');
}
