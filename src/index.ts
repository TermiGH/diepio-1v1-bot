import {
  Client, GatewayIntentBits, Partials, Events, EmbedBuilder, TextChannel,
  SlashCommandBuilder, REST, Routes, ChatInputCommandInteraction, Guild,
  PermissionFlagsBits, ButtonInteraction, ModalSubmitInteraction,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuInteraction,
  MessageFlags
} from 'discord.js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import {
  initDatabase, createMatch, getMatch, saveResult, getResults, completeMatch,
  getPlayer, getPlayerInfo, getPlayerMatches, updatePlayerElo, getLeaderboard, getLeaderboardByTank,
  calcEloChange, closeDatabase, createReport, resetPlayerElo, setPlayerElo,
  requestCancel, cancelMatch, updateMatchToken, getConfig, setConfig, Match, Result, PlayerInfo
} from './database';
import { createSandbox, type SandboxBrowserResult } from './sandbox';

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN!;
const GUILD_ID = process.env.GUILD_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;

if (!TOKEN || !GUILD_ID || !CLIENT_ID) {
  console.error('Faltan variables en .env: DISCORD_TOKEN, GUILD_ID, CLIENT_ID');
  process.exit(1);
}

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

initDatabase();

const TANK_LIST = ['overlord', 'overseer', 'fighter', 'booster', 'factory', 'destroyer', 'annihilator'];
const TANK_CHOICES = TANK_LIST.map(t => ({ name: t.charAt(0).toUpperCase() + t.slice(1), value: t }));

