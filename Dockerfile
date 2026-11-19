# Build the client and compile the Node server from the complete npm workspace.
FROM node:24-alpine AS build
WORKDIR /app

# Copy manifests first so dependency installation is cached until a package changes.
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci

# Add application sources only after dependencies are installed.
COPY . .
ARG BUILD_SHA=local
ARG BUILD_VERSION=dev
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_VERSION=${BUILD_VERSION}
RUN npm run build

# Start again from a clean image and install only runtime workspace dependencies.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV LOG_LEVEL=info
ENV ENABLE_DEMOS=false
ENV BUILD_SHA=local
ENV BUILD_VERSION=dev

# Copy only dependency manifests before installing production packages.
COPY package.json package-lock.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci --omit=dev && mkdir -p /app/logs && chown -R node:node /app

# Ship the static client and compiled server, not TypeScript or development tools.
COPY --from=build --chown=node:node /app/client/dist ./client/dist
COPY --from=build --chown=node:node /app/server/dist ./server/dist
ARG BUILD_SHA=local
ARG BUILD_VERSION=dev
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_VERSION=${BUILD_VERSION}

# Run as the image's unprivileged Node user.
USER node
EXPOSE 3000

# Ask Docker to restart this process if the liveness endpoint stops responding.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Exec form sends SIGTERM directly to Node so graceful shutdown can run.
CMD ["node", "server/dist/server/src/index.js"]
