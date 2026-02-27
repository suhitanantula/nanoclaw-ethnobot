import OpenAI from 'openai';

import { OPENAI_API_KEY, VOICE_TTS_VOICE } from './config.js';
import { logger } from './logger.js';

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for TTS');
    }
    openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * Generate speech audio from text using OpenAI TTS API.
 * Returns an MP3 buffer.
 */
export async function generateSpeech(
  text: string,
  voice?: string,
): Promise<Buffer> {
  const client = getClient();
  const ttsVoice = (voice || VOICE_TTS_VOICE) as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

  logger.debug({ textLength: text.length, voice: ttsVoice }, 'Generating TTS');

  const response = await client.audio.speech.create({
    model: 'tts-1',
    voice: ttsVoice,
    input: text,
    response_format: 'mp3',
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