const commands = [
  new SlashCommandBuilder()
    .setName('1v1')
    .setDescription('Crea una partida en sandbox de diep.io')
    .addUserOption(o => o.setName('jugador1').setDescription('Primer jugador').setRequired(true))
    .addUserOption(o => o.setName('jugador2').setDescription('Segundo jugador').setRequired(true))
    .addStringOption(o => o.setName('region').setDescription('Región del servidor')
      .setRequired(false)
      .addChoices(
        { name: 'Automático', value: 'auto' },
        { name: 'Atlanta (US)', value: 'atl' },
        { name: 'Frankfurt (Europa)', value: 'fra' },
        { name: 'São Paulo (Sudamérica)', value: 'sao' },
        { name: 'Singapore (Asia)', value: 'sgp' },
        { name: 'Sydney (Oceanía)', value: 'syd' },
      )),

  new SlashCommandBuilder()
    .setName('party')
    .setDescription('Crea partida con link manual')
    .addUserOption(o => o.setName('jugador1').setDescription('Primer jugador').setRequired(true))
    .addUserOption(o => o.setName('jugador2').setDescription('Segundo jugador').setRequired(true))
    .addStringOption(o => o.setName('link').setDescription('Link de diep.io').setRequired(true)),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top jugadores por ELO')
    .addStringOption(o => o.setName('tanque').setDescription('Filtrar por tanque')
      .setRequired(false)
      .addChoices(
        { name: 'Todos', value: 'all' },
        ...TANK_CHOICES
      )),

  new SlashCommandBuilder()
    .setName('info')
    .setDescription('Información de un jugador')
    .addUserOption(o => o.setName('jugador').setDescription('Jugador a consultar').setRequired(true)),

  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Reportar una partida por posible trampa')
    .addIntegerOption(o => o.setName('partida').setDescription('ID de la partida').setRequired(true))
    .addUserOption(o => o.setName('sospechoso').setDescription('Jugador sospechoso').setRequired(true))
    .addStringOption(o => o.setName('razon').setDescription('Motivo del reporte').setRequired(false)),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('[Admin] Resetear ELO de un jugador')
    .addUserOption(o => o.setName('jugador').setDescription('Jugador a resetear').setRequired(true)),

  new SlashCommandBuilder()
    .setName('set')
    .setDescription('[Admin] Asignar ELO específico a un jugador')
    .addUserOption(o => o.setName('jugador').setDescription('Jugador').setRequired(true))
    .addIntegerOption(o => o.setName('elo').setDescription('Nuevo ELO').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('[Admin] Configurar canal para resultados de partidas')
    .addChannelOption(o => o.setName('canal').setDescription('Canal para resultados').setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Bot conectado como ${c.user.tag}`);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Slash commands registrados');
  } catch (err) {
    console.error('Error registrando comandos:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (!interaction.guild) return;
    const cmd = interaction as ChatInputCommandInteraction;
    if (cmd.commandName === '1v1') await handle1v1(cmd);
    else if (cmd.commandName === 'party') await handlePartySlash(cmd);
    else if (cmd.commandName === 'leaderboard') await handleLeaderboard(cmd);
    else if (cmd.commandName === 'info') await handleInfo(cmd);
    else if (cmd.commandName === 'report') await handleReport(cmd);
    else if (cmd.commandName === 'reset') await handleReset(cmd);
    else if (cmd.commandName === 'set') await handleSet(cmd);
    else if (cmd.commandName === 'setchannel') await handleSetChannel(cmd);
    return;
  }

  if (interaction.isStringSelectMenu()) {
    const { customId } = interaction;
    if (customId.startsWith('select_tank_')) {
      await handleTankSelect(interaction);
    } else if (customId.startsWith('info_tank_')) {
      await handleInfoTankSelect(interaction);
    }
    return;
  }

  if (interaction.isButton()) {
    const { customId } = interaction;
    if (customId.startsWith('report_match_')) {
      await handleReportButton(interaction);
    } else if (customId.startsWith('cancel_match_')) {
      await handleCancelButton(interaction);
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    const { customId } = interaction;
    if (customId.startsWith('modal_result_')) {
      await handleResultModal(interaction);
    }
    return;
  }
});

const activeBrowsers = new Map<number, () => Promise<void>>();

async function closeBrowserForMatch(matchId: number) {
  const close = activeBrowsers.get(matchId);
  if (close) {
    await close();
    activeBrowsers.delete(matchId);
  }
}

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

async function sendDmWithButton(userId: string, embed: EmbedBuilder, matchId: number) {
  try {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`report_match_${matchId}`)
        .setLabel('📝 Reportar resultado')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`cancel_match_${matchId}`)
        .setLabel('🗑️ Cancelar partida')
        .setStyle(ButtonStyle.Danger)
    );
    const u = await client.users.fetch(userId);
    await u.send({ embeds: [embed], components: [row] });
  } catch {
    /* DM cerrado o no disponible */
  }
}

async function handle1v1(interaction: ChatInputCommandInteraction) {
  const player1 = interaction.options.getUser('jugador1', true);
  const player2 = interaction.options.getUser('jugador2', true);

  if (player1.bot || player2.bot) {
    return interaction.reply({ content: 'No puedes mencionar bots.', flags: MessageFlags.Ephemeral });
  }
  if (player1.id === player2.id) {
    return interaction.reply({ content: 'Deben ser dos jugadores diferentes.', flags: MessageFlags.Ephemeral });
  }

  const region = interaction.options.getString('region') || 'auto';

  await interaction.deferReply();

  const result = await createSandbox(region === 'auto' ? undefined : region);
  if (!result.success) {
    return interaction.editReply(`No se pudo crear sandbox: ${result.error}\nUsa \`/party\` con un link manual.`);
  }

  const uniqueId = result.region || 'sandbox';
  const match = createMatch(interaction.channelId, player1.id, player2.id, uniqueId);

  activeBrowsers.set(match.id, result.close);

  const embed = new EmbedBuilder()
    .setTitle('Partida creada')
    .setDescription(`${player1} vs ${player2}`)
    .addFields(
      { name: 'ID', value: `\`${match.id}\``, inline: true },
      { name: 'Región', value: result.region || 'Auto', inline: true },
      { name: 'ELO', value: `**${getPlayer(player1.id).elo}** vs **${getPlayer(player2.id).elo}**`, inline: true },
      { name: 'Link', value: 'Enviado por mensaje directo', inline: false },
    )
    .setColor(0x00ff00);

  for (const u of [player1, player2]) {
    const opponent = u.id === player1.id ? player2 : player1;
    let oppName = opponent.displayName;
    try { oppName = (await client.users.fetch(opponent.id)).displayName; } catch {}

    const dmEmbed = new EmbedBuilder()
      .setTitle('Partida de diep.io')
      .setDescription(`Oponente: **${oppName}**`)
      .addFields(
        { name: 'Enlace', value: result.link },
        { name: 'ID', value: `\`${match.id}\`` },
      )
      .setColor(0x0099ff);

    await sendDmWithButton(u.id, dmEmbed, match.id);
  }

  await interaction.editReply({ embeds: [embed] });
  updateMatchToken(match.id, interaction.token);
}

