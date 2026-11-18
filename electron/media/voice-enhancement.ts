import type { VoiceEnhancement } from '../../shared/voice-enhancement.js';

const filters: Record<VoiceEnhancement, readonly string[]> = {
  off: [],
  natural: [
    'highpass=f=65',
    'deesser=i=0.2:m=0.35',
    'acompressor=threshold=0.16:ratio=1.4:attack=18:release=130'
  ],
  clear: [
    'highpass=f=85',
    'equalizer=f=260:t=q:w=0.9:g=-2',
    'equalizer=f=3100:t=q:w=0.8:g=1.8',
    'deesser=i=0.25:m=0.4',
    'acompressor=threshold=0.14:ratio=1.6:attack=12:release=110'
  ],
  warm: [
    'highpass=f=60',
    'equalizer=f=180:t=q:w=0.8:g=1.8',
    'equalizer=f=4200:t=q:w=0.8:g=-1.2',
    'deesser=i=0.18:m=0.35',
    'acompressor=threshold=0.14:ratio=1.6:attack=20:release=150'
  ]
};

export function voiceEnhancementFilters(preset: VoiceEnhancement): readonly string[] {
  return preset === 'off' ? filters.off : ['aformat=sample_fmts=fltp', ...filters[preset]];
}
