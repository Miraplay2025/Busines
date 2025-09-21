const express = require('express');
const { default: makeWASocket, DisconnectReason, useSingleFileAuthState, fetchLatestBaileysVersion } = require('@adiwajshing/baileys');
const qrcode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const sessions = {}; // Armazena sessões em memória

// Função para log colorido no console
const log = (type, msg) => {
    const colors = {
        info: "\x1b[36m%s\x1b[0m",
        success: "\x1b[32m%s\x1b[0m",
        warn: "\x1b[33m%s\x1b[0m",
        error: "\x1b[31m%s\x1b[0m"
    };
    console.log(colors[type] || colors.info, msg);
};

// Cria nova sessão
app.post('/create-session', async (req, res) => {
    const { sessionName } = req.body;
    if(!sessionName) return res.status(400).json({ error: 'Nome da sessão é obrigatório' });

    try {
        const filePath = path.join(__dirname, `${sessionName}.json`);
        const { state, saveState } = useSingleFileAuthState(filePath);

        const { version } = await fetchLatestBaileysVersion();
        log('info', `Criando sessão "${sessionName}" com Baileys v${version.join('.')}`);

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false
        });

        // Salva a sessão
        sock.ev.on('creds.update', saveState);

        // Atualiza status do QR Code e conexão
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;

            if(qr) {
                const qrImage = await qrcode.toDataURL(qr);
                sessions[sessionName] = { sock, qrImage, connected: false };
                log('warn', `QR Code atualizado com sucesso para a sessão "${sessionName}"`);
            }

            if(connection === 'open') {
                sessions[sessionName].connected = true;
                sessions[sessionName].qrImage = null; // Oculta QR
                sessions[sessionName].sessionData = state; // Armazena tokens
                log('success', `Sessão "${sessionName}" conectada com sucesso! 🎉`);
            }

            if(connection === 'close') {
                const reason = update.lastDisconnect?.error?.output?.statusCode;
                log('error', `Sessão "${sessionName}" desconectada. Razão: ${reason || 'desconhecida'}`);

                if(reason === DisconnectReason.restartRequired) {
                    log('info', `Reconectando sessão "${sessionName}" automaticamente...`);
                }
            }
        });

        res.json({ message: `Sessão "${sessionName}" iniciada com sucesso` });
    } catch (err) {
        log('error', `Erro ao criar sessão: ${err}`);
        res.status(500).json({ error: 'Erro ao criar sessão' });
    }
});

// Retorna QR Code ou tokens
app.get('/session/:name', (req, res) => {
    const { name } = req.params;
    const session = sessions[name];
    if(!session) return res.status(404).json({ error: 'Sessão não encontrada' });

    res.json({
        qrImage: session.qrImage,
        connected: session.connected,
        sessionData: session.connected ? session.sessionData : null
    });
});

app.listen(3000, () => {
    log('info', 'Servidor rodando em http://localhost:3000');
});