async function handlePartySlash(interaction: ChatInputCommandInteraction) {
  const player1 = interaction.options.getUser('jugador1', true);
  const player2 = interaction.options.getUser('jugador2', true);
  const link = interaction.options.getString('link', true);

  if (player1.bot || player2.bot) return interaction.reply({ content: 'No puedes mencionar bots.', flags: MessageFlags.Ephemeral });
  if (player1.id === player2.id) return interaction.reply({ content: 'Deben ser dos jugadores diferentes.', flags: MessageFlags.Ephemeral });
  if (!link.startsWith('https://diep.io') && !link.startsWith('diep.io')) {
    return interaction.reply({ content: 'Link inválido.', flags: MessageFlags.Ephemeral });
  }

  const matchLink = link.startsWith('http') ? link : `https://${link}`;
  const uniqueId = matchLink.split('#')[1]?.slice(0, 8) || 'LINK';
  const match = createMatch(interaction.channelId, player1.id, player2.id, uniqueId);

  const embed = new EmbedBuilder()
    .setTitle('Partida creada (Manual)')
    .setDescription(`${player1} vs ${player2}`)
    .addFields(
      { name: 'ID', value: `\`${match.id}\``, inline: true },
      { name: 'ELO', value: `**${getPlayer(player1.id).elo}** vs **${getPlayer(player2.id).elo}**`, inline: true },
      { name: 'Link', value: 'Enviado por mensaje directo', inline: false },
    )
    .setColor(0x00ff00);

  for (const u of [player1, player2]) {
    const opponent = u.id === player1.id ? player2 : player1;
    let oppName = opponent.displayName;
    try { oppName = (await client.users.fetch(opponent.id)).displayName; } catch {}

    const dmEmbed = new EmbedBuilder()
      .setTitle('Partida de diep.io')
      .setDescription(`Oponente: **${oppName}**`)
      .addFields(
        { name: 'Enlace', value: matchLink },
        { name: 'ID', value: `\`${match.id}\`` },
      )
      .setColor(0x0099ff);

    await sendDmWithButton(u.id, dmEmbed, match.id);
  }

  await interaction.reply({ embeds: [embed] });
  updateMatchToken(match.id, interaction.token);
}

