require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const playdl = require('play-dl');
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');

// Detectar ffmpeg: sistema primero, luego npm
let FFMPEG_PATH = 'ffmpeg'; // sistema (instalado via apt en Docker)
try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) FFMPEG_PATH = ffmpegStatic;
} catch (e) { /* usar sistema */ }

// Detectar yt-dlp: sistema primero, luego npm
let YT_DLP_PATH = 'yt-dlp';
try {
    const bundled = require('youtube-dl-exec');
    if (bundled && bundled.raw) YT_DLP_PATH = bundled.raw;
} catch (e) { /* usar sistema */ }

// Opciones base de yt-dlp optimizadas para servidores cloud
const YT_DLP_BASE_ARGS = [
    '--no-check-certificates',
    '--no-warnings',
    '--no-cache-dir',
    '--geo-bypass',
    '--extractor-args', 'youtube:player_client=android',
    '--user-agent', 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
];

// Ejecutar yt-dlp
function ytDlpExec(url, extraArgs) {
    return new Promise((resolve, reject) => {
        const allArgs = [...YT_DLP_BASE_ARGS, ...extraArgs, url];
        console.log(`[yt-dlp] Ejecutando: ${YT_DLP_PATH} ${extraArgs.join(' ')} "${url}"`);
        const proc = spawn(YT_DLP_PATH, allArgs);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', code => {
            if (code === 0) {
                resolve(stdout);
            } else {
                console.error(`[yt-dlp] Error (code ${code}): ${stderr}`);
                reject(new Error(`yt-dlp error: ${stderr.substring(0, 200)}`));
            }
        });
        proc.on('error', (err) => {
            console.error(`[yt-dlp] Spawn error: ${err.message}`);
            reject(new Error(`No se pudo ejecutar yt-dlp: ${err.message}`));
        });
    });
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages
    ]
});

client.commands = new Collection();
const queues = new Map();
const INACTIVITY_TIMEOUT = 1800 * 1000;
const disconnectTimers = new Map();

// --- Funciones auxiliares ---

function startInactivityTimer(guildId) {
    clearInactivityTimer(guildId);
    const timer = setTimeout(() => {
        const serverQueue = queues.get(guildId);
        if (serverQueue) {
            serverQueue.connection.destroy();
            queues.delete(guildId);
        }
    }, INACTIVITY_TIMEOUT);
    disconnectTimers.set(guildId, timer);
}

function clearInactivityTimer(guildId) {
    if (disconnectTimers.has(guildId)) {
        clearTimeout(disconnectTimers.get(guildId));
        disconnectTimers.delete(guildId);
    }
}

// Deezer API
function searchDeezer(endpoint, query) {
    return new Promise((resolve) => {
        const url = `https://api.deezer.com/search/${endpoint}?q=${encodeURIComponent(query)}&limit=10`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ data: [] }); }
            });
        }).on('error', () => resolve({ data: [] }));
    });
}

// Obtener título de un vídeo
async function getVideoTitle(videoUrl) {
    const output = await ytDlpExec(videoUrl, [
        '--dump-json', '--skip-download', '-f', 'bestaudio'
    ]);
    const json = JSON.parse(output);
    return json.title;
}

// Obtener URL directa de audio
async function getDirectAudioUrl(videoUrl) {
    const output = await ytDlpExec(videoUrl, [
        '--get-url', '-f', 'bestaudio'
    ]);
    return output.trim();
}

// Crear stream PCM via ffmpeg desde una URL directa
function createFfmpegStream(directUrl) {
    console.log(`[ffmpeg] Streaming desde URL (${directUrl.substring(0, 60)}...)`);
    const ffmpeg = spawn(FFMPEG_PATH, [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', directUrl,
        '-analyzeduration', '0',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ]);

    ffmpeg.stderr.on('data', (d) => {
        console.error(`[ffmpeg] ${d.toString()}`);
    });

    return ffmpeg;
}

