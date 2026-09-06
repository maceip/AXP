# A disposable systemd machine for the deployment workflow, not a production image.
FROM node:24.15.0-bookworm-slim AS node
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus caddy ca-certificates libstdc++6 util-linux passwd shellcheck \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
WORKDIR /opt/axp/releases/test
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY dist ./dist
COPY schema ./schema
COPY deploy ./deploy
COPY scripts/ops.mjs scripts/linux-smoke.mjs ./scripts/
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
