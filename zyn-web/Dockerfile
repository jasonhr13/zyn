# Build from the repository root:
#   docker build -f zyn-web/Dockerfile .
FROM node:20-bookworm-slim

# Static Go engine needs the system CA bundle. Node embeds its own.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV ZYN_DATA_DIR=/data
ENV PORT=8080
ENV NODE_PATH=/app/zyn-web/node_modules
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

COPY zyn-web/package.json /app/zyn-web/package.json
RUN cd /app/zyn-web && npm install --omit=dev

COPY launcher/*.js /app/launcher/
COPY native-farmer/imap-client.mjs /app/native-farmer/imap-client.mjs
COPY zyn-web /app/zyn-web
COPY frontend/build /app/zyn-web/ui
COPY native-backend/linux-x64/backend /app/native-backend/linux-x64/backend
# ESM imports resolve from the file's directory, not NODE_PATH. Keep the mailbox reader
# next to zyn-web/node_modules so `imapflow` / `mailparser` load on Linux.
COPY native-farmer/imap-client.mjs /app/zyn-web/server/imap-client.mjs
RUN ln -sfn /app/zyn-web/node_modules /app/node_modules \
  && chmod 0755 /app/native-backend/linux-x64/backend

WORKDIR /app/zyn-web
EXPOSE 8080
CMD ["node", "server/index.js"]