async function handleLeaderboard(interaction: ChatInputCommandInteraction) {
  const tankFilter = interaction.options.getString('tanque') || 'all';

  if (tankFilter === 'all') {
    const top = getLeaderboard(10);
    if (top.length === 0) {
      return interaction.reply({ content: 'No hay jugadores registrados aún.', flags: MessageFlags.Ephemeral });
    }
    const desc = top.map((p, i) => {
      const medal = i === 0 ? ':first_place:' : i === 1 ? ':second_place:' : i === 2 ? ':third_place:' : `${i + 1}.`;
      return `${medal} <@${p.user_id}> — **${p.elo}** ELO (${p.wins}G/${p.losses}P)`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('Leaderboard')
      .setDescription(desc)
      .setColor(0xffd700);
    return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const rows = getLeaderboardByTank(tankFilter, 10);
  if (rows.length === 0) {
    return interaction.reply({ content: `No hay jugadores con el tanque **${tankFilter}** aún.`, flags: MessageFlags.Ephemeral });
  }

  const tankName = tankFilter.charAt(0).toUpperCase() + tankFilter.slice(1);
  const desc = rows.map((r: any, i: number) => {
    const medal = i === 0 ? ':first_place:' : i === 1 ? ':second_place:' : i === 2 ? ':third_place:' : `${i + 1}.`;
    return `${medal} <@${r.user_id}> — **${r.elo}** ELO (${tankName}: ${r.tank_wins}G/${r.tank_losses}P)`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Leaderboard — ${tankName}`)
    .setDescription(desc)
    .setColor(0xffd700);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleInfo(interaction: ChatInputCommandInteraction) {
  const target = interaction.options.getUser('jugador', true);
  const player = getPlayer(target.id);
  const info = getPlayerInfo(target.id);

  const totalGames = player.wins + player.losses;
  const winRate = totalGames > 0 ? Math.round(player.wins / totalGames * 100) : 0;

  const embed = new EmbedBuilder()
    .setTitle(`Información de ${target.displayName}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'ELO', value: `**${player.elo}**`, inline: true },
      { name: 'Victorias', value: `${player.wins}`, inline: true },
      { name: 'Derrotas', value: `${player.losses}`, inline: true },
      { name: 'Total partidas', value: `${totalGames}`, inline: true },
      { name: 'Win rate', value: `${winRate}%`, inline: true },
    )
    .setColor(0x00ff00);

  if (info.tankStats.length > 0) {
    const tankDesc = info.tankStats.map((t) => {
      const tName = t.tank.charAt(0).toUpperCase() + t.tank.slice(1);
      return `**${tName}**: ${t.wins}G/${t.losses}P (${t.games} partidas)`;
    }).join('\n');
    embed.addFields({ name: 'Por tanque', value: tankDesc });
  }

  const selectMenu = buildInfoTankMenu(target.id, info);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

function buildInfoTankMenu(userId: string, info: PlayerInfo): StringSelectMenuBuilder {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`info_tank_${userId}`)
    .setPlaceholder('Filtrar por tanque');

  select.addOptions({ label: 'Todos', value: 'all', description: 'Estadísticas generales' });

  for (const t of ['overlord', 'overseer', 'fighter', 'booster', 'factory', 'destroyer', 'annihilator']) {
    const stat = info.tankStats.find(s => s.tank === t);
    const tName = t.charAt(0).toUpperCase() + t.slice(1);
    select.addOptions({
      label: tName,
      value: t,
      description: stat ? `${stat.wins}G/${stat.losses}P (${stat.games} partidas)` : 'Sin partidas',
    });
  }
  return select;
}

async function handleInfoTankSelect(interaction: StringSelectMenuInteraction) {
  const targetUserId = interaction.customId.split('_')[2];
  const tank = interaction.values[0];

  let target;
  try { target = await interaction.client.users.fetch(targetUserId); } catch {
    return interaction.reply({ content: 'Usuario no encontrado.', flags: MessageFlags.Ephemeral });
  }

  const player = getPlayer(targetUserId);
  const info = getPlayerInfo(targetUserId);
  const totalGames = player.wins + player.losses;
  const winRate = totalGames > 0 ? Math.round(player.wins / totalGames * 100) : 0;

  const embed = new EmbedBuilder()
    .setThumbnail(target.displayAvatarURL())
    .setColor(0x00ff00);

  if (tank === 'all') {
    embed.setTitle(`Información de ${target.displayName}`);
    embed.addFields(
      { name: 'ELO', value: `**${player.elo}**`, inline: true },
      { name: 'Victorias', value: `${player.wins}`, inline: true },
      { name: 'Derrotas', value: `${player.losses}`, inline: true },
      { name: 'Total partidas', value: `${totalGames}`, inline: true },
      { name: 'Win rate', value: `${winRate}%`, inline: true },
    );
    if (info.tankStats.length > 0) {
      const tankDesc = info.tankStats.map((t) => {
        const tName = t.tank.charAt(0).toUpperCase() + t.tank.slice(1);
        return `**${tName}**: ${t.wins}G/${t.losses}P (${t.games} partidas)`;
      }).join('\n');
      embed.addFields({ name: 'Por tanque', value: tankDesc });
    }
  } else {
    const tName = tank.charAt(0).toUpperCase() + tank.slice(1);
    const stat = info.tankStats.find(s => s.tank === tank);
    const matches = getPlayerMatches(targetUserId, tank, 10);
    const tankWins = stat?.wins || 0;
    const tankLosses = stat?.losses || 0;
    const tankTotal = tankWins + tankLosses;
    const tankWinRate = tankTotal > 0 ? Math.round(tankWins / tankTotal * 100) : 0;

    embed.setTitle(`Información de ${target.displayName} — ${tName}`);
    embed.addFields(
      { name: 'ELO total', value: `**${player.elo}**`, inline: true },
      { name: `${tName} — Victorias`, value: `${tankWins}`, inline: true },
      { name: `${tName} — Derrotas`, value: `${tankLosses}`, inline: true },
      { name: `${tName} — Partidas`, value: `${tankTotal}`, inline: true },
      { name: `${tName} — Win rate`, value: `${tankWinRate}%`, inline: true },
    );

    if (matches.length > 0) {
      const matchDesc = matches.map((m) => {
        const isWin = m.winner_id === targetUserId;
        const isDraw = m.winner_id === null;
        const opponentId = m.player1_id === targetUserId ? m.player2_id : m.player1_id;
        if (isDraw) return `🤝 vs <@${opponentId}> — **${m.my_score}-${m.opponent_score}**`;
        return `${isWin ? '✅' : '❌'} vs <@${opponentId}> — **${m.my_score}-${m.opponent_score}**`;
      }).join('\n');
      embed.addFields({ name: 'Últimas partidas', value: matchDesc });
    } else {
      embed.addFields({ name: 'Últimas partidas', value: 'Sin partidas con este tanque.' });
    }
  }

  const selectMenu = buildInfoTankMenu(targetUserId, info);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  await interaction.update({ embeds: [embed], components: [row] });
}

async function handleCancelButton(interaction: ButtonInteraction) {
  const matchId = parseInt(interaction.customId.split('_')[2], 10);
  if (isNaN(matchId)) {
    return interaction.reply({ content: 'ID de partida inválido.', flags: MessageFlags.Ephemeral });
  }

  const match = getMatch(matchId);
  if (!match) {
    return interaction.reply({ content: 'Partida no encontrada.', flags: MessageFlags.Ephemeral });
  }
  if (match.status !== 'pending') {
    return interaction.reply({ content: 'Esta partida ya fue cerrada.', flags: MessageFlags.Ephemeral });
  }

  const isPlayer = match.player1_id === interaction.user.id || match.player2_id === interaction.user.id;
  if (!isPlayer) {
    return interaction.reply({ content: 'No eres parte de esta partida.', flags: MessageFlags.Ephemeral });
  }

  const bothVoted = requestCancel(matchId, interaction.user.id);

  if (bothVoted) {
    cancelMatch(matchId);

    const cancelEmbed = new EmbedBuilder()
      .setTitle('Partida cancelada ❌')
      .setDescription(`<@${match.player1_id}> vs <@${match.player2_id}>`)
      .addFields(
        { name: 'ID', value: `\`${match.id}\``, inline: true },
        { name: 'Estado', value: 'Cancelada por ambos jugadores', inline: false },
      )
      .setColor(0x888888);

    await updateMatchEmbed(match, cancelEmbed);

    for (const id of [match.player1_id, match.player2_id]) {
      try {
        const u = await client.users.fetch(id);
        await u.send({ embeds: [cancelEmbed] });
      } catch {}
    }

    await closeBrowserForMatch(matchId);

    await interaction.reply({ content: '✅ Partida cancelada. Ambos jugadores confirmaron.', flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content: '⏳ Voto registrado. Esperando a que el otro jugador también confirme la cancelación.', flags: MessageFlags.Ephemeral });
  }
}

async function handleReport(interaction: ChatInputCommandInteraction) {
  const matchId = interaction.options.getInteger('partida', true);
  const accused = interaction.options.getUser('sospechoso', true);
  const reason = interaction.options.getString('razon');

  const match = getMatch(matchId);
  if (!match) {
    return interaction.reply({ content: 'Partida no encontrada.', flags: MessageFlags.Ephemeral });
  }

  const report = createReport(matchId, interaction.user.id, accused.id, reason || undefined);

  const embed = new EmbedBuilder()
    .setTitle('Reporte creado')
    .setDescription(`Partida **#${matchId}**`)
    .addFields(
      { name: 'Sospechoso', value: `<@${accused.id}>`, inline: true },
      { name: 'ID Reporte', value: `\`${report.id}\``, inline: true },
      { name: 'Razón', value: reason || '(Sin especificar)', inline: false },
    )
    .setColor(0xff4444);

  await interaction.reply({ embeds: [embed] });

  const resultChannelId = getConfig('result_channel_id');
  if (resultChannelId) {
    const alertChannel = await client.channels.fetch(resultChannelId).catch(() => null);
    if (alertChannel instanceof TextChannel) {
      const alertEmbed = new EmbedBuilder()
        .setTitle('Reporte de partida')
        .setDescription(`Partida **#${matchId}**: <@${match.player1_id}> vs <@${match.player2_id}>`)
        .addFields(
          { name: 'Reportado por', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Sospechoso', value: `<@${accused.id}>`, inline: true },
          { name: 'Razón', value: reason || '(Sin especificar)' },
        )
        .setColor(0xff4444);
      await alertChannel.send({ embeds: [alertEmbed] });
    }
  }
}

async function handleReset(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: 'Necesitas ser administrador.', flags: MessageFlags.Ephemeral });
  }

  const target = interaction.options.getUser('jugador', true);
  const oldElo = getPlayer(target.id).elo;
  resetPlayerElo(target.id);

  const embed = new EmbedBuilder()
    .setTitle('ELO reseteado')
    .setDescription(`<@${target.id}>`)
    .addFields(
      { name: 'ELO anterior', value: `**${oldElo}**`, inline: true },
      { name: 'ELO nuevo', value: `**500**`, inline: true },
    )
    .setColor(0x00ff00);

  await interaction.reply({ embeds: [embed] });

  if (interaction.guild) {
    await updateNickname(interaction.guild, target.id, 500);
  }
}

async function handleSet(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: 'Necesitas ser administrador.', flags: MessageFlags.Ephemeral });
  }

  const target = interaction.options.getUser('jugador', true);
  const newElo = interaction.options.getInteger('elo', true);

  if (newElo < 0 || newElo > 9999) {
    return interaction.reply({ content: 'ELO inválido (0-9999).', flags: MessageFlags.Ephemeral });
  }

  const oldElo = getPlayer(target.id).elo;
  setPlayerElo(target.id, newElo);

  const embed = new EmbedBuilder()
    .setTitle('ELO actualizado')
    .setDescription(`<@${target.id}>`)
    .addFields(
      { name: 'ELO anterior', value: `**${oldElo}**`, inline: true },
      { name: 'ELO nuevo', value: `**${newElo}**`, inline: true },
    )
    .setColor(0x00ff00);

  await interaction.reply({ embeds: [embed] });

  if (interaction.guild) {
    await updateNickname(interaction.guild, target.id, newElo);
  }
}

