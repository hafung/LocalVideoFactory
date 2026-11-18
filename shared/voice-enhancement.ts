import { z } from 'zod';

export const VoiceEnhancementSchema = z.enum(['off', 'natural', 'clear', 'warm']);
export type VoiceEnhancement = z.infer<typeof VoiceEnhancementSchema>;
