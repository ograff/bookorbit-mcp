# syntax=docker/dockerfile:1
# Build context must include the vendor/bookorbit submodule (checkout with submodules: true).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/bookorbit/packages/types vendor/bookorbit/packages/types
RUN npm ci
# @bookorbit/types is a path dependency (symlink): build it, then the app.
RUN cd vendor/bookorbit/packages/types && npx --no-install tsc -p .
COPY tsconfig.json ./
COPY src src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/bookorbit/packages/types/package.json vendor/bookorbit/packages/types/package.json
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Same relative layout so node_modules/@bookorbit/types (a symlink) resolves.
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/vendor/bookorbit/packages/types/package.json vendor/bookorbit/packages/types/package.json
COPY --from=build /app/vendor/bookorbit/packages/types/dist vendor/bookorbit/packages/types/dist
COPY --from=build /app/dist dist
COPY package.json ./
COPY NOTICE LICENSE LICENSE-MIT-upstream ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
