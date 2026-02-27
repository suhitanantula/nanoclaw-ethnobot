import { execFile } from 'child_process';
import { mkdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { logger } from './logger.js';

const WHISPER_BIN = '/opt/homebrew/bin/whisper';
const TIMEOUT_MS = 120_000;

/**
 * Transcribe an audio file using local Whisper CLI.
 * Returns the transcript text, or null on failure.
 */
export async function transcribeAudio(
  filePath: string,
  model?: string,
): Promise<string | null> {
  const whisperModel = model || process.env.WHISPER_MODEL || 'base';
  const outDir = path.join(tmpdir(), `whisper-${Date.now()}`);

  try {
    await mkdir(outDir, { recursive: true });

    const transcript = await new Promise<string>((resolve, reject) => {
      execFile(
        WHISPER_BIN,
        [
          filePath,
          '--model', whisperModel,
          '--language', 'en',
          '--output_format', 'txt',
          '--output_dir', outDir,
        ],
        { timeout: TIMEOUT_MS },
        (err) => {
          if (err) return reject(err);

          // Whisper writes <basename>.txt in outDir
          const baseName = path.basename(filePath, path.extname(filePath));
          const txtPath = path.join(outDir, `${baseName}.txt`);

          readFile(txtPath, 'utf-8')
            .then((text) => resolve(text.trim()))
            .catch(reject);
        },
      );
    });

    return transcript || null;
  } catch (err) {
    logger.error({ err, filePath }, 'Whisper transcription failed');
    return null;
  } finally {
    // Cleanup temp dir
    rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
