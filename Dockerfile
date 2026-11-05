FROM node:22-alpine

RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8822

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY lib ./lib
COPY bin ./bin
COPY public ./public
COPY server.js docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

VOLUME /data
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