// Reproducir la siguiente canción
async function playNext(guildId, textChannel) {
    const serverQueue = queues.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        startInactivityTimer(guildId);
        return;
    }

    clearInactivityTimer(guildId);
    const song = serverQueue.songs[0];

    try {
        const directUrl = await getDirectAudioUrl(song.url);

        const ffmpeg = createFfmpegStream(directUrl);
        serverQueue.currentProcess = ffmpeg;

        const resource = createAudioResource(ffmpeg.stdout, {
            inputType: StreamType.Raw,
        });

        serverQueue.player.play(resource);
        textChannel.send(`🎶 Reproduciendo ahora: **${song.title}**`);

        ffmpeg.on('error', (err) => {
            console.error('[ffmpeg] Process error:', err);
        });

    } catch (error) {
        console.error('[playNext] Error:', error);
        textChannel.send(`❌ Error al reproducir: ${error.message.substring(0, 150)}`);
        serverQueue.songs.shift();
        playNext(guildId, textChannel);
    }
}

// --- Slash Commands ---
const commands = [
    {
        name: 'playy',
        description: 'Reproduce el audio de un vídeo de YouTube.',
        options: [{
            name: 'url',
            type: 3,
            description: 'El enlace de YouTube',
            required: true,
        }],
    },
    {
        name: 'plays',
        description: 'Busca y reproduce una canción por artista y título.',
        options: [
            {
                name: 'artista',
                type: 3,
                description: 'Nombre del artista',
                required: true,
                autocomplete: true,
            },
            {
                name: 'cancion',
                type: 3,
                description: 'Nombre de la canción',
                required: true,
                autocomplete: true,
            },
        ],
    },
    { name: 'skip', description: 'Salta la canción actual.' },
    { name: 'stop', description: 'Detiene la reproducción y vacía la cola.' },
    { name: 'help', description: 'Muestra la ayuda y comandos del bot Jester.' },
];

// --- Bot Ready ---
client.once('ready', async () => {
    console.log(`🤖 ¡Jester está en línea como ${client.user.tag}!`);
    console.log(`🔧 yt-dlp: ${YT_DLP_PATH}`);
    console.log(`🔧 ffmpeg: ${FFMPEG_PATH}`);

    // Test yt-dlp al arrancar
    try {
        const proc = spawn(YT_DLP_PATH, ['--version']);
        let ver = '';
        proc.stdout.on('data', d => ver += d);
        proc.on('close', () => console.log(`🔧 yt-dlp version: ${ver.trim()}`));
    } catch (e) {
        console.error('⚠️ yt-dlp no disponible:', e.message);
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Comandos registrados con éxito.');
    } catch (error) {
        console.error('❌ Error registrando comandos:', error);
    }
});

