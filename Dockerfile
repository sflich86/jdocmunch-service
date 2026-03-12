FROM python:3.11-slim

    # Instalar Node.js y dependencias de sistema necesarias para PDF/Canvas
    RUN apt-get update && apt-get install -y curl ca-certificates \
        && curl -fsSL https://deb.nodesource.com/setup_20.x | bash \
        && apt-get install -y nodejs build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
        && rm -rf /var/lib/apt/lists/*

    # Instalar 'uv' y pre-instalar el motor v1.3.0 con soporte de Gemini
    RUN pip install uv && uv tool install jdocmunch-mcp[gemini]==1.3.0

    WORKDIR /app

    # Copiar archivos de dependencias de Node
    COPY package*.json ./
    RUN npm install

    # Crear directorios para persistencia
    RUN mkdir -p /root/.local/share/jdocmunch
    RUN mkdir -p /app/books

    # Copiar el resto del código
    COPY . .

    EXPOSE 3000
    CMD ["node", "server.js"]
