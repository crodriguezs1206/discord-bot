require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const { Player } = require('discord-player');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.commands = new Collection();

// Inicializamos el reproductor
const player = new Player(client, {
    ytdlOptions: {
        quality: 'highestaudio',
        highWaterMark: 1 << 25
    }
});

// Cargamos los extractores por defecto (YouTube, Spotify, SoundCloud, etc.)
player.extractors.loadDefault();

// Inactividad de 30 minutos (1800000 ms)
const INACTIVITY_TIMEOUT = 1800 * 1000;
const disconnectTimers = new Map();

player.events.on('emptyChannel', (queue) => {
    // Cuando el canal de voz se queda vacío
    const timer = setTimeout(() => {
        if (queue.connection) queue.delete();
    }, INACTIVITY_TIMEOUT);
    disconnectTimers.set(queue.guild.id, timer);
});

player.events.on('emptyQueue', (queue) => {
    // Cuando se acaba la música
    const timer = setTimeout(() => {
        if (queue.connection) queue.delete();
    }, INACTIVITY_TIMEOUT);
    disconnectTimers.set(queue.guild.id, timer);
});

player.events.on('playerStart', (queue, track) => {
    // Si la música empieza o se reanuda, cancelamos cualquier timer de desconexión
    if (disconnectTimers.has(queue.guild.id)) {
        clearTimeout(disconnectTimers.get(queue.guild.id));
        disconnectTimers.delete(queue.guild.id);
    }
    queue.metadata.channel.send(`🎶 Reproduciendo ahora: **${track.title}**`);
});

// Definición de Comandos (Slash Commands)
const commands = [
    {
        name: 'playy',
        description: 'Reproduce una canción o vídeo desde YouTube.',
        options: [
            {
                name: 'url',
                type: 3, // STRING type
                description: 'El enlace de YouTube',
                required: true,
            },
        ],
    },
    {
        name: 'plays',
        description: 'Reproduce una canción desde Spotify.',
        options: [
            {
                name: 'artista',
                type: 3,
                description: 'Nombre del artista',
                required: true,
            },
            {
                name: 'cancion',
                type: 3,
                description: 'Nombre de la canción',
                required: true,
            },
        ],
    },
    {
        name: 'help',
        description: 'Muestra la ayuda y comandos del bot Jester.',
    }
];

client.once('ready', async () => {
    console.log(`🤖 ¡Jester está en línea como ${client.user.tag}!`);
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

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'help') {
        return interaction.reply({
            content: `🎭 **¡Hola! Soy Jester, tu bufón musical.**\n\nMis comandos actuales:\n- \`/playy <url>\`: Reproduce una canción directamente desde un enlace de YouTube.\n- \`/plays <artista> <cancion>\`: Busca y reproduce una canción usando Spotify.\n- \`/help\`: Muestra este mensaje de ayuda.\n\n🎵 *Si me quedo solo o sin música durante 30 minutos, me iré a descansar.*`,
            ephemeral: true
        });
    }

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

        let query = '';
        if (interaction.commandName === 'playy') {
            query = interaction.options.getString('url');
        } else if (interaction.commandName === 'plays') {
            const artista = interaction.options.getString('artista');
            const cancion = interaction.options.getString('cancion');
            query = `${artista} ${cancion} spotify`;
        }
        
        try {
            const searchResult = await player.search(query, {
                searchEngine: interaction.commandName === 'playy' ? 'youtube' : 'spotify',
                requestedBy: interaction.user
            });

            if (!searchResult || !searchResult.tracks.length) {
                return interaction.followUp('❌ No se encontró ninguna canción o el enlace es inválido.');
            }

            const queue = await player.nodes.create(interaction.guild, {
                metadata: {
                    channel: interaction.channel,
                    client: interaction.guild.members.me,
                    requestedBy: interaction.user
                },
                selfDeaf: true,
                volume: 80,
                leaveOnEmpty: false,
                leaveOnEnd: false,
            });

            if (!queue.connection) {
                await queue.connect(voiceChannel);
            }

            queue.addTrack(searchResult.tracks[0]);
            
            if (!queue.node.isPlaying()) {
                await queue.node.play();
                interaction.followUp(`⏳ Añadido a la cola y cargando: **${searchResult.tracks[0].title}**...`);
            } else {
                interaction.followUp(`✅ Añadido a la cola: **${searchResult.tracks[0].title}**`);
            }

        } catch (error) {
            console.error(error);
            interaction.followUp('❌ Hubo un error al intentar reproducir la canción.');
        }
    }
});

// Servidor web auxiliar para mantener el bot activo 24/7 en Render con UptimeRobot
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
