FROM node:20

ENV NODE_ENV=production
ENV PORT=3000

# Production dependencies live in the image, outside the app folder, so the compose file can bind-mount the source over
# /home/node/app (code and dashboard files are served from disk) without hiding them. Rebuild the image only when
# package.json or package-lock.json change: `docker compose build`. Nothing is installed when the container starts.
WORKDIR /opt/deps
COPY package*.json ./
RUN npm ci --omit=dev && chown -R node:node /opt/deps
ENV NODE_PATH=/opt/deps/node_modules

WORKDIR /home/node/app
COPY --chown=node:node . .

# Run as non-root user
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD [ "node", "app.js" ]
