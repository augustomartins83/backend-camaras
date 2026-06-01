module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "ANTHROPIC_API_KEY nao configurada." });

  const { tema, cidades } = req.body || {};
  if (!tema) return res.status(400).json({ erro: "Informe um tema." });
  if (!Array.isArray(cidades) || !cidades.length) return res.status(400).json({ erro: "Selecione cidades." });

  const lista = cidades.slice(0, 8).map(c => `${c.cidade}/${c.uf}`).join(", ");

  const prompt = `Liste projetos de lei municipais brasileiros sobre "${tema}" nas cidades: ${lista}. Responda SOMENTE com JSON sem markdown: [{"titulo":"...","cidade":"Cidade/UF","numero":"...","resumo":"...","link":"https://..."}]`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }]
      })
    });

    clearTimeout(timer);

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({ erro: data.error?.message || "Erro na API Anthropic" });
    }

    const texto = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

    let resultados = [];
    try {
      const ini = texto.indexOf("[");
      const fim = texto.lastIndexOf("]");
      if (ini >= 0 && fim > ini) resultados = JSON.parse(texto.slice(ini, fim + 1));
    } catch (e) {
      console.log("Parse error:", texto.substring(0, 200));
    }

    return res.status(200).json({ resultados, tema, totalCidades: cidades.length });

  } catch (err) {
    clearTimeout(timer);
    return res.status(500).json({
      erro: err.name === "AbortError" ? "Timeout - API demorou mais de 22s" : err.message
    });
  }
};
