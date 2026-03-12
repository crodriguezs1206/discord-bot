FROM node:18-bullseye-slim

# Install system dependencies: ffmpeg, python3, pip3, yt-dlp, build tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    build-essential \
    && pip3 install --no-cache-dir yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Create application directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Start the bot
CMD ["node", "index.js"]
