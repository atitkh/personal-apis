FROM node:10-alpine

RUN mkdir -p /home/node/app/node_modules && chown -R voltex:voltex /home/node/app

WORKDIR /home/node/app

COPY package*.json ./

USER voltex

RUN npm install

COPY --chown=voltex:voltex . .

EXPOSE 3000

CMD [ "node", "app.js" ]