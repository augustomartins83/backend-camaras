module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "ANTHROPIC_API_KEY nao configurada." });

  const { tema, casas, ano } = req.body || {};
  if (!tema) return res.status(400).json({ erro: "Informe um tema." });
  if (!Array.isArray(casas) || !casas.length) return res.status(400).json({ erro: "Selecione casas legislativas." });

  const anoFiltro = ano ? parseInt(ano) : null;
  const lista = casas.slice(0, 10).map(c => c.tipo === "assembleia" ? `Assembleia Legislativa de ${c.estado} (${c.uf})` : `Câmara Municipal de ${c.cidade}/${c.uf}`).join("; ");
  const anoTexto = anoFiltro ? `Priorize fortemente projetos do ano ${anoFiltro}. Só inclua projetos de outros anos se não houver nada de ${anoFiltro}.` : "Priorize projetos mais recentes.";

  const prompt = `Você é especialista em legislação brasileira. Liste projetos de lei ou leis sobre "${tema}" nas seguintes casas legislativas: ${lista}.

${anoTexto}

Para cada projeto, forneça:
- titulo: título ou ementa completa
- casa: nome da casa legislativa (ex: "Câmara Municipal de Joinville/SC" ou "ALESP - São Paulo/SP")  
- tipo: "camara" ou "assembleia"
- uf: sigla do estado
- cidade: nome da cidade (para câmaras) ou capital do estado (para assembleias)
- numero: número do projeto ou lei (ex: "PL 123/2026" ou "Lei 4567/2025")
- ano: ano do projeto (número inteiro)
- resumo: resumo de 2-3 frases do conteúdo
- num_apenas: somente o número sem letras (ex: "123")

Responda SOMENTE com JSON válido sem markdown:
[{"titulo":"...","casa":"...","tipo":"camara","uf":"...","cidade":"...","numero":"...","ano":2026,"resumo":"...","num_apenas":"..."}]`;

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
        max_tokens: 2048,
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
      if (ini >= 0 && fim > ini) {
        resultados = JSON.parse(texto.slice(ini, fim + 1));
        // Filtrar por ano se especificado
        if (anoFiltro) {
          const doAno = resultados.filter(r => r.ano === anoFiltro);
          if (doAno.length > 0) resultados = doAno;
        }
      }
    } catch (e) {
      console.log("Parse error:", texto.substring(0, 300));
    }

    return res.status(200).json({ resultados, tema, ano: anoFiltro, totalCasas: casas.length });

  } catch (err) {
    clearTimeout(timer);
    return res.status(500).json({
      erro: err.name === "AbortError" ? "Timeout - tente com menos casas selecionadas" : err.message
    });
  }
};
