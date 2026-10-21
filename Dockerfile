# syntax=docker/dockerfile:1
# Builds the backend and the frontend into one image: the backend serves the built React app.

# Pinned to a minor so two builds a month apart produce the same image.
FROM node:22.23-alpine AS base
RUN npm install -g pnpm@10.15.1
WORKDIR /app

# All workspace dependencies, dev ones included (tsc and vite run in the build stage).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile

# Compile both packages.
FROM deps AS build
COPY backend backend
COPY frontend frontend
RUN pnpm --filter frontend build && pnpm --filter backend build

# A separate, clean install of the backend's production dependencies only (the frontend ships
# as static files and needs nothing at runtime).
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter backend

# Runtime: compiled backend, production node_modules (pnpm's symlinked layout is kept intact by
# copying both levels), SQL migrations, fixtures and the built frontend.
FROM node:22.23-alpine AS runtime
ENV NODE_ENV=production \
    STATIC_DIR=/app/backend/public
WORKDIR /app/backend
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/drizzle ./drizzle
COPY --from=build /app/backend/fixtures ./fixtures
COPY --from=build /app/frontend/dist ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1
# main.js applies pending migrations before it starts listening.
CMD ["node", "dist/main.js"]
