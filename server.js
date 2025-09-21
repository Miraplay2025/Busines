const express = require('express');
const cors = require('cors');
const wppconnect = require('@wppconnect-team/wppconnect');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let clientSessions = {}; // armazena sessões ativas

// Criar sessão WPPConnect
app.post('/create-session', async (req, res) => {
    const { sessionName } = req.body;
    if (!sessionName) return res.status(400).json({ error: 'Nome da sessão é obrigatório' });

    try {
        const client = await wppconnect.create({
            session: sessionName,
            puppeteerOptions: {
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox"]
            },
            catchQR: (qrCode, asciiQR, attempt, urlCode) => {
                clientSessions[sessionName] = {
                    qr: qrCode,
                    connected: false,
                    client: null
                };
                console.log(`QR Code atualizado para sessão "${sessionName}"`);
            },
            statusFind: (statusSession, session) => {
                if (statusSession === 'isLogged') {
                    clientSessions[sessionName].connected = true;
                    clientSessions[sessionName].client = client;
                    clientSessions[sessionName].qr = null;
                    console.log(`Sessão "${sessionName}" conectada com sucesso`);
                }
            }
        });

        res.json({ message: 'Sessão iniciada com sucesso' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao criar sessão' });
    }
});

// Retornar status da sessão e QR Code
app.get('/session/:name', (req, res) => {
    const { name } = req.params;
    const session = clientSessions[name];
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });

    res.json({
        qr: session.qr,
        connected: session.connected
    });
});

app.listen(3000, () => {
    console.log('Servidor rodando em http://localhost:3000');
});
