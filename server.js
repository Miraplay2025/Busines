     const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let clients = {}; // Armazena instâncias por nome de sessão

io.on('connection', (socket) => {
    console.log('🔌 Novo cliente conectado');
    socket.emit('log', '🔌 Conectado ao servidor');

    socket.on('start-session', async (sessionName) => {
        if (!sessionName) {
            socket.emit('log', '❌ Nome da sessão não pode ser vazio');
            return;
        }

        socket.emit('log', `🚀 Iniciando sessão: ${sessionName}...`);

        // Evita recriar a sessão se já existir
        if (clients[sessionName]) {
            socket.emit('log', `⚠️ Sessão ${sessionName} já existe`);
            return;
        }

        // Cria cliente WhatsApp
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionName }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        clients[sessionName] = client;

        // QR Code
        client.on('qr', async (qr) => {
            socket.emit('log', '📷 QR code gerado, aguardando escaneamento...');
            try {
                const qrDataUrl = await qrcode.toDataURL(qr);
                socket.emit('qr', qrDataUrl);
                socket.emit('log', '📌 QR code enviado para o HTML');
            } catch (err) {
                socket.emit('log', '❌ Erro ao gerar QR code: ' + err.message);
            }
        });

        // Sessão pronta
        client.on('ready', () => {
            socket.emit('log', `✅ Sessão ${sessionName} pronta!`);
        });

        // Mensagens recebidas
        client.on('message', (message) => {
            socket.emit('log', `💬 Mensagem recebida de ${message.from}: ${message.body}`);
        });

        // Falha de autenticação
        client.on('auth_failure', (msg) => {
            socket.emit('log', `❌ Falha de autenticação na sessão ${sessionName}: ${msg}`);
        });

        // Desconexão
        client.on('disconnected', (reason) => {
            socket.emit('log', `❌ Sessão ${sessionName} desconectada: ${reason}`);
            delete clients[sessionName];
        });

        // Inicializa
        try {
            client.initialize();
            socket.emit('log', `🔧 Inicializando cliente para sessão ${sessionName}...`);
        } catch (err) {
            socket.emit('log', '❌ Erro ao inicializar cliente: ' + err.message);
        }
    });
});

server.listen(3000, () => console.log('🌐 Servidor rodando em http://localhost:3000'));
Oretirne o qrcode como base64
Reivie o js completo  
