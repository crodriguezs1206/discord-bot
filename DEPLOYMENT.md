# discord-bot
A simple Discord Bot made with Vibe Coding

# Guía de Despliegue - Discord Bot

## 1. Completar la configuración local primero
Antes de desplegar a la nube, asegúrate de que el archivo `.env` en la raíz del proyecto tenga el token real:
```env
DISCORD_TOKEN=tu_token_aqui_xXxXxX
```

## 2. Despliegue en Koyeb (Recomendado y Gratuito)

Koyeb es una excelente plataforma para alojar contenedores Docker gratuitamente que se mantengan encendidos las 24 horas del día.

### Pasos
1. Sube este código a un repositorio público o privado en **GitHub**. (Asegúrate de ignorar el archivo `.env` y la carpeta `node_modules` subiendo un `.gitignore`).
2. Regístrate en [Koyeb](https://app.koyeb.com/).
3. Haz clic en **"Create Service"**.
4. Selecciona **GitHub** como método de despliegue y enlaza tu cuenta.
5. Elige el repositorio donde subiste el bot.
6. En la sección **Builder**, selecciona **Dockerfile**.
7. En la sección **Environment variables**, añade la variable de entorno:
   - `Key`: `DISCORD_TOKEN`
   - `Value`: (Pega aquí el Token de tu bot)
8. En **Regions**, selecciona Frankfurt o Washington D.C (las opciones gratuitas).
9. En **Instance**, asegúrate de marcar la opción gratuita (`Free` - *Eco Nano*).
10. Ponle el nombre a la app como "discord-bot" y haz clic en **Deploy**.

¡Y ya está! Koyeb leerá automáticamente el `Dockerfile`, instalará las dependencias necesarias como ffmpeg, conectará Node.js, e iniciará tu bot. En un par de minutos verás en los logs que el bot se ha conectado exitosamente.
