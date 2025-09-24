const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let clients = {};
let qrAttempts = {};

function getTimestamp() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const mozTime = new Date(utc + 2 * 3600000);
    return mozTime.toLocaleString('pt-PT');
}

function log(socket, sessionName, msg) {
    const formatted = `[${sessionName}] ${getTimestamp()} ➝ ${msg}`;
    console.log(formatted);
    socket.emit('log', formatted);
}

// 🔎 Função que lê os arquivos de sessão salvos pelo LocalAuth
function loadSessionData(sessionName) {
    try {
        const basePath = path.join(__dirname, `.wwebjs_auth/session-${sessionName}`);
        let sessionFiles = {};
        if (fs.existsSync(basePath)) {
            fs.readdirSync(basePath).forEach(file => {
                const filePath = path.join(basePath, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    sessionFiles[file] = JSON.parse(content);
                } catch {
                    sessionFiles[file] = "⚠️ Não foi possível ler";
                }
            });
        }
        return sessionFiles;
    } catch (err) {
        return { error: err.message };
    }
}

function startSession(socket, sessionName) {
    if (clients[sessionName]) {
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

    client.on('ready', async () => {
        log(socket, sessionName, `✅ Sessão pronta!`);
        try {
            const sessionFiles = loadSessionData(sessionName);
            const sessionData = {
                session: sessionName,
                status: 'ready',
                info: client.info,
                tokens: sessionFiles
            };
            socket.emit('session-data', sessionData);
            log(socket, sessionName, `📌 Dados da sessão enviados ao HTML`);
        } catch (err) {
            log(socket, sessionName, `⚠️ Erro ao coletar dados da sessão: ${err.message}`);
        }
    });

    client.on('message', (message) => {
        log(socket, sessionName, `💬 ${message.from}: ${message.body}`);
    });

    client.on('auth_failure', (msg) => {
        log(socket, sessionName, `❌ Falha de autenticação: ${msg}`);
    });

    client.on('disconnected', (reason) => {
        log(socket, sessionName, `❌ Sessão desconectada: ${reason}`);
        client.destroy();
        delete clients[sessionName];
        delete qrAttempts[sessionName];
        socket.emit('session-ended', { session: sessionName, reason });
    });

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
        
