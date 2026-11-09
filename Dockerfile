FROM node:22-alpine
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY app/ .
ARG APP_VERSION=dev
ENV PORT=8080 APP_VERSION=$APP_VERSION NODE_ENV=production \
    NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"
# The node image's "node" user, by number so runAsNonRoot can check it.
USER 1000
EXPOSE 8080 9464
CMD ["node", "src/server.js"]
