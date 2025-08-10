require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  demuxProbe
} = require('@discordjs/voice');

const ytdl = require('@distube/ytdl-core');
const fetch = require('node-fetch');

// --- Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.GuildMember]
});

// --- Moderation guard (role-only) ---
function isModerator(interaction) {
  const modRoleId = process.env.MOD_ROLE_ID;
  if (!modRoleId) return true; // když není nastaveno, povol všem
  if (interaction.memberPermissions?.has('Administrator')) return true;
  const member = interaction.member;
  return member?.roles?.cache?.has(modRoleId);
}

// --- Slash commands ---
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Pong with latency'),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Make the bot say something')
    .addStringOption(opt => opt.setName('text').setDescription('What should I say?').setRequired(true)),

  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete N recent messages (2–100)')
    .addIntegerOption(opt => opt.setName('count').setDescription('How many? (2–100)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder().setName('help').setDescription('Zobrazí dostupné příkazy'),

  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Pustí audio z YouTube URL ve tvém hlasovém kanálu')
    .addStringOption(o => o.setName('url').setDescription('YouTube URL').setRequired(true)),

  new SlashCommandBuilder().setName('stop').setDescription('Zastaví přehrávání a odpojí bota z hlasového kanálu'),

  new SlashCommandBuilder().setName('announce-test').setDescription('Pošle testovací oznámení do ANNOUNCE_CHANNEL_ID')
].map(c => c.toJSON());

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  const { CLIENT_ID, GUILD_ID } = process.env;
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`[Commands] Registered to guild ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('[Commands] Registered globally');
    }
  } catch (err) {
    console.error('[Commands] Registration failed:', err);
  }
}

// --- Audio player ---
const player = createAudioPlayer();
player.on('error', e => console.error('Audio error:', e));
player.on(AudioPlayerStatus.Idle, () => {});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  await registerSlashCommands();
  startYouTubeWatcher(c);
  startKickWatcher(c);
});

// --- Interactions ---
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName !== 'ping' && !isModerator(interaction)) {
    return interaction.reply({ content: '❌ Tento příkaz je jen pro moderátory.', ephemeral: true });
  }

  try {
    switch (interaction.commandName) {
      case 'ping': {
        const sent = await interaction.reply({ content: 'Pinging…', fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply(`🏓 Pong! **${latency}ms**`);
        break;
      }

      case 'say': {
        const text = interaction.options.getString('text', true);
        await interaction.reply({ content: '✅ Sent!', ephemeral: true });
        await interaction.channel.send(text);
        break;
      }

      case 'purge': {
        const count = interaction.options.getInteger('count', true);
        if (count < 2 || count > 100) {
          await interaction.reply({ content: 'Please choose between 2 and 100.', ephemeral: true });
          break;
        }
        const me = await interaction.guild.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ManageMessages)) {
          await interaction.reply({ content: "I don't have **Manage Messages**.", ephemeral: true });
          break;
        }
        const deleted = await interaction.channel.bulkDelete(count, true);
        await interaction.reply({ content: `🧹 Deleted **${deleted.size}** messages.`, ephemeral: true });
        break;
      }

      case 'help': {
        const lines = [
          '`/ping` – latency',
          '`/say text:` – pošli zprávu',
          '`/purge count:` – smaž N zpráv',
          '`/play url:` – pusť YouTube audio',
          '`/stop` – zastav a odpoj',
          '`/announce-test` – test oznámení'
        ];
        await interaction.reply({
          content: `Dostupné příkazy:\n${lines.join('\n')}`,
          ephemeral: true
        });
        break;
      }

      case 'play': {
        const url = interaction.options.getString('url', true);
        if (!ytdl.validateURL(url)) {
          await interaction.reply({ content: 'Dej prosím platné **YouTube URL**.', ephemeral: true });
          break;
        }
        const voice = interaction.member?.voice?.channel;
        if (!voice) {
          await interaction.reply({ content: 'Připoj se nejdřív do **hlasového kanálu**.', ephemeral: true });
          break;
        }

        await interaction.reply({ content: '🎵 Připravuju přehrávání…', ephemeral: true });

        const conn = joinVoiceChannel({
          channelId: voice.id,
          guildId: voice.guild.id,
          adapterCreator: voice.guild.voiceAdapterCreator
        });

        const stream = ytdl(url, { filter: 'audioonly', highWaterMark: 1 << 25, dlChunkSize: 0 });
        const { stream: probed, type } = await demuxProbe(stream);
        const resource = createAudioResource(probed, { inputType: type });
        conn.subscribe(player);
        player.play(resource);

        await interaction.followUp({ content: '▶️ Hraju: ' + url, ephemeral: true });
        break;
      }

      case 'stop': {
        player.stop();
        const conn = getVoiceConnection(interaction.guild.id);
        conn?.destroy();
        await interaction.reply({ content: '⏹️ Zastaveno a odpojeno.', ephemeral: true });
        break;
      }

      case 'announce-test': {
        const chId = process.env.ANNOUNCE_CHANNEL_ID;
        const ch = chId && (interaction.guild.channels.cache.get(chId) || await interaction.guild.channels.fetch(chId).catch(() => null));
        if (!ch || !ch.isTextBased()) {
          await interaction.reply({ content: 'ANNOUNCE_CHANNEL_ID není nastaven nebo kanál neexistuje.', ephemeral: true });
          break;
        }
        await ch.send('🔔 Test oznámení – bot funguje.');
        await interaction.reply({ content: '✅ Posláno.', ephemeral: true });
        break;
      }

      default: {
        await interaction.reply({ content: 'Neznámý příkaz.', ephemeral: true });
      }
    }
  } catch (err) {
    console.error('Command error:', err);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
    }
  }
});


// --- Welcome messages ---
client.on(Events.GuildMemberAdd, async (member) => {
  const channelId = process.env.WELCOME_CHANNEL_ID;
  if (!channelId) return; // feature disabled
  const channel = member.guild.channels.cache.get(channelId) || await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  channel.send(`👋 Vítej na serveru, ${member}!`);
});

// --- Lightweight HTTP keep‑alive server (for free hosters) ---
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('bot up');
});
server.listen(PORT, () => console.log(`🌐 HTTP keep-alive on :${PORT}`));

// --- Watchers: YouTube & Kick ---
let lastVideoId = null;
async function startYouTubeWatcher(client) {
  const channelId = process.env.YOUTUBE_CHANNEL_ID;
  const announceId = process.env.ANNOUNCE_CHANNEL_ID;
  if (!channelId || !announceId) return;
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  const check = async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const xml = await res.text();
      const match = xml.match(/<yt:videoId>(.*?)<\/yt:videoId>/);
      if (!match) return;
      const videoId = match[1];
      if (lastVideoId && videoId !== lastVideoId) {
        const ch = await client.channels.fetch(announceId).catch(()=>null);
        if (ch?.isTextBased()) await ch.send(`📺 **Nové video!** https://youtu.be/${videoId}`);
      }
      lastVideoId = videoId;
    } catch (e) { /* ignore */ }
  };
  check();
  setInterval(check, 5 * 60 * 1000);
}

let lastKickLive = false;
async function startKickWatcher(client) {
  const username = process.env.KICK_USERNAME;
  const announceId = process.env.ANNOUNCE_CHANNEL_ID;
  if (!username || !announceId) return;
  const api = `https://kick.com/api/v2/channels/${username}`; // může se časem měnit

  const check = async () => {
    try {
      const res = await fetch(api);
      if (!res.ok) return;
      const data = await res.json();
      const isLive = Boolean(data?.livestream);
      if (isLive && !lastKickLive) {
        const ch = await client.channels.fetch(announceId).catch(()=>null);
        if (ch?.isTextBased()) await ch.send(`🟢 **Live na Kicku!** https://kick.com/${username}`);
      }
      lastKickLive = isLive;
    } catch (e) { /* ignore */ }
  };
  check();
  setInterval(check, 3 * 60 * 1000);
}

// --- Start ---
client.login(process.env.TOKEN);