async function handleSetChannel(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction)) {
    return interaction.reply({ content: 'Necesitas ser administrador.', flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.options.getChannel('canal', true);
  setConfig('result_channel_id', channel.id);

  const embed = new EmbedBuilder()
    .setTitle('Canal configurado')
    .setDescription(`Los resultados se publicarán en ${channel}`)
    .setColor(0x00ff00);

  await interaction.reply({ embeds: [embed] });
}

async function handleReportButton(interaction: ButtonInteraction) {
  const matchId = parseInt(interaction.customId.split('_')[2], 10);
  if (isNaN(matchId)) {
    return interaction.reply({ content: 'ID de partida inválido.', flags: MessageFlags.Ephemeral });
  }

  const match = getMatch(matchId);
  if (!match) {
    return interaction.reply({ content: 'Partida no encontrada.', flags: MessageFlags.Ephemeral });
  }
  if (match.status !== 'pending') {
    return interaction.reply({ content: 'Esta partida ya fue cerrada.', flags: MessageFlags.Ephemeral });
  }

  const isPlayer = match.player1_id === interaction.user.id || match.player2_id === interaction.user.id;
  if (!isPlayer) {
    return interaction.reply({ content: 'No eres parte de esta partida.', flags: MessageFlags.Ephemeral });
  }

  const existing = getResults(matchId);
  if (existing.find(r => r.player_id === interaction.user.id)) {
    return interaction.reply({ content: 'Ya reportaste el resultado de esta partida.', flags: MessageFlags.Ephemeral });
  }

  const tankSelect = new StringSelectMenuBuilder()
    .setCustomId(`select_tank_${matchId}`)
    .setPlaceholder('Selecciona tu tanque')
    .addOptions(
      { label: 'Overlord', value: 'overlord' },
      { label: 'Overseer', value: 'overseer' },
      { label: 'Fighter', value: 'fighter' },
      { label: 'Booster', value: 'booster' },
      { label: 'Factory', value: 'factory' },
      { label: 'Destroyer', value: 'destroyer' },
      { label: 'Annihilator', value: 'annihilator' },
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(tankSelect);
  await interaction.reply({ content: '¿Qué tanque usaste?', components: [row], flags: MessageFlags.Ephemeral });
}

async function handleTankSelect(interaction: StringSelectMenuInteraction) {
  const matchId = parseInt(interaction.customId.split('_')[2], 10);
  const tank = interaction.values[0];

  if (isNaN(matchId)) {
    return interaction.reply({ content: 'ID de partida inválido.', flags: MessageFlags.Ephemeral });
  }

  const match = getMatch(matchId);
  if (!match) {
    return interaction.reply({ content: 'Partida no encontrada.', flags: MessageFlags.Ephemeral });
  }
  if (match.status !== 'pending') {
    return interaction.reply({ content: 'Esta partida ya fue cerrada.', flags: MessageFlags.Ephemeral });
  }

  const opponentId = match.player1_id === interaction.user.id ? match.player2_id : match.player1_id;
  let opponentName = 'Rival';
  try {
    const opponent = await interaction.client.users.fetch(opponentId);
    opponentName = opponent.displayName;
  } catch {}

  const modal = new ModalBuilder()
    .setCustomId(`modal_result_${matchId}_${tank}`)
    .setTitle(`Reportar resultado - #${matchId}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('my_score')
          .setLabel('Tu puntuación (tú)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ej: 10')
          .setMaxLength(2)
          .setRequired(true)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('opponent_score')
          .setLabel(`Puntuación de ${opponentName}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ej: 7')
          .setMaxLength(2)
          .setRequired(true)
      )
    );

  await interaction.showModal(modal);
}

async function handleResultModal(interaction: ModalSubmitInteraction) {
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const tank = parts.slice(3).join('_');

  if (isNaN(matchId)) {
    return interaction.reply({ content: 'ID de partida inválido.', flags: MessageFlags.Ephemeral });
  }

  const match = getMatch(matchId);
  if (!match) {
    return interaction.reply({ content: 'Partida no encontrada.', flags: MessageFlags.Ephemeral });
  }
  if (match.status !== 'pending') {
    return interaction.reply({ content: 'Esta partida ya fue cerrada.', flags: MessageFlags.Ephemeral });
  }

  const existing = getResults(matchId);
  if (existing.find(r => r.player_id === interaction.user.id)) {
    return interaction.reply({ content: 'Ya reportaste para esta partida.', flags: MessageFlags.Ephemeral });
  }

  const myScoreStr = interaction.fields.getTextInputValue('my_score');
  const opponentScoreStr = interaction.fields.getTextInputValue('opponent_score');

  const myScore = parseInt(myScoreStr, 10);
  const opponentScore = parseInt(opponentScoreStr, 10);

  if (isNaN(myScore) || isNaN(opponentScore) || myScore < 0 || opponentScore < 0) {
    return interaction.reply({ content: 'Puntuaciones inválidas. Deben ser números entre 0 y 10.', flags: MessageFlags.Ephemeral });
  }
  if (myScore > 10 || opponentScore > 10) {
    const alert = new EmbedBuilder()
      .setTitle('Puntuación inválida')
      .setDescription(`Máximo permitido: **10-9**. Reportaste **${myScore}-${opponentScore}**.\nNingún jugador puede tener más de **10**.`)
      .setColor(0xff0000);
    try { await interaction.user.send({ embeds: [alert] }); } catch {}
    return interaction.reply({ content: 'Puntuación inválida. Revisa tu DM.', flags: MessageFlags.Ephemeral });
  }

  saveResult(matchId, interaction.user.id, myScore, tank);
  await interaction.reply(`✅ Resultado registrado: **${myScore}** - **${opponentScore}** (${tank})`);

  const updated = getResults(matchId);
  if (updated.length < 2) return;

  await processMatchCompletion(match, updated);
}

async function processMatchCompletion(match: Match, results: Result[]) {
  const r1 = results[0];
  const r2 = results[1];
  const p1Score = r1.player_id === match.player1_id ? r1.score : r2.score;
  const p2Score = r1.player_id === match.player2_id ? r1.score : r2.score;

  if (p1Score === p2Score) {
    completeMatch(match.id, null);

    const drawEmbed = new EmbedBuilder()
      .setTitle('Partida finalizada — Empate')
      .setDescription(`<@${match.player1_id}> **${p1Score}** - **${p2Score}** <@${match.player2_id}>`)
      .addFields(
        { name: 'Resultado', value: '🤝 Empate — Sin cambios de ELO' }
      )
      .setColor(0xffff00);

    await updateMatchEmbed(match, drawEmbed);
    await trySendToResultChannel(drawEmbed);
    await closeBrowserForMatch(match.id);

    const notifyEmbed = new EmbedBuilder()
      .setTitle('Partida finalizada — Empate')
      .setDescription(`Resultado: **${p1Score} - ${p2Score}**`)
      .addFields({ name: 'Resultado', value: '🤝 Empate — Sin cambios de ELO' })
      .setColor(0xffff00);

    for (const id of [match.player1_id, match.player2_id]) {
      try {
        const u = await client.users.fetch(id);
        await u.send({ embeds: [notifyEmbed] });
      } catch {}
    }
    return;
  }

  const winnerId = p1Score > p2Score ? match.player1_id : match.player2_id;
  const loserId = p1Score > p2Score ? match.player2_id : match.player1_id;
  const winnerScore = Math.max(p1Score, p2Score);
  const loserScore = Math.min(p1Score, p2Score);

  completeMatch(match.id, winnerId);

  const eloChange = calcEloChange(winnerScore, loserScore);
  updatePlayerElo(winnerId, eloChange, true);
  updatePlayerElo(loserId, -eloChange, false);

  try {
    if (match.channel_id) {
      const channel = await client.channels.fetch(match.channel_id);
      if (channel instanceof TextChannel) {
        const guild = channel.guild;
        await updateNickname(guild, winnerId, getPlayer(winnerId).elo);
        await updateNickname(guild, loserId, getPlayer(loserId).elo);
      }
    }
  } catch {}

  const finalEmbed = new EmbedBuilder()
    .setTitle('Partida finalizada')
    .setDescription(`<@${match.player1_id}> **${p1Score}** - **${p2Score}** <@${match.player2_id}>`)
    .addFields(
      { name: 'Ganador', value: `<@${winnerId}>`, inline: true },
      { name: 'ELO', value: `**+${eloChange}** (${getPlayer(winnerId).elo})`, inline: true },
      { name: 'Perdedor', value: `**-${eloChange}** (${getPlayer(loserId).elo})`, inline: true }
    )
    .setColor(0xffd700);

  await updateMatchEmbed(match, finalEmbed);

  const resultChannelId = getConfig('result_channel_id');
  if (resultChannelId) {
    const resultTextEmbed = new EmbedBuilder()
      .setTitle('Partida finalizada')
      .setDescription(`<@${match.player1_id}> vs <@${match.player2_id}>`)
      .addFields(
        { name: 'Resultado', value: `**${p1Score} - ${p2Score}**`, inline: true },
        { name: 'Ganador', value: `<@${winnerId}>`, inline: true },
        { name: 'ELO', value: `<@${winnerId}> **+${eloChange}** | <@${loserId}> **-${eloChange}**`, inline: false }
      )
      .setColor(0xffd700);
    await trySendToResultChannel(resultTextEmbed);
  }

  await closeBrowserForMatch(match.id);

  const notifyEmbed = new EmbedBuilder()
    .setTitle('Partida finalizada')
    .setDescription(`Resultado: **${p1Score} - ${p2Score}**`)
    .addFields(
      { name: 'Ganador', value: `<@${winnerId}>` },
      { name: 'Cambio ELO', value: `<@${winnerId}> **+${eloChange}** | <@${loserId}> **-${eloChange}**` }
    )
    .setColor(0xffd700);

  for (const id of [match.player1_id, match.player2_id]) {
    try {
      const u = await client.users.fetch(id);
      await u.send({ embeds: [notifyEmbed] });
    } catch {}
  }
}

async function updateMatchEmbed(match: Match, embed: EmbedBuilder) {
  if (match.interaction_token) {
    try {
      const rest = new REST({ version: '10' }).setToken(TOKEN);
      await rest.patch(Routes.webhookMessage(CLIENT_ID, match.interaction_token), {
        body: { embeds: [embed.toJSON()] }
      });
      return; // exito
    } catch (err: any) {
      console.error(`Error usando webhook para match ${match.id}: ${err?.message || err}`);
    }
  }
  // fallback
  await trySendToChannel(match.channel_id, embed);
}

async function trySendToChannel(channelId: string, embed: EmbedBuilder) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && 'send' in channel) {
      await (channel as any).send({ embeds: [embed] });
    } else {
      console.error(`No se pudo enviar al canal ${channelId}: el canal no existe o no es text-based`);
    }
  } catch (err: any) {
    console.error(`No se pudo enviar al canal ${channelId}: ${err?.message || err}`);
  }
}

