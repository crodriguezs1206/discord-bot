require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const playdl = require('play-dl');
const https = require('https');
const { spawn, execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Detectar el binario yt-dlp: primero el del sistema (Docker/pip), luego el del npm
let YT_DLP_PATH = 'yt-dlp'; // sistema por defecto
try {
    const bundled = require('youtube-dl-exec');
    // Si existe el paquete npm, usamos su binario como fallback
    if (bundled && bundled.raw) YT_DLP_PATH = bundled.raw;
} catch (e) { /* Usar el del sistema */ }

// Función helper para ejecutar yt-dlp y obtener JSON
function ytDlpExec(url, args) {
    return new Promise((resolve, reject) => {
        const allArgs = [...args, url];
        const proc = spawn(YT_DLP_PATH, allArgs);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', code => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`yt-dlp exited ${code}: ${stderr.substring(0, 300)}`));
        });
        proc.on('error', (err) => {
            // Si el binario del sistema no existe, intentar con el bundled
            reject(new Error(`yt-dlp spawn error: ${err.message}`));
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

// Cola de reproducción por servidor
const queues = new Map();

// Inactividad de 30 minutos
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

// Búsqueda en la API de Deezer (gratuita, sin API key)
function searchDeezer(endpoint, query) {
    return new Promise((resolve, reject) => {
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

// Obtener título de un vídeo de YouTube
async function getVideoTitle(videoUrl) {
    const output = await ytDlpExec(videoUrl, [
        '--dump-json',
        '--no-check-certificates',
        '--no-warnings',
        '--skip-download',
        '-f', 'bestaudio'
    ]);
    const json = JSON.parse(output);
    return json.title;
}

// Obtener la URL directa de audio via yt-dlp
async function getDirectAudioUrl(videoUrl) {
    const output = await ytDlpExec(videoUrl, [
        '--get-url',
        '-f', 'bestaudio',
        '--no-check-certificates',
        '--no-warnings'
    ]);
    return output.trim();
}

// Crear un stream de audio PCM usando ffmpeg desde una URL directa
function createFfmpegStream(directUrl) {
    const ffmpeg = spawn(ffmpegPath, [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', directUrl,
        '-analyzeduration', '0',
        '-loglevel', '0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ]);
    return ffmpeg;
}

// Reproduce la siguiente canción de la cola
async function playNext(guildId, textChannel) {
    const serverQueue = queues.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        startInactivityTimer(guildId);
        return;
    }

    clearInactivityTimer(guildId);
    const song = serverQueue.songs[0];

    try {
        // Paso 1: Obtener la URL directa del audio con yt-dlp
        const directUrl = await getDirectAudioUrl(song.url);

        // Paso 2: Transcodificar con ffmpeg a PCM raw
        const ffmpeg = createFfmpegStream(directUrl);
        serverQueue.currentProcess = ffmpeg;

        const resource = createAudioResource(ffmpeg.stdout, {
            inputType: StreamType.Raw,
        });

        serverQueue.player.play(resource);
        textChannel.send(`🎶 Reproduciendo ahora: **${song.title}**`);

        ffmpeg.on('error', (err) => {
            console.error('ffmpeg error:', err);
        });

    } catch (error) {
        console.error('Error reproduciendo:', error);
        textChannel.send('❌ Error al reproducir la canción, saltando...');
        serverQueue.songs.shift();
        playNext(guildId, textChannel);
    }
}

// --- Definición de Comandos ---
const commands = [
    {
        name: 'playy',
        description: 'Reproduce el audio de un vídeo de YouTube.',
        options: [
            {
                name: 'url',
                type: 3,
                description: 'El enlace de YouTube (youtube.com o youtu.be)',
                required: true,
            },
        ],
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
    {
        name: 'skip',
        description: 'Salta la canción actual.',
    },
    {
        name: 'stop',
        description: 'Detiene la reproducción y vacía la cola.',
    },
    {
        name: 'help',
        description: 'Muestra la ayuda y comandos del bot Jester.',
    }
];

// --- Registro de comandos al iniciar ---
client.once('ready', async () => {
    console.log(`🤖 ¡Jester está en línea como ${client.user.tag}!`);
    console.log(`🔧 yt-dlp path: ${YT_DLP_PATH}`);
    console.log(`🔧 ffmpeg path: ${ffmpegPath}`);
    console.log('🔄 Registrando comandos globales...');

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('✅ Comandos registrados con éxito.');
    } catch (error) {
        console.error('❌ Error registrando comandos:', error);
    }
});

// --- Handler principal ---
client.on('interactionCreate', async (interaction) => {

    // ==================== AUTOCOMPLETADO ====================
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
                const searchQuery = artista
                    ? `${artista} ${focusedValue}`
                    : focusedValue;

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

    // ==================== COMANDOS ====================
    if (!interaction.isChatInputCommand()) return;

    // /help
    if (interaction.commandName === 'help') {
        return interaction.reply({
            content: `🎭 **¡Hola! Soy Jester, tu bufón musical.**\n\nMis comandos:\n- \`/playy <url>\`: Reproduce el audio de un enlace de YouTube.\n- \`/plays <artista> <cancion>\`: Busca una canción con autocompletado inteligente.\n- \`/skip\`: Salta la canción actual.\n- \`/stop\`: Detiene la música y vacía la cola.\n- \`/help\`: Muestra este mensaje.\n\n🎵 *Si me quedo solo o sin música durante 30 minutos, me iré a descansar.*`,
            ephemeral: true
        });
    }

    // /skip
    if (interaction.commandName === 'skip') {
        const serverQueue = queues.get(interaction.guild.id);
        if (!serverQueue || serverQueue.songs.length === 0) {
            return interaction.reply({ content: '❌ No hay nada reproduciéndose.', ephemeral: true });
        }
        if (serverQueue.currentProcess) serverQueue.currentProcess.kill();
        serverQueue.songs.shift();
        serverQueue.player.stop();
        return interaction.reply('⏭️ Canción saltada.');
    }

    // /stop
    if (interaction.commandName === 'stop') {
        const serverQueue = queues.get(interaction.guild.id);
        if (!serverQueue) {
            return interaction.reply({ content: '❌ No hay nada reproduciéndose.', ephemeral: true });
        }
        if (serverQueue.currentProcess) serverQueue.currentProcess.kill();
        serverQueue.songs = [];
        serverQueue.player.stop();
        serverQueue.connection.destroy();
        queues.delete(interaction.guild.id);
        clearInactivityTimer(interaction.guild.id);
        return interaction.reply('⏹️ Música detenida y cola vaciada.');
    }

    // /playy y /plays
    if (interaction.commandName === 'playy' || interaction.commandName === 'plays') {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ ¡Debes estar en un canal de voz para invocarme!', ephemeral: true });
        }

        const permissions = voiceChannel.permissionsFor(interaction.client.user);
        if (!permissions.has('Connect') || !permissions.has('Speak')) {
            return interaction.reply({ content: '❌ ¡No tengo permisos para unirme y hablar en ese canal de voz!', ephemeral: true });
        }

        await interaction.deferReply();

        let videoUrl = '';
        let videoTitle = '';

        try {
            if (interaction.commandName === 'playy') {
                // YouTube: el usuario pasa un enlace directamente
                videoUrl = interaction.options.getString('url');
                // Obtener título con yt-dlp
                videoTitle = await getVideoTitle(videoUrl);

            } else if (interaction.commandName === 'plays') {
                const artista = interaction.options.getString('artista');
                const cancion = interaction.options.getString('cancion');
                const searchString = `${artista} - ${cancion}`;

                // Buscar en YouTube vía play-dl (solo búsqueda, no streaming)
                const results = await playdl.search(searchString, { limit: 1, source: { youtube: 'video' } });
                if (!results || results.length === 0) {
                    return interaction.followUp('❌ No se encontró ninguna canción con ese nombre y artista.');
                }

                videoUrl = results[0].url;
                videoTitle = results[0].title;
            }
        } catch (error) {
            console.error('Error buscando:', error);
            return interaction.followUp('❌ Hubo un error buscando la canción. Comprueba que el enlace es válido.');
        }

        // Añadir a la cola
        const song = { url: videoUrl, title: videoTitle };
        const serverQueue = queues.get(interaction.guild.id);

        if (serverQueue) {
            serverQueue.songs.push(song);
            return interaction.followUp(`✅ Añadido a la cola (#${serverQueue.songs.length}): **${videoTitle}**`);
        }

        // Crear nueva cola y conectar al canal de voz
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: true,
        });

        const player = createAudioPlayer();
        const newQueue = {
            connection,
            player,
            songs: [song],
            textChannel: interaction.channel,
            currentProcess: null,
        };

        queues.set(interaction.guild.id, newQueue);
        connection.subscribe(player);

        // Cuando termina una canción, la siguiente
        player.on(AudioPlayerStatus.Idle, () => {
            const q = queues.get(interaction.guild.id);
            if (q) {
                q.songs.shift();
                if (q.songs.length > 0) {
                    playNext(interaction.guild.id, q.textChannel);
                } else {
                    startInactivityTimer(interaction.guild.id);
                }
            }
        });

        player.on('error', (error) => {
            console.error('Player error:', error);
            const q = queues.get(interaction.guild.id);
            if (q) {
                q.textChannel.send('❌ Error en la reproducción, saltando...');
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

// Servidor web auxiliar para mantener el bot activo 24/7 en Render
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Jester Bot is alive!');
});

app.listen(port, () => {
    console.log(`🌐 Servidor web escuchando en el puerto ${port}`);
});

client.login(process.env.DISCORD_TOKEN);
