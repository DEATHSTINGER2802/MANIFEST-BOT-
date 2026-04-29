const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
require('dotenv').config();

// ---------- Express health check (required by Render) ----------
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('✅ Bot is running!'));
app.listen(port, () => console.log(`✅ Health check listening on port ${port}`));
// ----------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    try {
        const commands = [
            new SlashCommandBuilder()
                .setName('ping')
                .setDescription('Replies with Pong!'),
            new SlashCommandBuilder()
                .setName('gen')
                .setDescription('Get manifest and game details by App ID')
                .addIntegerOption(opt => opt.setName('appid').setDescription('Steam App ID').setRequired(true)),
            new SlashCommandBuilder()
                .setName('depot')
                .setDescription('Fetch manifest from DepotBox (uploads to gofile.io)')
                .addIntegerOption(opt => opt.setName('appid').setDescription('Steam App ID').setRequired(true))
        ];
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered');
    } catch (err) { console.error('❌ Command registration failed:', err); }
});

// Helper: get Steam game details
async function getGameDetails(appid) {
    try {
        const res = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`, { timeout: 10000 });
        const data = res.data[appid];
        if (!data || !data.success) return null;
        const game = data.data;
        return {
            name: game.name,
            developers: game.developers ? game.developers.join(', ') : 'Unknown',
            drm: game.drm_notice || game.third_party_drm || (game.type === 'game' ? 'Steamworks (basic)' : 'No DRM info'),
            imageUrl: game.header_image || null,
            price: game.price_overview ? `${game.price_overview.currency} ${(game.price_overview.final/100).toFixed(2)}` : (game.is_free ? 'Free to Play' : 'Price unavailable'),
            releaseDate: game.release_date?.date || 'Unknown',
            steamUrl: `https://store.steampowered.com/app/${appid}`
        };
    } catch (err) { console.error(`Steam API error for ${appid}:`, err.message); return null; }
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong!');
        return;
    }

    if (interaction.commandName === 'gen') {
        const appid = interaction.options.getInteger('appid');
        await interaction.deferReply();
        if (!appid || isNaN(appid)) return interaction.editReply('❌ Provide a valid numeric App ID.');

        const game = await getGameDetails(appid);
        const sources = [
            `https://raw.githubusercontent.com/DEATHSTINGER2802/my-manifests/main/${appid}.zip`,
            `https://raw.githubusercontent.com/SteamTools-Team/GameList/main/manifests/${appid}.zip`
        ];
        let found = false, workingUrl = '';
        for (const url of sources) {
            try {
                await axios.get(url, { timeout: 3000, headers: { 'Range': 'bytes=0-0' } });
                workingUrl = url;
                found = true;
                break;
            } catch { /* ignore */ }
        }
        const embed = new EmbedBuilder()
            .setColor(found ? 0x00FF00 : 0xFF0000)
            .setTitle(game ? game.name : `App ID ${appid}`)
            .setURL(game?.steamUrl || null);
        if (game?.imageUrl) embed.setThumbnail(game.imageUrl).setImage(game.imageUrl);
        if (game) {
            embed.addFields(
                { name: '🎮 App ID', value: `${appid}`, inline: true },
                { name: '👥 Developer(s)', value: game.developers, inline: true },
                { name: '🔒 DRM', value: game.drm, inline: true },
                { name: '💰 Price', value: game.price, inline: true },
                { name: '📅 Release Date', value: game.releaseDate, inline: true }
            );
        } else {
            embed.setDescription(`❓ No game info for App ID ${appid}.`);
        }
        embed.addFields({ name: found ? '📦 Manifest' : '⚠️ Manifest', value: found ? `[Download ZIP](${workingUrl})` : 'Not found in any source.\nTry **SteamTools Discord**: discord.gg/steamtools', inline: false });
        await interaction.editReply({ embeds: [embed] });
    }

    // /depot command – safe version with upload to gofile.io
    if (interaction.commandName === 'depot') {
        const appid = interaction.options.getInteger('appid');
        await interaction.deferReply();
        if (!appid || isNaN(appid)) return interaction.editReply('❌ Provide a valid numeric App ID.');

        const game = await getGameDetails(appid);
        let replied = false;

        try {
            const response = await axios.post('https://depotbox.org/api/direct-download',
                { appid: appid.toString() },
                {
                    headers: { 'Content-Type': 'application/json', 'X-API-Key': '55c8fdd8-d9b3-4fbd-9e14-3fc88003086e' },
                    responseType: 'stream',
                    timeout: 30000
                }
            );
            const chunks = [];
            response.data.on('data', chunk => chunks.push(chunk));
            response.data.on('end', async () => {
                if (replied) return;
                replied = true;
                const buffer = Buffer.concat(chunks);
                const fileSizeMB = buffer.length / (1024 * 1024);
                const fileName = `${appid}.zip`;
                // Upload to gofile.io
                const form = new FormData();
                form.append('file', buffer, { filename: fileName });
                let downloadUrl = null;
                try {
                    const uploadRes = await axios.post('https://store1.gofile.io/uploadFile', form, {
                        headers: { ...form.getHeaders(), 'User-Agent': 'DiscordBot/1.0' },
                        timeout: 60000
                    });
                    if (uploadRes.data.status === 'ok') downloadUrl = uploadRes.data.data.downloadPage;
                } catch (upErr) { console.error('gofile.io upload failed:', upErr.message); }
                const embed = new EmbedBuilder()
                    .setColor(downloadUrl ? 0x00AAFF : 0xFF0000)
                    .setTitle(`📦 ${game ? game.name : `App ID ${appid}`} - DepotBox Source`)
                    .setDescription(downloadUrl ? 'Manifest uploaded to gofile.io' : 'Upload failed, file too large or service down.')
                    .setFooter({ text: 'DepotBox + gofile.io' });
                if (game) {
                    embed.addFields(
                        { name: '🎮 App ID', value: `${appid}`, inline: true },
                        { name: '👥 Developer(s)', value: game.developers, inline: true },
                        { name: '🔒 DRM', value: game.drm, inline: true },
                        { name: '💰 Price', value: game.price, inline: true },
                        { name: '📅 Release Date', value: game.releaseDate, inline: true },
                        { name: '📦 File Size', value: `${fileSizeMB.toFixed(2)} MB`, inline: true }
                    );
                    if (game.imageUrl) embed.setThumbnail(game.imageUrl);
                }
                if (downloadUrl) {
                    embed.addFields({ name: '🔗 Download', value: `[Click here](${downloadUrl})`, inline: false });
                    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('📥 Download').setStyle(ButtonStyle.Link).setURL(downloadUrl));
                    await interaction.editReply({ embeds: [embed], components: [row] });
                } else {
                    embed.setDescription(`❌ Could not upload ${fileSizeMB.toFixed(2)} MB file. Use /gen with your own GitHub repo for large manifests.`);
                    await interaction.editReply({ embeds: [embed] });
                }
            });
            response.data.on('error', async (err) => {
                if (replied) return;
                replied = true;
                console.error(`Stream error: ${err.message}`);
                await interaction.editReply('❌ Failed to receive manifest from DepotBox.');
            });
        } catch (error) {
            if (replied) return;
            replied = true;
            console.error(`DepotBox error: ${error.message}`);
            await interaction.editReply(`❌ DepotBox could not deliver manifest for App ID ${appid}.`);
        }
    }
});

// Login with error catcher so Render logs show the real problem
client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('❌ Login failed:', err);
    process.exit(1);
});
