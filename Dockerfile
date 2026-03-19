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
RUN npm install

# Crear carpeta local donde jdocmunch guarda los índices
RUN mkdir -p /root/.local/share/jdocmunch
RUN mkdir -p /root/.local/share/jdocmunch/doc-index
RUN mkdir -p /app/books

# Copiar todo el código y los libros
COPY . .

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
