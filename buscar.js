module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "ANTHROPIC_API_KEY nao configurada." });

  const { tema, casas, ano, modo } = req.body || {};
  if (!casas || !casas.length) return res.status(400).json({ erro: "Selecione casas legislativas." });

  const anoFiltro = ano ? parseInt(ano) : null;
  const lista = casas.slice(0, 10).map(c =>
    c.tipo === "assembleia"
      ? "Assembleia Legislativa de " + c.estado + " (" + c.uf + ")"
      : "Camara Municipal de " + c.cidade + "/" + c.uf
  ).join("; ");

  let prompt;

  if (modo === "abrangente" || tema === "TEMAS_EM_ALTA") {
    // Modo: pesquisar automaticamente os melhores temas legislativos em alta
    const anoTexto = anoFiltro ? "Foque em projetos e temas do ano " + anoFiltro + "." : "Foque em projetos recentes de 2024 a 2026.";
    prompt = "Voce e um especialista em legislacao municipal brasileira. " + anoTexto + "\n\n" +
      "Liste os TEMAS LEGISLATIVOS MUNICIPAIS MAIS RELEVANTES E EM ALTA no Brasil atualmente, " +
      "identificando projetos de lei ou leis reais que exemplificam cada tema nas seguintes casas legislativas: " + lista + ".\n\n" +
      "Organize por tema. Para cada projeto encontrado, forneca:\n" +
      "- titulo: titulo ou ementa\n" +
      "- casa: nome da casa legislativa\n" +
      "- tipo: camara ou assembleia\n" +
      "- uf: sigla do estado\n" +
      "- cidade: nome da cidade (para camaras)\n" +
      "- numero: numero do projeto (ou Consultar camara)\n" +
      "- ano: ano do projeto (numero inteiro)\n" +
      "- resumo: resumo de 2 frases incluindo por que esse tema esta em alta\n" +
      "- num_apenas: somente o numero sem letras\n\n" +
      "Priorize temas como: saude mental, violencia contra mulher, meio ambiente, tecnologia publica, " +
      "seguranca alimentar, crianca e adolescente, mobilidade urbana, habitacao, transparencia.\n\n" +
      "Responda SOMENTE com JSON valido sem markdown:\n" +
      '[{"titulo":"...","casa":"...","tipo":"camara","uf":"...","cidade":"...","numero":"...","ano":2025,"resumo":"...","num_apenas":"..."}]';
  } else {
    // Modo: busca por tema específico
    if (!tema) return res.status(400).json({ erro: "Informe um tema." });
    const anoTexto = anoFiltro
      ? "Priorize fortemente projetos do ano " + anoFiltro + ". So inclua projetos de outros anos se nao houver nada de " + anoFiltro + "."
      : "Priorize projetos mais recentes.";

    prompt = "Voce e especialista em legislacao municipal brasileira. Liste projetos de lei ou leis sobre \"" + tema + "\" em: " + lista + ".\n\n" +
      anoTexto + "\n\n" +
      "Para cada projeto:\n" +
      "- titulo: titulo ou ementa\n" +
      "- casa: nome da casa legislativa\n" +
      "- tipo: camara ou assembleia\n" +
      "- uf: sigla do estado\n" +
      "- cidade: nome da cidade\n" +
      "- numero: numero do projeto\n" +
      "- ano: ano (numero inteiro)\n" +
      "- resumo: resumo de 2 frases\n" +
      "- num_apenas: somente o numero sem letras\n\n" +
      "Responda SOMENTE com JSON valido sem markdown:\n" +
      '[{"titulo":"...","casa":"...","tipo":"camara","uf":"...","cidade":"...","numero":"...","ano":2026,"resumo":"...","num_apenas":"..."}]';
  }

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
        if (anoFiltro && modo !== "abrangente") {
          const doAno = resultados.filter(r => r.ano === anoFiltro);
          if (doAno.length > 0) resultados = doAno;
        }
      }
    } catch (e) {
      console.log("Parse error:", texto.substring(0, 300));
    }

    return res.status(200).json({ resultados, tema: tema || "Temas em alta", ano: anoFiltro, totalCasas: casas.length, modo: modo || "especifico" });

  } catch (err) {
    clearTimeout(timer);
    return res.status(500).json({
      erro: err.name === "AbortError" ? "Timeout - tente com menos casas selecionadas" : err.message
    });
  }
};
