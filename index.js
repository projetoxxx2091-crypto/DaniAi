// IPTv Bot Pro - Dialogflow Webhook (Gemini + TMDB + SQLite)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ======= CONFIG =======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TMDB_API_KEY   = process.env.TMDB_API_KEY;
const PIX_KEY        = process.env.PIX_KEY || "chave PIX não configurada";

if (!GEMINI_API_KEY) console.warn("[AVISO] GEMINI_API_KEY não definida.");
if (!TMDB_API_KEY)   console.warn("[AVISO] TMDB_API_KEY não definida.");

// DB local (deve existir na raiz do projeto: ./catalogo.db)
let db = new sqlite3.Database('./catalogo.db', sqlite3.OPEN_READONLY, (err) => {
  if (err) console.error('Erro ao abrir catálogo.db:', err.message);
  else console.log('Conectado ao catálogo.db!');
});

// ======= Helpers =======
function formatMenu() {
  return [
    "📋 *Menu Principal*",
    "1) 🆕 Novo Cliente",
    "2) 💳 Pagamento (PIX)",
    "3) 🛟 Suporte",
    "4) 🎞️ Catálogo (buscar filme/série)",
    "",
    "➡️ Envie o número da opção (1 a 4).",
  ].join("\n");
}

function limparTitulo(t) {
  if (!t) return "";
  return t
    .replace(/S\d{1,2}E\d{1,2}/gi, "") // SxxExx
    .replace(/S\d{1,2}\b/gi, "")       // Sxx
    .replace(/\(\d{4}\)/g, "")         // (2023)
    .replace(/\[\d{4}\]/g, "")         // [2023]
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extrairOpcaoDigitada(texto) {
  const m = (texto || "").trim().match(/^(?:op[çc][aã]o\s*)?([1-4])\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function isGreeting(text) {
  const t = (text || "").toLowerCase();
  return /(oi|ol[aá]|bom\s*dia|boa\s*tarde|boa\s*noite|menu)/.test(t);
}

// ======= Catálogo (SQLite + TMDB) =======
function buscarNoCatalogoAsync(titulo) {
  const tituloLimpo = limparTitulo(titulo);
  return new Promise((resolve, reject) => {
    db.all("SELECT titulo FROM catalogo WHERE titulo LIKE ? LIMIT 30", [`%${tituloLimpo}%`], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function enriquecerTMDB(titulo, tipoPreferido = null) {
  // Detecta tipo pela pista Sxx na string original
  let tipo = tipoPreferido || (/S\d{1,2}/i.test(titulo) ? 'tv' : 'movie');
  const q = limparTitulo(titulo);

  // Busca
  const searchURL = `https://api.themoviedb.org/3/search/${tipo}`;
  const params = { api_key: TMDB_API_KEY, query: q, include_adult: false, language: "pt-BR" };
  const { data } = await axios.get(searchURL, { params });
  if (!data?.results?.length) return null;
  const r0 = data.results[0];

  // Se for TV, buscar detalhes p/ temporadas
  let temporadas = null;
  if (tipo === 'tv') {
    const tvURL = `https://api.themoviedb.org/3/tv/${r0.id}`;
    const { data: tvd } = await axios.get(tvURL, { params: { api_key: TMDB_API_KEY, language: "pt-BR" } });
    temporadas = tvd?.number_of_seasons ?? null;
  }

  return {
    titulo: r0.title || r0.name || q,
    sinopse: r0.overview || "Sem sinopse no TMDB.",
    poster: r0.poster_path ? `https://image.tmdb.org/t/p/w500${r0.poster_path}` : null,
    lancamento: r0.release_date || r0.first_air_date || "—",
    temporadas
  };
}

async function responderCatalogo(termo) {
  const resultados = await buscarNoCatalogoAsync(termo);
  if (!resultados.length) {
    return `❌ Não encontrei nenhum título no catálogo contendo: "${termo}".\nEnvie outro nome, ou *voltar* para o menu.`;
  }
  const primeiro = resultados[0].titulo;
  const info = await enriquecerTMDB(primeiro);
  if (!info) {
    return `✅ Encontrei no catálogo: ${primeiro}\nMas não localizei detalhes no TMDB.`;
  }
  let resp = `🎬 *${info.titulo}*\n\n${info.sinopse}\n\n`;
  if (info.lancamento) resp += `📅 Lançamento: ${info.lancamento}\n`;
  if (info.temporadas != null) resp += `📺 Temporadas: ${info.temporadas}\n`;
  if (info.poster) resp += `${info.poster}\n`;
  resp += `\nQuer *pesquisar outro título* ou *voltar ao menu*?`;
  return resp;
}

// ======= Gemini (API oficial v1beta) =======
async function chamarGemini(mensagem, systemHint = null) {
  if (!GEMINI_API_KEY) {
    return "Serviço temporariamente indisponível (GEMINI_API_KEY ausente).";
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const parts = [];
  if (systemHint) parts.push({ text: systemHint });
  parts.push({ text: mensagem });

  try {
    const { data } = await axios.post(url, {
      contents: [{ role: "user", parts }]
    }, {
      headers: { "Content-Type": "application/json" }
    });

    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return txt || "Desculpe, não consegui responder agora.";
  } catch (err) {
    console.error("Erro detalhado Gemini:", err.response?.data || err.message);
    return "Desculpe, não consegui responder agora.";
  }
}

// ======= Webhook =======
app.post('/webhook', async (req, res) => {
  const query = req.body?.queryResult?.queryText || "";
  const contexts = req.body?.queryResult?.outputContexts || [];
  const intentName = req.body?.queryResult?.intent?.displayName || "";

  // Tenta extrair contexto do menu (convenção antiga sua)
  const ctxMenu = contexts.find(c => (c.name || "").includes("menu_principal"));
  const opcaoCtx = ctxMenu?.parameters?.opcaoMenu ?? null;

  // Fallback: usuário digitou "1", "2", "3", "4"
  const opcaoDigitada = extrairOpcaoDigitada(query);

  // Comandos globais
  if (isGreeting(query) || /voltar|menu/i.test(query)) {
    return res.json({ fulfillmentText: formatMenu() });
  }

  // Roteamento principal
  const opcao = opcaoCtx || opcaoDigitada || null;

  try {
    if (opcao === 1) {
      const msg = [
        "🆕 *Novo Cliente*",
        "Bem-vindo! Para começar, me diga:",
        "• Seu nome completo",
        "• Seu e-mail",
        "• Cidade/Estado",
        "",
        "Depois te mando as opções de plano e período de teste 😉"
      ].join("\n");
      return res.json({ fulfillmentText: msg });
    }

    if (opcao === 2) {
      const msg = [
        "💳 *Pagamento (PIX)*",
        `Chave PIX: ${PIX_KEY}`,
        "Envie o comprovante por aqui para ativação mais rápida ✅",
        "",
        "Se preferir voltar, digite *menu*."
      ].join("\n");
      return res.json({ fulfillmentText: msg });
    }

    if (opcao === 3) {
      const hint = "Você é um atendente educado da Dani IPTV. Responda curto e objetivo. Se o cliente pedir menu, retorne apenas o menu principal de opções (1 a 4).";
      const r = await chamarGemini(query, hint);
      return res.json({ fulfillmentText: r });
    }

    if (opcao === 4) {
      const termo = limparTitulo(query);
      if (!termo || isGreeting(termo) || /^\d$/.test(termo)) {
        return res.json({ fulfillmentText: "📚 *Catálogo*: envie o nome do filme/série que deseja buscar." });
      }
      const r = await responderCatalogo(termo);
      return res.json({ fulfillmentText: r });
    }

    // Sem opção ativa: usa Gemini como small talk/QA
    const fallbackHint = "Você é um atendente da Dani IPTV. Seja cordial, PT-BR. Se o usuário parecer perdido, sugira o Menu Principal com as opções 1 a 4.";
    const resposta = await chamarGemini(query, fallbackHint);
    return res.json({ fulfillmentText: resposta });

  } catch (e) {
    console.error("Erro no webhook:", e);
    return res.json({ fulfillmentText: "Houve um erro ao processar sua solicitação. Tente novamente." });
  }
});

// Healthcheck opcional (GET /)
app.get('/', (_req, res) => {
  res.status(200).send('OK - Dani IPTV Webhook');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook rodando na porta ${PORT}`);
});
