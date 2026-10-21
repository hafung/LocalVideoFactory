import { expect, it } from 'vitest';
import { mixArguments } from './mix.js';

it('plays original audio once, loops only BGM, and ducks each bed under narration', () => {
  const args = mixArguments('voice.wav', 'mixed.wav', 3500, {
    narrationVolume: .8,
    original: { path: 'source.mp4', volume: .35, ducking: true },
    bgm: { path: 'bgm.mp3', volume: .2, ducking: true }
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  expect(args.slice(6, 9)).toEqual(['-i', 'source.mp4', '-stream_loop']);
  expect(args.slice(args.indexOf('-stream_loop'), args.indexOf('-stream_loop') + 4)).toEqual(['-stream_loop', '-1', '-i', 'bgm.mp3']);
  expect(graph).toContain('asplit=3[voice][side0][side1]');
  expect(graph).toContain('[original][side0]sidechaincompress');
  expect(graph).toContain('[bgm][side1]sidechaincompress');
  expect(graph).toContain('volume=0.8');
  expect(graph).toContain('atrim=duration=3.5');
  expect(graph).toContain('loudnorm=I=-16');
  expect(graph).toContain('alimiter=limit=0.95:level=0');
});

it('supports voice-only and unducked mixes and validates each level', () => {
  expect(mixArguments('voice.wav', 'mixed.wav', 1000).join(' ')).not.toContain('amix');
  expect(mixArguments('voice.wav', 'mixed.wav', 1000, { bgm: { path: 'bgm.wav', volume: 0, ducking: false } }).join(' ')).not.toContain('sidechaincompress');
  expect(() => mixArguments('v', 'o', NaN)).toThrow();
  expect(() => mixArguments('v', 'o', 1000, { narrationVolume: 2.1 })).toThrow();
  expect(() => mixArguments('v', 'o', 1000, { original: { path: 'source.mp4', volume: -1, ducking: true } })).toThrow();
  expect(() => mixArguments('v', 'o', 1000, { bgm: { path: 'bgm.wav', volume: 2.1, ducking: true } })).toThrow();
});

it('trims original audio to selected source ranges and positions each on the narration timeline', () => {
  const original = { path: 'source.mp4', volume: .5, ducking: false, segments: [
    { startMs: 0, endMs: 2000, sourceInMs: 1000, sourceOutMs: 3000 },
    { startMs: 4000, endMs: 6000, sourceInMs: 10000, sourceOutMs: 12000 }
  ] };
  const args = mixArguments('voice.wav', 'mixed.wav', 8000, { original });
  const graph = args[args.indexOf('-filter_complex') + 1];
  expect(graph).toContain('atrim=start=1:end=3');
  expect(graph).toContain('atrim=start=10:end=12');
  expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=2[originalGap1]');
  expect(graph).toContain('concat=n=3:v=0:a=1');
  expect(() => mixArguments('v', 'm', 8000, { original: { ...original, segments: [{ ...original.segments[0], sourceOutMs: 4000 }] } })).toThrow('区间');
});


it('changes the duration of the entire mix without changing pitch, including slow and fast extremes', () => {
  for (const rate of [.25, .5, 1.5, 2, 4]) {
    const args = mixArguments('voice.wav', 'mixed.wav', 8000, { playbackRate: rate });
    expect(Number(args[args.indexOf('-t') + 1])).toBe(8 / rate);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('atempo=');
    expect(graph).not.toContain('asetrate');
  }
  expect(() => mixArguments('voice.wav', 'mixed.wav', 8000, { playbackRate: NaN })).toThrow();
});
