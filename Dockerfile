FROM node:20-slim

WORKDIR /app

# Atualiza npm para evitar warnings
RUN npm install -g npm@11.6.0

COPY package.json ./

# Instala dependências de produção
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