async function trySendToResultChannel(embed: EmbedBuilder) {
  const resultChannelId = getConfig('result_channel_id');
  if (!resultChannelId) return;
  try {
    const channel = await client.channels.fetch(resultChannelId);
    if (channel && 'send' in channel) {
      await (channel as any).send({ embeds: [embed] });
    }
  } catch (err: any) {
    console.error(`No se pudo enviar al canal de resultados ${resultChannelId}: ${err?.message || err}`);
  }
}

/* Fallback: reporte por texto en DM */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.channel.isDMBased()) return;

  const content = message.content.trim();
  if (!content.startsWith('result') && !content.startsWith('res')) return;

  const args = content.split(/\s+/);
  if (args.length < 3) {
    return message.reply('Formato: `result ID TU_PUNTOS-PUNTOS_RIVAL`\nEj: `result 1 10-7`');
  }

  const matchId = parseInt(args[1], 10);
  if (isNaN(matchId)) return message.reply('ID inválido.');

  const match = getMatch(matchId);
  if (!match) return message.reply('Partida no encontrada.');
  if (match.player1_id !== message.author.id && match.player2_id !== message.author.id) {
    return message.reply('No eres parte de esta partida.');
  }
  if (match.status !== 'pending') return message.reply('Partida ya cerrada.');

  const scoreMatch = args[2].match(/^(\d+)[-\s](\d+)$/);
  if (!scoreMatch) return message.reply('Formato inválido. Usa: `result 1 10-7`');

  const myScore = parseInt(scoreMatch[1], 10);
  const opponentScore = parseInt(scoreMatch[2], 10);

  if (myScore > 10 || opponentScore > 10) {
    const alert = new EmbedBuilder()
      .setTitle('Puntuación inválida')
      .setDescription(`Máximo permitido: **10-9**. Reportaste **${myScore}-${opponentScore}**.\nNingún jugador puede tener más de **10**.`)
      .setColor(0xff0000);
    await message.author.send({ embeds: [alert] });
    return message.reply('Puntuación inválida. Revisa tu DM.');
  }

  const existing = getResults(matchId);
  if (existing.find(r => r.player_id === message.author.id)) {
    return message.reply('Ya reportaste para esta partida.');
  }

  saveResult(matchId, message.author.id, myScore);
  await message.reply(`✅ Resultado registrado: **${myScore}-${opponentScore}**`);

  const updated = getResults(matchId);
  if (updated.length < 2) return;

  await processMatchCompletion(match, updated);
});

async function updateNickname(guild: Guild, userId: string, elo: number) {
  try {
    const member = await guild.members.fetch(userId);
    const baseName = member.displayName.replace(/^[\d,]+\s*\|\s*/, '');
    const newNick = `${elo} | ${baseName}`.slice(0, 32);
    await member.setNickname(newNick);
  } catch {}
}

async function closeAllBrowsers() {
  const closers = [...activeBrowsers.values()];
  activeBrowsers.clear();
  await Promise.allSettled(closers.map(c => c()));
}

process.on('SIGINT', async () => { await closeAllBrowsers(); closeDatabase(); client.destroy(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllBrowsers(); closeDatabase(); client.destroy(); process.exit(0); });

client.login(TOKEN);
