FROM node:20

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node

WORKDIR /home/node/app

COPY package*.json ./

RUN chown -R node /home/node/app

USER node

RUN npm install

RUN npm install

COPY --chown=node:node . .

EXPOSE 3000

CMD [ "nodemon", "app.js" ]