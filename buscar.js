module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "ANTHROPIC_API_KEY nao configurada." });

  const { tema, casas, ano, modo } = req.body || {};
  if (!casas || !casas.length) return res.status(400).json({ erro: "Selecione casas legislativas." });

  const anoFiltro = ano ? parseInt(ano) : null;

  // ── Selecionar casas representativas ──────────────────────────────────────
  // Com muitas casas selecionadas, priorizamos diversidade de UFs (máx. 20 casas).
  // Isso evita prompt gigante e timeout, mantendo cobertura nacional.
  let casasFiltradas = casas;
  if (casas.length > 20) {
    // Pegar até 2 casas por UF para maximizar diversidade
    const porUF = {};
    for (const c of casas) {
      const key = c.uf;
      if (!porUF[key]) porUF[key] = [];
      if (porUF[key].length < 2) porUF[key].push(c);
    }
    casasFiltradas = Object.values(porUF).flat().slice(0, 20);
  }

  const lista = casasFiltradas.map(c =>
    c.tipo === "assembleia"
      ? "Assembleia Legislativa de " + (c.estado || c.uf) + " (" + c.uf + ")"
      : "Camara Municipal de " + c.cidade + "/" + c.uf
  ).join("; ");

  // ── Lógica de ano ─────────────────────────────────────────────────────────
  // O modelo tem corte de treinamento ~2025. Para ano 2026, buscamos 2024-2026
  // e aceitamos qualquer resultado recente se não houver exatamente 2026.
  const anoAtual = new Date().getFullYear();
  const anoRef = anoFiltro || anoAtual;
  const anoInicio = anoRef - 2; // ex: 2026 → busca 2024-2026

  let prompt;

  if (modo === "abrangente" || tema === "TEMAS_EM_ALTA") {
    prompt = "Voce e um especialista em legislacao municipal brasileira com amplo conhecimento de projetos de lei aprovados e em tramitacao no Brasil.\n\n" +
      "Liste os TEMAS LEGISLATIVOS MUNICIPAIS MAIS RELEVANTES E EM ALTA no Brasil, " +
      "identificando projetos de lei ou leis reais que exemplificam cada tema nas seguintes casas legislativas: " + lista + ".\n\n" +
      "Priorize projetos dos anos " + anoInicio + " a " + anoRef + ". Se nao houver dados especificos dessas casas, " +
      "use exemplos de outras camaras brasileiras de porte similar.\n\n" +
      "Priorize temas como: saude mental, violencia contra mulher, meio ambiente, tecnologia publica, " +
      "seguranca alimentar, crianca e adolescente, mobilidade urbana, habitacao, transparencia.\n\n" +
      "Para cada projeto:\n" +
      "- titulo: titulo ou ementa completa\n" +
      "- casa: nome da casa legislativa\n" +
      "- tipo: camara ou assembleia\n" +
      "- uf: sigla do estado\n" +
      "- cidade: nome da cidade (para camaras)\n" +
      "- numero: numero do projeto (ex: PL 123/2024 — se nao souber exato, escreva Consultar camara)\n" +
      "- ano: ano do projeto (numero inteiro entre " + anoInicio + " e " + anoRef + ")\n" +
      "- resumo: resumo de 2 frases incluindo por que esse tema esta em alta\n" +
      "- num_apenas: somente os digitos do numero (sem PL, sem ano, sem barras)\n\n" +
      "Retorne pelo menos 5 e no maximo 15 projetos. " +
      "Responda SOMENTE com JSON valido sem markdown:\n" +
      '[{"titulo":"...","casa":"...","tipo":"camara","uf":"...","cidade":"...","numero":"...","ano":2025,"resumo":"...","num_apenas":"..."}]';
  } else {
    if (!tema) return res.status(400).json({ erro: "Informe um tema." });

    prompt = "Voce e especialista em legislacao municipal brasileira com amplo conhecimento de projetos de lei no Brasil.\n\n" +
      "Liste projetos de lei ou leis sobre \"" + tema + "\" nas seguintes casas legislativas: " + lista + ".\n\n" +
      "Priorize projetos dos anos " + anoInicio + " a " + anoRef + ". Se nao houver dados especificos dessas casas para esse periodo, " +
      "use exemplos de outras camaras municipais brasileiras de porte similar que trataram do tema.\n\n" +
      "Para cada projeto:\n" +
      "- titulo: titulo ou ementa completa\n" +
      "- casa: nome da casa legislativa\n" +
      "- tipo: camara ou assembleia\n" +
      "- uf: sigla do estado\n" +
      "- cidade: nome da cidade\n" +
      "- numero: numero do projeto (ex: PL 456/2024 — se nao souber exato, escreva Consultar camara)\n" +
      "- ano: ano do projeto (numero inteiro entre " + anoInicio + " e " + anoRef + ")\n" +
      "- resumo: resumo de 2 frases explicando o que a lei faz\n" +
      "- num_apenas: somente os digitos do numero (sem PL, sem ano, sem barras)\n\n" +
      "Retorne pelo menos 5 e no maximo 20 projetos. " +
      "Responda SOMENTE com JSON valido sem markdown:\n" +
      '[{"titulo":"...","casa":"...","tipo":"camara","uf":"...","cidade":"...","numero":"...","ano":2024,"resumo":"...","num_apenas":"..."}]';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

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
        max_tokens: 4096,
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

        // ── Filtro de ano com fallback ───────────────────────────────────────
        // Se selecionou um ano específico, tenta filtrar — mas não descarta tudo.
        if (anoFiltro && modo !== "abrangente") {
          const exato = resultados.filter(r => r.ano === anoFiltro);
          const recente = resultados.filter(r => typeof r.ano === "number" && r.ano >= anoInicio);
          if (exato.length > 0) {
            resultados = exato;
          } else if (recente.length > 0) {
            // Nenhum exatamente do ano pedido, mas há resultados recentes — aceita
            resultados = recente;
          }
          // Se nem recente houver, mantém todos (melhor ter algo do que nada)
        }
      }
    } catch (e) {
      console.log("Parse error:", texto.substring(0, 300));
      // Retorna erro com fragmento do texto para diagnóstico
      return res.status(200).json({
        resultados: [],
        tema: tema || "Temas em alta",
        ano: anoFiltro,
        totalCasas: casas.length,
        modo: modo || "especifico",
        aviso: "O modelo retornou resposta fora do formato esperado."
      });
    }

    return res.status(200).json({
      resultados,
      tema: tema || "Temas em alta",
      ano: anoFiltro,
      totalCasas: casas.length,
      casasConsultadas: casasFiltradas.length,
      modo: modo || "especifico"
    });

  } catch (err) {
    clearTimeout(timer);
    return res.status(500).json({
      erro: err.name === "AbortError"
        ? "Timeout - o modelo demorou demais. Tente com menos casas selecionadas."
        : err.message
    });
  }
};
