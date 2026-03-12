FROM python:3.12-slim

# Instalar dependencias del sistema y Node.js 20
RUN apt-get update && apt-get install -y curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Instalar 'uv' y pre-instalar el motor v1.3.0 con soporte de Gemini
RUN pip install uv && uv tool install jdocmunch-mcp==1.3.0[gemini]

WORKDIR /app

# Copiar configuración de Node.js e instalar
COPY package*.json ./
RUN npm install

# Crear carpeta local donde jdocmunch guarda los índices de SQLite y archivos cacheados
RUN mkdir -p /root/.local/share/jdocmunch
RUN mkdir -p /app/books

# Copiar el código del servicio
COPY . .

# Exponer el puerto del microservicio
EXPOSE 3000

# Añadir variables de entorno predefinidas (pueden sobreescribirse vía docker-compose)
ENV PORT=3000
ENV NODE_ENV=production

# Arrancar el servicio
CMD ["node", "server.js"]
