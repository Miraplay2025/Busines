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
let qrAttempts = {}; // Contador de QR por sessão
let activeSessions = new Set(); // Para impedir sessões simultâneas

// Função util para timestamp
function getTimestamp() {
    const now = new Date();
    const dia = String(now.getDate()).padStart(2, '0');
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    const ano = now.getFullYear();
    const hora = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const seg = String(now.getSeconds()).padStart(2, '0');
    return `${dia}/${mes}/${ano} ${hora}:${min}:${seg}`;
}

// Função util para logs padronizados
function log(socket, sessionName, msg) {
    const timestamp = getTimestamp();
    const formatted = `[${sessionName}] ${timestamp} ➝ ${msg}`;
    console.log(formatted);
    socket.emit('log', formatted);
}

io.on('connection', (socket) => {
    console.log('🔌 Novo cliente conectado');
    socket.emit('log', '🔌 Conectado ao servidor');

    socket.on('start-session', async (sessionName) => {
        if (!sessionName) {
            socket.emit('log', '❌ Nome da sessão não pode ser vazio');
            return;
        }

        if (activeSessions.has(sessionName)) {
            socket.emit('log', `❌ Sessão "${sessionName}" já em andamento!`);
            return;
        }

        log(socket, sessionName, `🚀 Iniciando sessão...`);
        activeSessions.add(sessionName);

        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionName }),
            puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
        });

        clients[sessionName] = client;
        qrAttempts[sessionName] = 0;

        client.on('qr', async (qr) => {
            qrAttempts[sessionName]++;
            if (qrAttempts[sessionName] > 10) {
                log(socket, sessionName, `❌ Tentativas de QR excedidas, sessão será excluída`);
                client.destroy();
                delete clients[sessionName];
                delete qrAttempts[sessionName];
                activeSessions.delete(sessionName);
                socket.emit('session-ended', { session: sessionName, reason: 'Tentativas de QR excedidas' });
                return;
            }

            log(socket, sessionName, `📷 QR code gerado (${qrAttempts[sessionName]}/10)`);
            try {
                const qrBase64 = await qrcode.toDataURL(qr);
                socket.emit('qr', { session: sessionName, qr: qrBase64, attempt: qrAttempts[sessionName] });
                log(socket, sessionName, `📌 QR code enviado ao HTML`);
            } catch (err) {
                log(socket, sessionName, `❌ Erro ao gerar QR code: ${err.message}`);
            }
        });

        client.on('ready', async () => {
            log(socket, sessionName, `✅ Sessão pronta!`);
            try {
                const sessionData = {
                    session: sessionName,
                    status: 'ready',
                    me: client.info?.me || null,
                    wid: client.info?.wid || null,
                    pushname: client.info?.pushname || null
                };
                socket.emit('session-data', sessionData);
            } catch (err) {
                log(socket, sessionName, `⚠️ Erro ao coletar dados da sessão: ${err.message}`);
            }
        });

        client.on('message', (message) => {
            log(socket, sessionName, `💬 Mensagem recebida de ${message.from}: ${message.body}`);
        });

        client.on('auth_failure', (msg) => {
            log(socket, sessionName, `❌ Falha de autenticação: ${msg}`);
        });

        client.on('disconnected', (reason) => {
            log(socket, sessionName, `❌ Sessão desconectada: ${reason}`);
            client.destroy();
            delete clients[sessionName];
            delete qrAttempts[sessionName];
            activeSessions.delete(sessionName);
            socket.emit('session-ended', { session: sessionName, reason });
        });

        try {
            client.initialize();
            log(socket, sessionName, `🔧 Inicializando cliente...`);
        } catch (err) {
            log(socket, sessionName, `❌ Erro ao inicializar cliente: ${err.message}`);
            activeSessions.delete(sessionName);
        }
    });
});

server.listen(3000, () => console.log('🌐 Servidor rodando em http://localhost:3000'));
