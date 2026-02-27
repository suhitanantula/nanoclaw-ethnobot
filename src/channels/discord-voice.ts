import { spawn } from 'child_process';
import { Readable } from 'stream';

import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  getVoiceConnection,
} from '@discordjs/voice';
import type {
  AudioPlayer,
  VoiceConnection,
  DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import { createClient } from '@deepgram/sdk';
import type { DeepgramClient } from '@deepgram/sdk';
import prism from 'prism-media';

import { DEEPGRAM_API_KEY, WHISPER_MODEL } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';

const SILENCE_DURATION_MS = 800;
const AUTO_LEAVE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM

export interface VoiceTranscriptionCallback {
  (userId: string, guildId: string, text: string): void;
}

interface GuildVoiceState {
  connection: VoiceConnection;
  player: AudioPlayer;
  idleTimer: ReturnType<typeof setTimeout> | null;
  activeUsers: Set<string>;
}

export class DiscordVoiceHandler {
  private guilds = new Map<string, GuildVoiceState>();
  private deepgram: DeepgramClient | null = null;
  private onTranscription: VoiceTranscriptionCallback;

  constructor(onTranscription: VoiceTranscriptionCallback) {
    this.onTranscription = onTranscription;
    if (DEEPGRAM_API_KEY) {
      this.deepgram = createClient(DEEPGRAM_API_KEY);
    }
  }

  async joinChannel(
    guildId: string,
    channelId: string,
    adapterCreator: DiscordGatewayAdapterCreator,
  ): Promise<void> {
    // Leave existing connection in this guild if any
    if (this.guilds.has(guildId)) {
      this.leaveChannel(guildId);
    }

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    connection.subscribe(player);

    const state: GuildVoiceState = {
      connection,
      player,
      idleTimer: null,
      activeUsers: new Set(),
    };
    this.guilds.set(guildId, state);

    // Wait for connection to be ready
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      this.guilds.delete(guildId);
      throw new Error('Voice connection timed out');
    }

    // Handle disconnection
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Try to reconnect
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // Could not reconnect — clean up
        this.leaveChannel(guildId);
      }
    });

    // Set up audio receiver
    this.setupAudioReceiver(guildId, state);

    // Start idle timer
    this.resetIdleTimer(guildId);

    logger.info({ guildId, channelId }, 'Joined voice channel');
  }

  leaveChannel(guildId: string): void {
    const state = this.guilds.get(guildId);
    if (!state) return;

    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.player.stop();
    state.connection.destroy();
    this.guilds.delete(guildId);

    logger.info({ guildId }, 'Left voice channel');
  }

  isInChannel(guildId: string): boolean {
    return this.guilds.has(guildId);
  }

  private resetIdleTimer(guildId: string): void {
    const state = this.guilds.get(guildId);
    if (!state) return;

    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      logger.info({ guildId }, 'Voice idle timeout, leaving channel');
      this.leaveChannel(guildId);
    }, AUTO_LEAVE_TIMEOUT_MS);
  }

  private setupAudioReceiver(guildId: string, state: GuildVoiceState): void {
    const receiver = state.connection.receiver;

    receiver.speaking.on('start', (userId: string) => {
      if (state.activeUsers.has(userId)) return;
      state.activeUsers.add(userId);

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_DURATION_MS },
      });

      // Decode Opus → PCM
      const decoder = new prism.opus.Decoder({
        rate: SAMPLE_RATE,
        channels: CHANNELS,
        frameSize: 960,
      });

      const pcmChunks: Buffer[] = [];

      opusStream.pipe(decoder);

      decoder.on('data', (chunk: Buffer) => {
        pcmChunks.push(chunk);
      });

      decoder.on('end', () => {
        state.activeUsers.delete(userId);

        if (pcmChunks.length === 0) return;

        const pcmBuffer = Buffer.concat(pcmChunks);

        // Skip very short segments (< 0.5s of audio)
        const durationSecs = pcmBuffer.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
        if (durationSecs < 0.5) {
          logger.debug({ userId, durationSecs }, 'Skipping short audio segment');
          return;
        }

        this.resetIdleTimer(guildId);

        // Transcribe
        this.transcribePcm(pcmBuffer)
          .then((text) => {
            if (text && text.trim()) {
              logger.info({ userId, text: text.slice(0, 100) }, 'Voice transcription');
              this.onTranscription(userId, guildId, text.trim());
            }
          })
          .catch((err) => {
            logger.error({ err, userId }, 'Transcription failed');
          });
      });

      decoder.on('error', (err: Error) => {
        state.activeUsers.delete(userId);
        logger.debug({ err: err.message, userId }, 'Opus decode error');
      });

      opusStream.on('error', (err: Error) => {
        state.activeUsers.delete(userId);
        logger.debug({ err: err.message, userId }, 'Opus stream error');
      });
    });
  }

  private async transcribePcm(pcmBuffer: Buffer): Promise<string | null> {
    const wavBuffer = pcmToWav(pcmBuffer, SAMPLE_RATE, CHANNELS);

    // Use Deepgram if available, fallback to local Whisper
    if (this.deepgram) {
      return this.transcribeWithDeepgram(wavBuffer);
    }
    return this.transcribeWithWhisper(wavBuffer);
  }

  private async transcribeWithDeepgram(wavBuffer: Buffer): Promise<string | null> {
    if (!this.deepgram) return null;

    try {
      const { result } = await this.deepgram.listen.prerecorded.transcribeFile(
        wavBuffer,
        {
          model: 'nova-2',
          smart_format: true,
          mimetype: 'audio/wav',
        },
      );

      const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      return transcript || null;
    } catch (err) {
      logger.error({ err }, 'Deepgram transcription failed, falling back to Whisper');
      return this.transcribeWithWhisper(wavBuffer);
    }
  }

  private async transcribeWithWhisper(wavBuffer: Buffer): Promise<string | null> {
    // Write WAV to temp file, run local Whisper
    const { writeFile, rm } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const path = await import('path');

    const tempPath = path.join(tmpdir(), `voice-${Date.now()}.wav`);
    try {
      await writeFile(tempPath, wavBuffer);
      return await transcribeAudio(tempPath, WHISPER_MODEL);
    } finally {
      rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async playAudio(guildId: string, mp3Buffer: Buffer): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) return;

    // Convert MP3 → Opus via ffmpeg for Discord playback
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const readable = new Readable({
      read() {
        this.push(mp3Buffer);
        this.push(null);
      },
    });
    readable.pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
    });

    state.player.play(resource);

    // Wait for playback to finish
    return new Promise<void>((resolve) => {
      const onIdle = () => {
        if (state.player.state.status === AudioPlayerStatus.Idle) {
          state.player.off(AudioPlayerStatus.Idle, onIdle);
          resolve();
        }
      };
      state.player.on(AudioPlayerStatus.Idle, onIdle);

      // Safety timeout — don't wait forever
      setTimeout(() => {
        state.player.off(AudioPlayerStatus.Idle, onIdle);
        resolve();
      }, 60_000);
    });
  }

  disconnectAll(): void {
    for (const guildId of this.guilds.keys()) {
      this.leaveChannel(guildId);
    }
  }
}

/**
 * Convert raw PCM buffer to WAV format with proper header.
 */
function pcmToWav(pcm: Buffer, sampleRate: number, numChannels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataSize + headerSize - 8, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // subchunk1 size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
