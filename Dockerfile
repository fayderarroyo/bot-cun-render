FROM ghcr.io/puppeteer/puppeteer:latest

# Cambiar a usuario root para instalar dependencias de sistema si fuera necesario
USER root

# Crear directorio de la app
WORKDIR /usr/src/app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código
COPY . .

# Dar permisos a la carpeta de autenticación para que el bot pueda guardar la sesión
RUN mkdir -p .wwebjs_auth && chmod -R 777 .wwebjs_auth

# Comando para iniciar el bot
CMD [ "node", "index.js" ]
