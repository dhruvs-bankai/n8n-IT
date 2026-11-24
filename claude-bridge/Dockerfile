# Unmodified Claude Code CLI + a thin HTTP shim.
# Debian slim rather than alpine: the CLI ships a prebuilt binary that expects glibc.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# latest published CLI, exactly as Anthropic ships it. Do not patch it.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY server.mjs ./server.mjs

ENV HOME=/home/node \
    PORT=8080
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node /app

USER node
CMD ["node", "/app/server.mjs"]
