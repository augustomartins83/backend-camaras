const https = require("https");

function chamarClaude(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }]
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      },
      timeout: 20000
    }, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: raw }));
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout na API")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "ANTHROPIC_API_KEY não configurada." });

  const { tema, cidades } = req.body || {};
  if (!tema || !tema.trim()) return res.status(400).json({ erro: "Informe um tema." });
  if (!Array.isArray(cidades) || cidades.length === 0) return res.status(400).json({ erro: "Selecione pelo menos uma cidade." });

  const listaCidades = cidades.slice(0, 10).map(c => `${c.cidade}/${c.uf}`).join(", ");

  const prompt = `Você é especialista em legislação municipal brasileira. Liste projetos de lei ou leis municipais sobre "${tema}" em câmaras municipais de: ${listaCidades}.

Responda APENAS com JSON, sem texto adicional:
[{"titulo":"...","cidade":"Cidade/UF","numero":"...","resumo":"...","link":"https://..."}]`;

  try {
    const result = await chamarClaude(apiKey, prompt);

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      return res.status(result.status).json({
        erro: `Erro da API: ${err.error?.message || result.body.substring(0, 200)}`
      });
    }

    const data = JSON.parse(result.body);
    const texto = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

    let resultados = [];
    try {
      const ini = texto.indexOf("[");
      const fim = texto.lastIndexOf("]");
      if (ini >= 0 && fim > ini) resultados = JSON.parse(texto.slice(ini, fim + 1));
    } catch (e) {
      console.log("Parse error:", texto.substring(0, 300));
    }

    return res.status(200).json({ resultados, tema, totalCidades: cidades.length });

  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
};
