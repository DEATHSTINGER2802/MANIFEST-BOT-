const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
require('dotenv').config();

// ---------- Express health check server (required for Render) ----------
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('✅ Bot is running!');
});

app.listen(port, () => {
    console.log(`✅ Health check server listening on port ${port}`);
});
// ---------------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    try {
        const commands = [
            new SlashCommandBuilder()
                .setName('gen')
                .setDescription('Get manifest and game details by App ID')
                .addIntegerOption(option =>
                    option.setName('appid')
                        .setDescription('The Steam App ID')
                        .setRequired(true)
                ),
            new SlashCommandBuilder()
                .setName('depot')
                .setDescription('Fetch a manifest from DepotBox (large files get a direct download link)')
                .addIntegerOption(option =>
                    option.setName('appid')
                        .setDescription('The Steam App ID')
                        .setRequired(true)
                ),
            new SlashCommandBuilder()
                .setName('ping')
                .setDescription('Replies with Pong!')
        ];
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered!');
    } catch (error) {
        console.error('❌ Failed to register commands:', error);
    }
});

async function getGameDetails(appid) {
    try {
        const response = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english`, { timeout: 10000 });
        const data = response.data[appid];
        if (!data || !data.success) return null;
        const game = data.data;
        const developers = game.developers ? game.developers.join(', ') : 'Unknown';
        let drm = 'No DRM info';
        if (game.drm_notice) drm = game.drm_notice;
        else if (game.third_party_drm) drm = game.third_party_drm;
        else if (game.type === 'game') drm = 'Steamworks (basic)';
        const imageUrl = game.header_image || null;
        let price = 'Free';
        if (game.price_overview) {
            const finalPrice = game.price_overview.final / 100;
            const currency = game.price_overview.currency;
            price = `${currency} ${finalPrice.toFixed(2)}`;
            if (game.price_overview.discount_percent > 0) {
                price += ` (${game.price_overview.discount_percent}% off)`;
            }
        } else if (game.is_free) {
            price = 'Free to Play';
        } else {
            price = 'Price unavailable';
        }
        let releaseDate = 'Unknown';
        if (game.release_date && game.release_date.date) {
            releaseDate = game.release_date.date;
            if (game.release_date.coming_soon) releaseDate += ' (Coming Soon)';
        }
        return {
            name: game.name,
            developers,
            drm,
            imageUrl,
            price,
            releaseDate,
            steamUrl: `https://store.steampowered.com/app/${appid}`
        };
    } catch (error) {
        console.error(`Error fetching Steam details for ${appid}:`, error.message);
        return null;
    }
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

        if (!appid || isNaN(appid)) {
            return interaction.editReply('❌ Please provide a valid numeric App ID.');
        }

        const gameDetails = await getGameDetails(appid);

        const sources = [
            `https://raw.githubusercontent.com/DEATHSTINGER2802/my-manifests/main/${appid}.zip`,
            `https://raw.githubusercontent.com/SteamTools-Team/GameList/main/manifests/${appid}.zip`
        ];

        let found = false;
        let workingUrl = '';
        let lastError = null;

        for (const url of sources) {
            if (!url) continue;
            console.log(`🔍 Checking URL: ${url}`);
            try {
                await axios.get(url, {
                    timeout: 5000,
                    headers: { 
                        'Range': 'bytes=0-0',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    validateStatus: status => status === 200 || status === 206
                });
                workingUrl = url;
                found = true;
                console.log(`✅ Found manifest at: ${url}`);
                break;
            } catch (error) {
                lastError = error;
                console.log(`❌ Not found or error: ${url} -> ${error.message}`);
            }
        }

        const embed = new EmbedBuilder()
            .setColor(found ? 0x00FF00 : 0xFF0000)
            .setTitle(gameDetails ? gameDetails.name : `App ID ${appid}`)
            .setURL(gameDetails ? gameDetails.steamUrl : null);

        if (gameDetails && gameDetails.imageUrl) {
            embed.setThumbnail(gameDetails.imageUrl);
            embed.setImage(gameDetails.imageUrl);
        }

        if (gameDetails) {
            embed.addFields(
                { name: '🎮 App ID', value: `${appid}`, inline: true },
                { name: '👥 Developer(s)', value: gameDetails.developers, inline: true },
                { name: '🔒 DRM', value: gameDetails.drm, inline: true },
                { name: '💰 Price', value: gameDetails.price, inline: true },
                { name: '📅 Release Date', value: gameDetails.releaseDate, inline: true }
            );
        } else {
            embed.setDescription(`❓ No game information found for App ID ${appid}. It may not exist on Steam or the API is unavailable.`);
        }

        if (found) {
            embed.addFields({ name: '📦 Manifest', value: `[Download ZIP](${workingUrl})`, inline: false });
            embed.setFooter({ text: 'Click the link above to download the manifest.' });
        } else {
            let errorMsg = 'No manifest found in any of the sources.';
            if (lastError && lastError.response?.status === 404) {
                errorMsg = 'No manifest found in the repositories.';
            }
            embed.addFields({ name: '⚠️ Manifest', value: `${errorMsg}\n\nTry the **SteamTools Discord bot**: discord.gg/steamtools`, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    // /depot command – safe version with reply flag to prevent "already acknowledged" error
    if (interaction.commandName === 'depot') {
        const appid = interaction.options.getInteger('appid');
        await interaction.deferReply();

        if (!appid || isNaN(appid)) {
            return interaction.editReply('❌ Please provide a valid numeric App ID.');
        }

        const gameDetails = await getGameDetails(appid);
        let replied = false; // flag to prevent multiple replies

        try {
            const response = await axios.post('https://depotbox.org/api/direct-download',
                { appid: appid.toString() },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': '55c8fdd8-d9b3-4fbd-9e14-3fc88003086e'  // Replace with your actual key
                    },
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
                        headers: {
                            ...form.getHeaders(),
                            'User-Agent': 'DiscordBot/1.0'
                        },
                        timeout: 60000
                    });
                    if (uploadRes.data.status === 'ok') {
                        downloadUrl = uploadRes.data.data.downloadPage;
                        console.log(`✅ File uploaded to gofile.io: ${downloadUrl}`);
                    } else {
                        throw new Error('Upload failed: ' + (uploadRes.data.message || 'Unknown error'));
                    }
                } catch (uploadErr) {
                    console.error(`gofile.io upload failed: ${uploadErr.message}`);
                    downloadUrl = null;
                }

                // Build embed
                const embed = new EmbedBuilder()
                    .setColor(downloadUrl ? 0x00AAFF : 0xFF0000)
                    .setTitle(`📦 ${gameDetails ? gameDetails.name : `App ID ${appid}`} - DepotBox Source`)
                    .setDescription(downloadUrl ? 'Manifest downloaded from DepotBox and uploaded to gofile.io.' : 'Failed to upload the file to a permanent host.')
                    .setFooter({ text: 'Manifest provided by DepotBox' });

                if (gameDetails) {
                    embed.addFields(
                        { name: '🎮 App ID', value: `${appid}`, inline: true },
                        { name: '👥 Developer(s)', value: gameDetails.developers, inline: true },
                        { name: '🔒 DRM', value: gameDetails.drm, inline: true },
                        { name: '💰 Price', value: gameDetails.price, inline: true },
                        { name: '📅 Release Date', value: gameDetails.releaseDate, inline: true },
                        { name: '📦 File Size', value: `${fileSizeMB.toFixed(2)} MB`, inline: true }
                    );
                    if (gameDetails.imageUrl) {
                        embed.setThumbnail(gameDetails.imageUrl);
                        embed.setImage(gameDetails.imageUrl);
                    }
                } else {
                    embed.addFields(
                        { name: '🎮 App ID', value: `${appid}`, inline: true },
                        { name: '📦 File Size', value: `${fileSizeMB.toFixed(2)} MB`, inline: true }
                    );
                }

                if (downloadUrl) {
                    embed.addFields({ name: '🔗 Download Link', value: `[Click here to download](${downloadUrl})`, inline: false });
                    const row = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setLabel('📥 Download Manifest')
                                .setStyle(ButtonStyle.Link)
                                .setURL(downloadUrl)
                        );
                    await interaction.editReply({ embeds: [embed], components: [row] });
                } else {
                    embed.setDescription(`❌ Failed to upload the file to a permanent host. The file size is ${fileSizeMB.toFixed(2)} MB, which exceeds Discord's limit.\n\nPlease try again later or use the **/gen** command after adding this manifest to your GitHub repository.`);
                    await interaction.editReply({ embeds: [embed] });
                }
            });

            response.data.on('error', async (err) => {
                if (replied) return;
                replied = true;
                console.error(`Stream error: ${err.message}`);
                await interaction.editReply('❌ Failed to receive the manifest file from DepotBox.');
            });

        } catch (error) {
            if (replied) return;
            replied = true;
            console.error(`DepotBox API Error for ${appid}:`, error.message);
            if (error.response) {
                console.error(`Status: ${error.response.status}`, error.response.data);
            }
            await interaction.editReply(`❌ DepotBox could not find or deliver a manifest for App ID ${appid}.`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
