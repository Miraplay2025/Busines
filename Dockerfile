FROM node:20-slim

WORKDIR /app

# Atualiza npm
RUN npm install -g npm@11.6.0

COPY package.json ./

# Instala todas as dependências
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
