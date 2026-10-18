# syntax=docker/dockerfile:1
FROM node:24.22.0-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0

# .dockerignore excludes local secrets, corpus, receipts and build outputs.
COPY . .
# The root postinstall initializes a Git submodule. A Docker build has no
# .git; the recursive clone supplies that pinned submodule in the context.
RUN test -f vendor/serene-design/src/styles/tokens.css || \
    (echo 'Missing design submodule: run git submodule update --init --recursive' >&2; exit 1)
RUN pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm rebuild esbuild sharp unrs-resolver

FROM dependencies AS build
RUN pnpm --filter web build

FROM node:24.22.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0
# Keep the source workspace: the loader and stdio MCP use tsx, and playbooks,
# example questions and the workspace marker are runtime files too.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p .data/raw .data/receipts .data/runs && chown -R node:node .data
USER node
EXPOSE 3000
CMD ["sh", "-ec", "pnpm --filter @workspace/corpus data:container && exec pnpm --filter web exec next start --hostname 0.0.0.0"]
