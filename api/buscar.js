// ============================================================
// Backend - Busca de Projetos de Lei em Câmaras Municipais
// Endpoint serverless (Vercel) que chama a API da Anthropic
// com a ferramenta de busca na web habilitada.
//
// A chave da API fica SEGURA aqui no servidor (variável de
// ambiente ANTHROPIC_API_KEY), nunca exposta no navegador.
// ============================================================

export default async function handler(req, res) {
  // --- CORS: permite que seu site (GitHub Pages) chame este backend ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Navegador manda um OPTIONS antes do POST (preflight)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Use POST" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      erro: "Chave da API não configurada no servidor. Defina a variável de ambiente ANTHROPIC_API_KEY no Vercel.",
    });
  }

  try {
    const { tema, cidades } = req.body || {};

    if (!tema || !tema.trim()) {
      return res.status(400).json({ erro: "Informe um tema para buscar." });
    }
    if (!Array.isArray(cidades) || cidades.length === 0) {
      return res.status(400).json({ erro: "Selecione pelo menos uma cidade." });
    }

    // Monta a lista de cidades para o prompt
    const listaCidades = cidades
      .map((c) => `${c.cidade}/${c.uf}`)
      .join(", ");

    // Prompt: pede ao Claude para buscar projetos de lei REAIS
    // sobre o tema nas câmaras das cidades indicadas, e devolver
    // em JSON estruturado.
    const prompt = `Você é um assessor jurídico legislativo. Pesquise na web por PROJETOS DE LEI ou LEIS MUNICIPAIS REAIS sobre o tema "${tema}" nas câmaras municipais das seguintes cidades brasileiras: ${listaCidades}.

Para cada projeto/lei que encontrar, traga:
- titulo: título ou ementa resumida
- cidade: cidade de origem (formato "Cidade/UF")
- numero: número do projeto/lei se disponível (ou "N/D")
- resumo: um resumo de 1-2 frases sobre o que trata
- link: a URL da fonte onde você encontrou (link real do resultado de busca)

Busque resultados reais e verificáveis. Não invente projetos. Se não encontrar nada para uma cidade, simplesmente não a inclua.

Responda APENAS com um array JSON válido, sem nenhum texto antes ou depois, sem markdown, neste formato exato:
[{"titulo":"...","cidade":"...","numero":"...","resumo":"...","link":"..."}]

Se não encontrar nenhum resultado, responda: []`;

    // Chamada à API da Anthropic com busca na web habilitada
    const apiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", // modelo atual que suporta web search
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 8, // limita buscas por requisição (controla custo)
          },
        ],
      }),
    });

    if (!apiResp.ok) {
      const detalhe = await apiResp.text();
      return res.status(apiResp.status).json({
        erro: `Erro da API Anthropic (${apiResp.status})`,
        detalhe,
      });
    }

    const data = await apiResp.json();

    // A resposta pode ter vários blocos (texto + uso de ferramenta).
    // Pegamos só os blocos de texto e juntamos.
    const textoFinal = (data.content || [])
      .filter((bloco) => bloco.type === "text")
      .map((bloco) => bloco.text)
      .join("\n")
      .trim();

    // Tenta extrair o JSON da resposta
    let resultados = [];
    try {
      // Remove cercas de markdown se houver
      const limpo = textoFinal.replace(/```json|```/g, "").trim();
      // Encontra o array JSON dentro do texto
      const inicio = limpo.indexOf("[");
      const fim = limpo.lastIndexOf("]");
      if (inicio >= 0 && fim > inicio) {
        resultados = JSON.parse(limpo.slice(inicio, fim + 1));
      }
    } catch (e) {
      // Se não conseguir parsear, devolve o texto bruto para diagnóstico
      return res.status(200).json({
        resultados: [],
        aviso: "Não consegui estruturar os resultados. Resposta bruta abaixo.",
        textoBruto: textoFinal,
      });
    }

    return res.status(200).json({ resultados, tema, totalCidades: cidades.length });
  } catch (err) {
    return res.status(500).json({ erro: "Falha no servidor", detalhe: String(err) });
  }
}
