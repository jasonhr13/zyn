FROM node:22-alpine
WORKDIR /app
COPY lib.mjs server.mjs ./
ENV NODE_ENV=production
ENV PORT=8080
CMD ["node", "server.mjs"]
