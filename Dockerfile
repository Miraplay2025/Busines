FROM node:20-slim

WORKDIR /app

# Instala dependências básicas (não precisa de Git)
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Atualiza npm
RUN npm install -g npm@11.6.0

# Copia package.json e instala dependências
COPY package.json ./
RUN npm install

# Copia restante do projeto
COPY . .

# Expõe porta
EXPOSE 3000

# Comando padrão
CMD ["npm", "start"]
