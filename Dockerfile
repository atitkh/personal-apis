FROM node:20

WORKDIR /home/node/app

ENV NODE_ENV=production
ENV PORT=3000

# Install ffmpeg for audio format conversion (WebM to PCM for Whisper)
USER root
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better build caching
COPY package*.json ./
RUN npm ci --omit=dev && chown -R node:node /home/node

# Run as non-root user
USER node

# Copy the rest of the source code
COPY --chown=node:node . .

EXPOSE 3000

# Use Node in containers; nodemon is for local dev
CMD [ "node", "app.js" ]
