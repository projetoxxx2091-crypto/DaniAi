
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { getTMDBDetails } from './tmdb.js';

dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// Função delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Menu principal
const mainMenu = async (res) => {
    await delay(1000);
    res.json({ message: "📋 *Menu Principal*\n1️⃣ Novo Cliente\n2️⃣ Pagamento\n3️⃣ Suporte\n4️⃣ Catálogo" });
};

// Rota principal webhook
app.post('/', async (req, res) => {
    const body = req.body;
    const userMessage = body.message || "";

    if(userMessage.toLowerCase().includes('oi') || userMessage.toLowerCase().includes('olá')) {
        await mainMenu(res);
    } else if(userMessage === "4") {
        // Exemplo de uso TMDB
        const data = await getTMDBDetails("Matrix");
        res.json({ message: `🎬 ${data.title}\n📖 ${data.overview}\n📅 Lançamento: ${data.release_date}` });
    } else {
        res.json({ message: "Desculpe, não consegui entender. Por favor, escolha uma opção do menu." });
    }
});

app.listen(PORT, () => {
    console.log(`Webhook rodando na porta ${PORT}!`);
});
