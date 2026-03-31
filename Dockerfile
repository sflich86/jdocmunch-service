FROM python:3.12-slim

# Instalar dependencias del sistema y Node.js 20
RUN apt-get update && apt-get install -y curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Instalar 'uv' de forma segura y pre-instalar el motor v1.3.0
ADD https://astral.sh/uv/install.sh /uv-installer.sh
RUN sh /uv-installer.sh && rm /uv-installer.sh
ENV PATH="/root/.local/bin/:$PATH"
RUN uv tool install jdocmunch-mcp[gemini]==1.3.0

WORKDIR /app

# Copiar configuración de Node.js e instalar
COPY package*.json ./
# Optimización: npm ci para consistencia y rebuild para bindings nativos de libsql
RUN npm ci --ignore-scripts && npm rebuild @libsql/client

# Crear carpetas con permisos adecuados
RUN mkdir -p /root/.local/share/jdocmunch/doc-index /app/books \
    && chmod -R 777 /app/books /root/.local/share/jdocmunch

# Copiar todo el código y los libros
COPY . .

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/api/jdocmunch/health || exit 1

CMD ["node", "--max-old-space-size=1024", "server.js"]
