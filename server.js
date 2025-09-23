const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let clients = {};      // Armazena instâncias por nome de sessão
let qrAttempts = {};   // Contador de QR por sessão

// Timestamp em Moçambique (GMT+2)
function getTimestamp() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const mozTime = new Date(utc + 2 * 3600000);
    const dia = String(mozTime.getDate()).padStart(2, '0');
    const mes = String(mozTime.getMonth() + 1).padStart(2, '0');
    const ano = mozTime.getFullYear();
    const hora = String(mozTime.getHours()).padStart(2, '0');
    const min = String(mozTime.getMinutes()).padStart(2, '0');
    const seg = String(mozTime.getSeconds()).padStart(2, '0');
    return `${dia}/${mes}/${ano} ${hora}:${min}:${seg}`;
}

// Logs padronizados
function log(socket, sessionName, msg) {
    const timestamp = getTimestamp();
    const formatted = `[${sessionName}] ${timestamp} ➝ ${msg}`;
    console.log(formatted);
    socket.emit('log', formatted);
}

// Inicializa sessão isolada
function startSession(socket, sessionName) {
    if (clients[sessionName]) {
        // 🔔 Importante: mantém a notificação quando já existe
        log(socket, sessionName, `⚠️ Sessão "${sessionName}" já está em andamento`);
        return;
    }

    log(socket, sessionName, `🚀 Iniciando sessão...`);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionName }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    clients[sessionName] = client;
    qrAttempts[sessionName] = 0;

    // Evento QR Code
    client.on('qr', (qr) => {
        qrAttempts[sessionName]++;
        if (qrAttempts[sessionName] > 10) {
            log(socket, sessionName, `❌ Tentativas de QR excedidas, sessão será excluída`);
            client.destroy();
            delete clients[sessionName];
            delete qrAttempts[sessionName];
            socket.emit('session-ended', { session: sessionName, reason: 'Tentativas de QR excedidas' });
            return;
        }
        socket.emit('qr', { session: sessionName, qr, attempt: qrAttempts[sessionName] });
        log(socket, sessionName, `📷 QR code recebido (tentativa ${qrAttempts[sessionName]})`);
    });

    // Sessão pronta
    client.on('ready', async () => {
        log(socket, sessionName, `✅ Sessão pronta!`);
        try {
            if (client.getSessionTokenBrowser) {
                const tokenData = await client.getSessionTokenBrowser();
                const sessionData = {
                    session: sessionName,
                    status: 'ready',
                    info: client.info,
                    tokens: tokenData
                };
                socket.emit('session-data', sessionData);
                log(socket, sessionName, `📌 Dados da sessão enviados ao HTML`);
            } else {
                log(socket, sessionName, `⚠️ getSessionTokenBrowser não disponível nesta versão`);
            }
        } catch (err) {
            log(socket, sessionName, `⚠️ Erro ao coletar dados da sessão: ${err.message}`);
        }
    });

    // Mensagens recebidas
    client.on('message', (message) => {
        log(socket, sessionName, `💬 ${message.from}: ${message.body}`);
    });

    // Falha de autenticação
    client.on('auth_failure', (msg) => {
        log(socket, sessionName, `❌ Falha de autenticação: ${msg}`);
    });

    // Desconexão
    client.on('disconnected', (reason) => {
        log(socket, sessionName, `❌ Sessão desconectada: ${reason}`);
        client.destroy();
        delete clients[sessionName];
        delete qrAttempts[sessionName];
        socket.emit('session-ended', { session: sessionName, reason });
    });

    // Inicializa sem bloquear
    setImmediate(() => {
        try {
            client.initialize();
            log(socket, sessionName, `🔧 Inicializando cliente...`);
        } catch (err) {
            log(socket, sessionName, `❌ Erro ao inicializar cliente: ${err.message}`);
        }
    });
}

io.on('connection', (socket) => {
    console.log('🔌 Novo cliente conectado');
    socket.emit('log', '🔌 Conectado ao servidor');

    socket.on('start-session', (sessionName) => {
        if (!sessionName) {
            socket.emit('log', '❌ Nome da sessão não pode ser vazio');
            return;
        }
        startSession(socket, sessionName);
    });
});

server.listen(3000, () => console.log('🌐 Servidor rodando em http://localhost:3000'));
