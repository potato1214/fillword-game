FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY scripts.json ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
