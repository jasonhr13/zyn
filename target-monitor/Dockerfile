FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries, but keep a toolchain available so the
# build never fails if a prebuild is missing for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY assets ./assets

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/monitor.db
CMD ["node", "src/index.js"]
