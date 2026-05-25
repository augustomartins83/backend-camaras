// Backend serverless — Vercel
// Usa https nativo (funciona em qualquer versão do Node.js)

const https = require("https");

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ erro: "ANTHROPIC_API_KEY não configurada no Vercel." });
  }

  const { tema, cidades } = req.body || {};
  if (!tema || !tema.trim()) return res.status(400).json({ erro: "Informe um tema." });
  if (!Array.isArray(cidades) || cidades.length === 0) return res.status(400).json({ erro: "Selecione pelo menos uma cidade." });

  const listaCidades = cidades.map(c => `${c.cidade}/${c.uf}`).join(", ");

  const prompt = `Você é um assessor jurídico legislativo. Pesquise na web por PROJETOS DE LEI ou LEIS MUNICIPAIS REAIS sobre o tema "${tema}" nas câmaras municipais das seguintes cidades brasileiras: ${listaCidades}.

Para cada projeto/lei que encontrar, traga:
- titulo: título ou ementa resumida
- cidade: cidade de origem (formato "Cidade/UF")
- numero: número do projeto/lei se disponível (ou "N/D")
- resumo: um resumo de 1-2 frases sobre o que trata
- link: a URL da fonte onde você encontrou (link real)

Busque resultados reais e verificáveis. Não invente projetos.
Responda APENAS com um array JSON válido, sem markdown:
[{"titulo":"...","cidade":"...","numero":"...","resumo":"...","link":"..."}]
Se não encontrar nada, responda: []`;

  try {
    const apiResult = await httpsPost(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]
      },
      {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    );

    if (apiResult.status !== 200) {
      return res.status(apiResult.status).json({
        erro: `Erro da API Anthropic (${apiResult.status})`,
        detalhe: apiResult.body
      });
    }

    const data = JSON.parse(apiResult.body);
    const textoFinal = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n").trim();

    let resultados = [];
    try {
      const limpo = textoFinal.replace(/```json|```/g, "").trim();
      const inicio = limpo.indexOf("[");
      const fim = limpo.lastIndexOf("]");
      if (inicio >= 0 && fim > inicio) {
        resultados = JSON.parse(limpo.slice(inicio, fim + 1));
      }
    } catch (e) {
      return res.status(200).json({ resultados: [], aviso: "Não foi possível estruturar os resultados.", textoBruto: textoFinal });
    }

    return res.status(200).json({ resultados, tema, totalCidades: cidades.length });

  } catch (err) {
    return res.status(500).json({ erro: "Falha no servidor", detalhe: String(err) });
  }
};
