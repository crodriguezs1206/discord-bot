# Guía de Despliegue - Jester Bot

## 1. Completar la configuración local primero
Antes de desplegar a la nube, asegúrate de que el archivo `.env` en la raíz del proyecto tenga el token real:
```env
DISCORD_TOKEN=tu_token_aqui_xXxXxX
```

## 2. Despliegue en Render (Gratis)

Render es una excelente plataforma para alojar tu bot de forma gratuita. Hemos añadido un pequeño servidor web al código del bot para asegurarnos de que pueda mantenerse encendido las 24 horas del día usando UptimeRobot.

### Paso A: Subir el código a GitHub
1. Si no lo has hecho, asegúrate de que todo el código reciente está subido a tu repositorio de GitHub. 

### Paso B: Crear el Web Service en Render
1. Regístrate o inicia sesión en [Render.com](https://render.com/).
2. Haz clic en **"New"** (arriba a la derecha) y selecciona **"Web Service"**.
3. Selecciona **"Build and deploy from a Git repository"** y haz clic en "Next".
4. Conecta tu cuenta de GitHub y selecciona el repositorio de tu bot (`discord-bot`).
5. Configura el servicio:
   - **Name:** *jester-bot* (o el nombre que quieras)
   - **Region:** Elige la que esté más cerca de ti (ej. Fráncfort).
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Instance Type:** Asegúrate de elegir **Free** ($0/month).
6. Desplázate hacia abajo y haz clic en **"Advanced"**.
7. En la sección **Environment Variables**, haz clic en "Add Environment Variable":
   - **Key:** `DISCORD_TOKEN`
   - **Value:** *(Pega aquí el Token de tu bot de Discord)*
8. Haz clic en el botón inferior **"Create Web Service"**.

Render empezará a compilar e instalar tu bot. Tardará un par de minutos. Al terminar, verás un mensaje verde de `Live` y una URL arriba a la izquierda (ejemplo: `jester-bot-abc1.onrender.com`). Cópiala.

---

### Paso C: Mantenerlo activo 24/7 con UptimeRobot
Los servicios gratuitos de Render se "duermen" tras 15 minutos sin recibir visitas, lo que desconectaría el bot. Para evitarlo:

1. Ve a [UptimeRobot.com](https://uptimerobot.com/) y crea una cuenta gratuita.
2. Haz clic en **"Add New Monitor"**.
3. Configúralo así:
   - **Monitor Type:** `HTTP(s)`
   - **Friendly Name:** `Jester Awake`
   - **URL (or IP):** Pega la URL que te dio Render (ej. `https://jester-bot-abc1.onrender.com`)
   - **Monitoring Interval:** `5 minutes`
4. Haz clic dos veces en **"Create Monitor"** (abajo del todo).

¡Y ya está listo! UptimeRobot visitará la URL de tu bot cada 5 minutos, engañando a Render para que crea que está recibiendo visitas y evitando que se duerma. **¡Tu bot ahora estará activo 24/7 gratis!**