// --- Interaction Handler ---
client.on('interactionCreate', async (interaction) => {

    // AUTOCOMPLETADO
    if (interaction.isAutocomplete()) {
        if (interaction.commandName !== 'plays') return;

        const focusedOption = interaction.options.getFocused(true);
        const focusedValue = focusedOption.value;

        if (!focusedValue || focusedValue.length < 1) {
            return await interaction.respond([]);
        }

        try {
            if (focusedOption.name === 'artista') {
                const result = await searchDeezer('artist', focusedValue);
                const choices = (result.data || []).map(artist => ({
                    name: artist.name.length > 95 ? artist.name.substring(0, 95) + '...' : artist.name,
                    value: artist.name
                })).slice(0, 10);
                await interaction.respond(choices);

            } else if (focusedOption.name === 'cancion') {
                const artista = interaction.options.getString('artista') || '';
                const searchQuery = artista ? `${artista} ${focusedValue}` : focusedValue;

                const result = await searchDeezer('track', searchQuery);
                const filtered = (result.data || []).filter(track =>
                    artista ? track.artist.name.toLowerCase().includes(artista.toLowerCase()) : true
                );

                const choices = filtered.map(track => ({
                    name: track.title.length > 95 ? track.title.substring(0, 95) + '...' : track.title,
                    value: track.title
                })).slice(0, 10);
                await interaction.respond(choices);
            }
        } catch (error) {
            console.error('Autocomplete error:', error);
            await interaction.respond([]);
        }
        return;
    }

    // COMANDOS
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'help') {
        return interaction.reply({
            content: `🎭 **¡Hola! Soy Jester, tu bufón musical.**\n\n` +
                `- \`/playy <url>\` — Reproduce el audio de un enlace de YouTube.\n` +
                `- \`/plays <artista> <cancion>\` — Busca una canción con autocompletado.\n` +
                `- \`/skip\` — Salta la canción actual.\n` +
                `- \`/stop\` — Detiene la música.\n` +
                `- \`/help\` — Este mensaje.\n\n` +
                `🎵 *30 min sin actividad = me voy a descansar.*`,
            ephemeral: true
        });
    }

    if (interaction.commandName === 'skip') {
        const sq = queues.get(interaction.guild.id);
        if (!sq || sq.songs.length === 0) return interaction.reply({ content: '❌ No hay nada reproduciéndose.', ephemeral: true });
        if (sq.currentProcess) sq.currentProcess.kill();
        sq.songs.shift();
        sq.player.stop();
        return interaction.reply('⏭️ Canción saltada.');
    }

    if (interaction.commandName === 'stop') {
        const sq = queues.get(interaction.guild.id);
        if (!sq) return interaction.reply({ content: '❌ No hay nada reproduciéndose.', ephemeral: true });
        if (sq.currentProcess) sq.currentProcess.kill();
        sq.songs = [];
        sq.player.stop();
        sq.connection.destroy();
        queues.delete(interaction.guild.id);
        clearInactivityTimer(interaction.guild.id);
        return interaction.reply('⏹️ Música detenida.');
    }

    if (interaction.commandName === 'playy' || interaction.commandName === 'plays') {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) return interaction.reply({ content: '❌ ¡Debes estar en un canal de voz!', ephemeral: true });

        const perms = voiceChannel.permissionsFor(interaction.client.user);
        if (!perms.has('Connect') || !perms.has('Speak'))
            return interaction.reply({ content: '❌ ¡No tengo permisos para ese canal de voz!', ephemeral: true });

        await interaction.deferReply();

        let videoUrl = '';
        let videoTitle = '';

        try {
            if (interaction.commandName === 'playy') {
                videoUrl = interaction.options.getString('url');
                console.log(`[playy] URL recibida: ${videoUrl}`);
                videoTitle = await getVideoTitle(videoUrl);

            } else {
                const artista = interaction.options.getString('artista');
                const cancion = interaction.options.getString('cancion');
                const searchString = `${artista} - ${cancion}`;
                console.log(`[plays] Buscando: ${searchString}`);

                const results = await playdl.search(searchString, { limit: 1, source: { youtube: 'video' } });
                if (!results || results.length === 0) {
                    return interaction.followUp('❌ No se encontró esa canción en YouTube.');
                }

                videoUrl = results[0].url;
                videoTitle = results[0].title;
                console.log(`[plays] Encontrado: ${videoTitle} -> ${videoUrl}`);
            }
        } catch (error) {
            console.error('[search] Error:', error);
            return interaction.followUp(`❌ Error buscando: ${error.message.substring(0, 150)}`);
        }

        // Cola
        const song = { url: videoUrl, title: videoTitle };
        const serverQueue = queues.get(interaction.guild.id);

        if (serverQueue) {
            serverQueue.songs.push(song);
            return interaction.followUp(`✅ Añadido a la cola (#${serverQueue.songs.length}): **${videoTitle}**`);
        }

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: true,
        });

        const player = createAudioPlayer();
        const newQueue = {
            connection, player,
            songs: [song],
            textChannel: interaction.channel,
            currentProcess: null,
        };

        queues.set(interaction.guild.id, newQueue);
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
            const q = queues.get(interaction.guild.id);
            if (q) {
                q.songs.shift();
                if (q.songs.length > 0) playNext(interaction.guild.id, q.textChannel);
                else startInactivityTimer(interaction.guild.id);
            }
        });

        player.on('error', (error) => {
            console.error('[player] Error:', error);
            const q = queues.get(interaction.guild.id);
            if (q) {
                q.textChannel.send(`❌ Error de reproducción: ${error.message.substring(0, 100)}`);
                q.songs.shift();
                playNext(interaction.guild.id, q.textChannel);
            }
        });

        connection.on(VoiceConnectionStatus.Disconnected, () => {
            const q = queues.get(interaction.guild.id);
            if (q && q.currentProcess) q.currentProcess.kill();
            queues.delete(interaction.guild.id);
            clearInactivityTimer(interaction.guild.id);
        });

        interaction.followUp(`⏳ Cargando: **${videoTitle}**...`);
        playNext(interaction.guild.id, interaction.channel);
    }
});

// Servidor web para mantener el bot activo
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Jester Bot is alive!'));
app.listen(port, () => console.log(`🌐 Web en puerto ${port}`));

client.login(process.env.DISCORD_TOKEN);
