# Build the SvelteKit (adapter-node) server, then run it on Node 22.
#
# Two things make this image simple:
#   * The app uses the built-in `node:sqlite` module (needs Node >= 22), so
#     there is NOTHING native to compile.
#   * package.json has no runtime `dependencies` (the code imports only Node
#     built-ins + global fetch), so adapter-node's `build/` output is fully
#     self-contained -- no node_modules to ship into the runtime stage.
#
# Build context is the repo root (see compose `context: ..`). The database and
# poster cache are NOT baked in; they live on a host bind-mount at runtime.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY svelte.config.js vite.config.js ./
COPY src ./src
COPY static ./static
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# adapter-node reads these at runtime. HOST/PORT bind inside the container;
# ORIGIN tells SvelteKit its public URL (correct redirects + CSRF origin check
# behind the Cloudflare tunnel).
ENV HOST=0.0.0.0 PORT=3000 ORIGIN=https://films.chrisj.uk
COPY --from=build /app/build ./build
EXPOSE 3000
CMD ["node", "build"]
