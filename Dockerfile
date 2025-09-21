FROM node:20-slim

WORKDIR /app

# Instala Git e dependências básicas
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Atualiza npm
RUN npm install -g npm@11.6.0

COPY package.json ./

# Instala todas as dependências
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
