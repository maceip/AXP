FROM node:24.15.0-bookworm-slim
WORKDIR /agent
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY examples/fixture-agent.ts examples/fixture-agent.ts
# No credentials, source repository, or host Git directory are in this image.
