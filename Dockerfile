FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install packaging, VCS, archive, Python, and SVG->PNG/ICNS rendering dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    tar \
    xz-utils \
    ca-certificates \
    curl \
    python3 \
    librsvg2-bin \
    fonts-dejavu-core \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server and client dependencies using layer caching
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

COPY client/package.json client/package-lock.json* ./client/
RUN if [ -f client/package-lock.json ]; then npm --prefix client ci --no-audit --no-fund; else npm --prefix client install --no-audit --no-fund; fi

# Copy project source and build production frontend bundle
COPY . .
RUN npm --prefix client run build && rm -rf client/node_modules

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3456

EXPOSE 3456

CMD ["node", "server/index.js"]
