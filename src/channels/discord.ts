import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN, VOICE_ENABLED } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { generateSpeech } from '../tts.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { DiscordVoiceHandler } from './discord-voice.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private voiceHandler: DiscordVoiceHandler | null = null;
  // Map guildId → text channelId where /join was issued (for routing responses)
  private voiceTextChannels = new Map<string, string>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map((att) => {
          const contentType = att.contentType || '';
          if (contentType.startsWith('image/')) {
            return `[Image: ${att.name || 'image'}]`;
          } else if (contentType.startsWith('video/')) {
            return `[Video: ${att.name || 'video'}]`;
          } else if (contentType.startsWith('audio/')) {
            return `[Audio: ${att.name || 'audio'}]`;
          } else {
            return `[File: ${att.name || 'file'}]`;
          }
        });
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Voice handler setup (when VOICE_ENABLED)
    if (VOICE_ENABLED) {
      this.voiceHandler = new DiscordVoiceHandler((userId, guildId, text) => {
        // Route transcribed speech as a regular message through the pipeline
        const textChannelId = this.voiceTextChannels.get(guildId);
        if (!textChannelId) return;

        const chatJid = `dc:${textChannelId}`;
        const timestamp = new Date().toISOString();

        // Prepend trigger so the agent picks it up
        const content = `@${ASSISTANT_NAME} ${text}`;

        // Store chat metadata
        this.opts.onChatMetadata(chatJid, timestamp);

        const group = this.opts.registeredGroups()[chatJid];
        if (!group) return;

        // Resolve display name from guild member cache
        const guild = this.client?.guilds.cache.get(guildId);
        const member = guild?.members.cache.get(userId);
        const senderName = member?.displayName || `User:${userId}`;

        this.opts.onMessage(chatJid, {
          id: `voice-${Date.now()}-${userId}`,
          chat_jid: chatJid,
          sender: userId,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info({ userId, guildId, senderName, text: text.slice(0, 100) }, 'Voice message routed');
      });

      // Handle /join and /leave slash commands
      this.client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'join') {
          await this.handleJoinCommand(interaction);
        } else if (interaction.commandName === 'leave') {
          await this.handleLeaveCommand(interaction);
        }
      });

      logger.info('Discord voice support enabled');
    }

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );

        // Register slash commands if voice is enabled
        if (VOICE_ENABLED) {
          await this.registerSlashCommands(readyClient.user.id);
        }

        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.voiceHandler) {
      this.voiceHandler.disconnectAll();
      this.voiceHandler = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  /**
   * Speak text in the voice channel for a given guild (if connected).
   */
  async speakInVoice(guildId: string, text: string): Promise<void> {
    if (!this.voiceHandler?.isInChannel(guildId)) return;
    try {
      const mp3 = await generateSpeech(text);
      await this.voiceHandler.playAudio(guildId, mp3);
      logger.debug({ guildId, textLength: text.length }, 'Voice TTS played');
    } catch (err) {
      logger.error({ err, guildId }, 'Failed to play TTS in voice channel');
    }
  }

  isVoiceActive(guildId: string): boolean {
    return this.voiceHandler?.isInChannel(guildId) ?? false;
  }

  getVoiceGuildForJid(jid: string): string | null {
    const channelId = jid.replace(/^dc:/, '');
    for (const [guildId, textChannelId] of this.voiceTextChannels) {
      if (textChannelId === channelId && this.voiceHandler?.isInChannel(guildId)) {
        return guildId;
      }
    }
    return null;
  }

  private async handleJoinCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.voiceHandler) {
      await interaction.reply({ content: 'Voice is not enabled.', ephemeral: true });
      return;
    }

    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const voiceChannel = member?.voice.channel;

    if (!voiceChannel) {
      await interaction.reply({ content: 'You need to be in a voice channel first.', ephemeral: true });
      return;
    }

    if (!interaction.guild) {
      await interaction.reply({ content: 'This command only works in servers.', ephemeral: true });
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      await this.voiceHandler.joinChannel(
        interaction.guild.id,
        voiceChannel.id,
        interaction.guild.voiceAdapterCreator,
      );
      this.voiceTextChannels.set(interaction.guild.id, interaction.channelId);
      await interaction.editReply(`Joined **${voiceChannel.name}**. Listening for speech.`);
      logger.info({ guild: interaction.guild.name, channel: voiceChannel.name }, 'Voice /join');
    } catch (err) {
      logger.error({ err }, 'Failed to join voice channel');
      await interaction.editReply('Failed to join voice channel.').catch(() => {});
    }
  }

  private async handleLeaveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.voiceHandler || !interaction.guild) {
      await interaction.reply({ content: 'Not in a voice channel.', ephemeral: true });
      return;
    }

    this.voiceHandler.leaveChannel(interaction.guild.id);
    this.voiceTextChannels.delete(interaction.guild.id);
    await interaction.reply({ content: 'Left voice channel.', ephemeral: true });
    logger.info({ guild: interaction.guild.name }, 'Voice /leave');
  }

  private async registerSlashCommands(botUserId: string): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join your current voice channel and start listening'),
      new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Leave the voice channel'),
    ];

    try {
      const rest = new REST({ version: '10' }).setToken(this.botToken);
      await rest.put(Routes.applicationCommands(botUserId), {
        body: commands.map((c) => c.toJSON()),
      });
      logger.info('Registered /join and /leave slash commands');
    } catch (err) {
      logger.error({ err }, 'Failed to register slash commands');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
