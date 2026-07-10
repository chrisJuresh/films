# Build the SvelteKit (adapter-node) server, then run it on Node 22 with ffmpeg
# + Intel VAAPI for iGPU transcoding.
#
#   * The app uses the built-in `node:sqlite` module (needs Node >= 22).
#   * package.json has no runtime `dependencies`, so adapter-node's `build/`
#     output is fully self-contained.
#   * The runtime stage is Debian (not Alpine) so we can ship the proven Intel
#     media driver (iHD) for hardware H.264/HEVC encode on the UHD 770 iGPU.
#
# Build context is the repo root (see compose `context: ..`). The database,
# poster cache, media library, and encoded-output dir live on host bind-mounts.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY svelte.config.js vite.config.js ./
COPY src ./src
COPY static ./static
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
# ffmpeg + Intel VAAPI driver (iHD) for iGPU transcoding. non-free has the
# intel-media-va-driver (verified working for Raptor Lake / UHD 770).
RUN printf 'deb http://deb.debian.org/debian bookworm main contrib non-free non-free-firmware\ndeb http://deb.debian.org/debian bookworm-updates main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg intel-media-va-driver-non-free \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV LIBVA_DRIVER_NAME=iHD
# adapter-node reads these at runtime. HOST/PORT bind inside the container;
# ORIGIN tells SvelteKit its public URL (correct redirects + CSRF origin check).
ENV HOST=0.0.0.0 PORT=3000 ORIGIN=https://films.chrisj.uk
COPY --from=build /app/build ./build
EXPOSE 3000
CMD ["node", "build"]
