// server.js
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

let clients = {};      // instâncias por nome de sessão
let qrAttempts = {};

function getTimestamp() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const mozTime = new Date(utc + 2 * 3600000);
    const dia = String(mozTime.getDate()).padStart(2,'0');
    const mes = String(mozTime.getMonth()+1).padStart(2,'0');
    const ano = mozTime.getFullYear();
    const hora = String(mozTime.getHours()).padStart(2,'0');
    const min = String(mozTime.getMinutes()).padStart(2,'0');
    const seg = String(mozTime.getSeconds()).padStart(2,'0');
    return `${dia}/${mes}/${ano} ${hora}:${min}:${seg}`;
}

function log(socket, sessionName, msg) {
    const formatted = `[${sessionName}] ${getTimestamp()} ➝ ${msg}`;
    console.log(formatted);
    if(socket) socket.emit('log', formatted);
}

function saveSessionData(sessionName) {
    try {
        const authDir = path.join(__dirname, '.wwebjs_auth', sessionName);
        const targetDir = path.join(__dirname, 'conectado', sessionName);
        if(!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        function copyRecursively(srcDir, destDir){
            fs.readdirSync(srcDir, { withFileTypes: true }).forEach(entry=>{
                const srcPath = path.join(srcDir, entry.name);
                const destPath = path.join(destDir, entry.name);
                if(entry.isDirectory()){
                    if(!fs.existsSync(destPath)) fs.mkdirSync(destPath);
                    copyRecursively(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                }
            });
        }

        if(fs.existsSync(authDir)) copyRecursively(authDir, targetDir);
    } catch(e){
        console.error(`Erro ao salvar sessão "${sessionName}":`, e.message);
    }
}

function loadSavedSession(sessionName){
    const baseDir = path.join(__dirname, 'conectado', sessionName);
    const result = {};

    function readDirRec(dir, obj){
        fs.readdirSync(dir, { withFileTypes: true }).forEach(entry=>{
            const p = path.join(dir, entry.name);
            const rel = path.relative(baseDir, p);
            if(entry.isDirectory()){
                obj[rel] = {};
                readDirRec(p, obj[rel]);
            } else {
                try {
                    const ext = path.extname(entry.name).toLowerCase();
                    if(ext === '.json'){
                        obj[rel] = JSON.parse(fs.readFileSync(p,'utf8'));
                    } else {
                        const stat = fs.statSync(p);
                        if(stat.size < 2000){
                            obj[rel] = fs.readFileSync(p,'utf8');
                        } else {
                            obj[rel] = `⚠️ Arquivo binário/maior omitido (${stat.size} bytes)`;
                        }
                    }
                } catch(err){
                    obj[rel] = `⚠️ Erro leitura: ${err.message}`;
                }
            }
        });
    }

    if(fs.existsSync(baseDir)) readDirRec(baseDir, result);
    return result;
}

function startSession(socket, sessionName){
    if(clients[sessionName]){
        log(socket, sessionName, `⚠️ Sessão "${sessionName}" já em andamento`);
        return;
    }

    log(socket, sessionName, `🚀 Iniciando sessão...`);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionName }),
        puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
    });

    clients[sessionName] = client;
    qrAttempts[sessionName] = 0;

    client.on('qr', qr => {
        qrAttempts[sessionName]++;
        socket.emit('qr', { session: sessionName, qr, attempt: qrAttempts[sessionName] });
        log(socket, sessionName, `📷 QR atualizado (tentativa ${qrAttempts[sessionName]})`);
    });

    client.on('ready', ()=>{
        log(socket, sessionName, `✅ Sessão pronta!`);
        saveSessionData(sessionName);
        const savedData = loadSavedSession(sessionName);
        socket.emit('session-data',{
            session: sessionName,
            status:'ready',
            info: client.info,
            tokens: savedData
        });
        log(socket, sessionName, `📌 Dados da sessão salvos e enviados ao cliente`);
    });

    client.on('message', message=>{
        log(socket, sessionName, `💬 ${message.from}: ${message.body}`);
        socket.emit('message',{ session: sessionName, message });
    });

    client.on('auth_failure', msg=>{
        log(socket, sessionName, `❌ Falha de autenticação: ${msg}`);
    });

    client.on('disconnected', reason=>{
        log(socket, sessionName, `❌ Sessão desconectada: ${reason}`);
        socket.emit('session-ended',{ session: sessionName, reason });
    });

    try {
        client.initialize();
        log(socket, sessionName, `🔧 Cliente inicializado com sucesso`);
    } catch(err){
        log(socket, sessionName, `❌ Erro ao inicializar cliente: ${err.message}`);
    }
}

// Endpoint para listar todas as sessões conectadas e seus dados
app.get('/sessions', (req,res)=>{
    const sessionsDir = path.join(__dirname,'conectado');
    let result = {};
    if(fs.existsSync(sessionsDir)){
        fs.readdirSync(sessionsDir,{withFileTypes:true}).forEach(dir=>{
            if(dir.isDirectory()){
                result[dir.name] = loadSavedSession(dir.name);
            }
        });
    }
    res.json(result);
});

io.on('connection', socket=>{
    socket.on('start-session', sessionName=>{
        if(!sessionName || typeof sessionName !== 'string' || sessionName.trim().length===0){
            socket.emit('log','❌ Nome da sessão não pode ser vazio');
            return;
        }
        startSession(socket, sessionName.trim());
    });
});

const PORT=3000;
server.listen(PORT, ()=>console.log(`🌐 Servidor rodando em http://localhost:${PORT}`));
                
