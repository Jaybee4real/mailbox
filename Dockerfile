# syntax=docker/dockerfile:1.7
# One image for every mailbox deployment. Nothing here names a tenant: branding, domains
# and secrets all arrive as environment at run time, so the same image is safe to publish.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile --ignore-engines
COPY . .
RUN yarn build

FROM node:22-bookworm-slim
# The platform's health check probes the app from inside the container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=4030 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
EXPOSE 4030
CMD ["npx", "next", "start", "-p", "4030"]
