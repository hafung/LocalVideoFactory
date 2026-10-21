import type { Scene } from '../../shared/edit-plan.js';
import type { SourceRange } from './source-edits.js';
import type { SourceContentPlan, SourceCandidate, SourceMatch } from './source-content.js';

const intersects = (a: SourceRange, b: SourceRange) => a.startMs < b.endMs && b.startMs < a.endMs;
const inside = (time: number, range: SourceRange) => time > range.startMs && time < range.endMs;

/** Find a real-time cut that fits without entering or leaving a known utterance/action halfway. */
export function safeSourceSlice(candidate: SourceCandidate, durationMs: number, used: SourceRange[], protectedRanges: SourceRange[]): SourceRange | undefined {
  let free: SourceRange[] = [{ startMs: candidate.startMs, endMs: candidate.endMs }];
  for (const occupied of used) free = free.flatMap(range => !intersects(range, occupied) ? [range] : [
    { startMs: range.startMs, endMs: Math.min(range.endMs, occupied.startMs) },
    { startMs: Math.max(range.startMs, occupied.endMs), endMs: range.endMs }
  ].filter(piece => piece.endMs > piece.startMs));
  const barriers = protectedRanges.filter(range => intersects(range, candidate));
  const choices: Array<SourceRange & { score: number }> = [];
  for (const range of free) {
    const anchors = new Set([range.startMs, Math.max(range.startMs, range.endMs - durationMs),
      ...barriers.flatMap(item => [item.startMs, item.endMs, item.endMs - durationMs])]);
    for (const anchor of anchors) {
      const startMs = Math.round(anchor);
      if (startMs < range.startMs || startMs >= range.endMs || barriers.some(item => inside(startMs, item))) continue;
      let endMs = Math.min(range.endMs, startMs + durationMs);
      // Retreat to a safe boundary. Repeat because padded utterances can overlap.
      for (let attempt = 0; attempt <= barriers.length; attempt++) {
        const crossing = barriers.find(item => inside(endMs, item));
        if (!crossing) break;
        endMs = crossing.startMs;
      }
      if (endMs <= startMs || endMs - startMs < Math.min(600, durationMs) || barriers.some(item => inside(endMs, item))) continue;
      const completeActions = candidate.actions.filter(action => action.startMs >= startMs && action.endMs <= endMs).length;
      choices.push({ startMs, endMs, score: endMs - startMs + completeActions * 250 });
    }
  }
  const best = choices.sort((a, b) => b.score - a.score || a.startMs - b.startMs)[0];
  return best ? { startMs: best.startMs, endMs: best.endMs } : undefined;
}

/** Matching uses verified candidate IDs. The model never controls source timestamps or timeline duration. */
export function arrangeContentScenes(slots: Scene[], content: SourceContentPlan, preserveSpeech: boolean): Scene[] {
  const groups: Scene[][] = [];
  for (const slot of slots) {
    const previous = groups.at(-1);
    if (previous && (previous[0].originSceneId ?? previous[0].id) === (slot.originSceneId ?? slot.id) && previous.at(-1)!.endMs === slot.startMs) previous.push(slot);
    else groups.push([slot]);
  }
  const candidates = new Map(content.index.candidates.map(candidate => [candidate.id, candidate]));
  const used: SourceRange[] = []; const uses = new Map<string, number>();
  const scenes: Scene[] = []; let lastSourceEnd = 0;
  for (const group of groups) {
    const slot = group[0]; const endMs = group.at(-1)!.endMs;
    const origin = slot.originSceneId ?? slot.id;
    const matches = content.matches[origin] ?? [];
    let cursor = slot.startMs; let piece = 0;
    while (cursor < endMs && (!preserveSpeech || content.index.speechReliable)) {
      let best: { candidate: SourceCandidate; match: SourceMatch; range: SourceRange; score: number } | undefined;
      for (const match of matches) {
        const candidate = candidates.get(match.candidateId);
        if (!candidate || match.relevance < .62 || candidate.quality < .25) continue;
        // A window that never shows an action's beginning/completion is not a verified complete take.
        if (candidate.incompleteActions.some(action => intersects(candidate, action))) continue;
        const range = safeSourceSlice(candidate, endMs - cursor, used,
          [...content.index.candidates.flatMap(item => item.actions), ...content.index.speech]);
        if (!range) continue;
        const score = match.relevance * .75 + candidate.quality * .15 +
          Math.min(1, (range.endMs - range.startMs) / (endMs - cursor)) * .1 -
          (uses.get(candidate.id) ?? 0) * .12 + (range.startMs >= lastSourceEnd ? .025 : 0);
        if (!best || score > best.score) best = { candidate, match, range, score };
      }
      if (!best) break;
      const { candidate, match, range } = best; const length = range.endMs - range.startMs;
      scenes.push({ ...slot, id: `${origin}-content-${++piece}`, originSceneId: origin, startMs: cursor, endMs: cursor + length,
        visual: { ...slot.visual, type: 'source', assetId: 'source-video', sourceInMs: range.startMs, sourceOutMs: range.endMs,
          motion: 'none', sourceMatch: { candidateId: candidate.id, relevance: match.relevance, reason: match.reason,
            evidence: candidate.vision ? 'vision' : 'transcript' },
          intent: { ...slot.visual.intent, minDurationMs: length } } });
      cursor += length; used.push(range); lastSourceEnd = range.endMs; uses.set(candidate.id, (uses.get(candidate.id) ?? 0) + 1);
    }
    // Unmatched time goes through the existing local/Pexels video-first pipeline.
    while (cursor < endMs) {
      const length = Math.min(5000, endMs - cursor);
      scenes.push({ ...slot, id: `${origin}-supplement-${++piece}`, originSceneId: origin, startMs: cursor, endMs: cursor + length,
        visual: { ...slot.visual, type: 'kinetic-text', assetId: undefined, sourceInMs: undefined, sourceOutMs: undefined,
          sourceMatch: undefined, intent: { ...slot.visual.intent, minDurationMs: length } } });
      cursor += length;
    }
  }
  return scenes;
}
