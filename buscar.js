// api/buscar.js — busca REAL via Google News RSS + LegisMunicipais + IA como fallback
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "ANTHROPIC_API_KEY nao configurada." });

  const { tema, casas, ano, modo } = req.body || {};
  if (!casas || !casas.length) return res.status(400).json({ erro: "Selecione casas legislativas." });
  if (modo !== "abrangente" && !tema) return res.status(400).json({ erro: "Informe um tema." });

  const anoFiltro = ano ? parseInt(ano) : null;

  // ── Selecionar casas representativas (max 8 para buscas reais) ──────────
  let casasFiltradas = casas;
  if (casas.length > 8) {
    const porUF = {};
    for (const c of casas) {
      if (!porUF[c.uf]) porUF[c.uf] = [];
      if (porUF[c.uf].length < 1) porUF[c.uf].push(c);
    }
    casasFiltradas = Object.values(porUF).flat().slice(0, 8);
  }

  const temaFinal = modo === "abrangente" ? "legislacao municipal em destaque" : tema;

  // ── Funções de busca ────────────────────────────────────────────────────

  // Busca no Google News RSS (gratuito, sem chave API)
  async function searchGoogleNews(query) {
    try {
      const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) +
        "&hl=pt-BR&gl=BR&ceid=BR:pt-419&num=10";
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LegalResearch/1.0)" },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) return [];
      const xml = await r.text();
      const items = [];
      const re = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = re.exec(xml)) !== null && items.length < 8) {
        const block = m[1];
        const title = extractCDATA(block, "title") || extractTag(block, "title");
        const link = extractTag(block, "link");
        const desc = extractCDATA(block, "description") || extractTag(block, "description");
        const pubDate = extractTag(block, "pubDate") || "";
        if (title && link) items.push({ titulo: cleanHtml(title), url: link.trim(), resumo: cleanHtml(desc || ""), pubDate });
      }
      return items;
    } catch (e) { return []; }
  }

  // Gera URLs diretas do LegisMunicipais para busca manual
  function gerarLinkLegis(city, uf, topico) {
    const cidadeSlug = city.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const ufLower = uf.toLowerCase();
    const q = encodeURIComponent(topico);
    return "https://leismunicipais.com.br/legislacao-municipal/" + cidadeSlug + "/" + ufLower + "?q=" + q;
  }

  // Gera URL do Google Search direcionado à câmara
  function gerarLinkGoogle(city, uf, topico) {
    const q = encodeURIComponent('lei "' + topico + '" camara municipal ' + city + ' ' + uf);
    return "https://www.google.com/search?q=" + q;
  }

  // Helpers de parsing XML
  function extractCDATA(text, tag) {
    const re = new RegExp("<" + tag + "><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/" + tag + ">", "i");
    const m = re.exec(text); return m ? m[1].trim() : null;
  }
  function extractTag(text, tag) {
    const re = new RegExp("<" + tag + ">([^<]*)<\\/" + tag + ">", "i");
    const m = re.exec(text); return m ? m[1].trim() : null;
  }
  function cleanHtml(str) {
    return (str || "").replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<")
      .replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/&nbsp;/g," ").trim();
  }

  // ── Realizar buscas reais ───────────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    // Buscar notícias para cada casa/UF selecionada
    const newsPromises = casasFiltradas.map(async (c) => {
      const local = c.tipo === "assembleia"
        ? "assembleia legislativa " + (c.estado || c.uf)
        : "camara municipal " + c.cidade + " " + c.uf;
      const q = temaFinal + " lei " + local + (anoFiltro ? " " + anoFiltro : "");
      const noticias = await searchGoogleNews(q);
      return { casa: c, noticias };
    });

    // Busca geral nacional também
    const qGeral = "lei municipal " + temaFinal + " projeto camara" + (anoFiltro ? " " + anoFiltro : "");
    newsPromises.push(Promise.resolve({ casa: null, noticias: await searchGoogleNews(qGeral) }));

    const newsResults = await Promise.all(newsPromises);
    clearTimeout(timer);

    // Consolidar todas as notícias encontradas
    const todasNoticias = [];
    const urlsVistas = new Set();
    for (const r of newsResults) {
      for (const n of r.noticias) {
        if (!urlsVistas.has(n.url)) {
          urlsVistas.add(n.url);
          todasNoticias.push({ ...n, casa: r.casa });
        }
      }
    }

    // Preparar links diretos às câmaras selecionadas
    const linksDiretos = casasFiltradas.map(c => ({
      nome: c.tipo === "assembleia"
        ? "Assembleia Legislativa " + (c.estado || c.uf)
        : "Câmara Municipal de " + c.cidade + "/" + c.uf,
      legis: c.tipo !== "assembleia" ? gerarLinkLegis(c.cidade, c.uf, temaFinal) : null,
      google: c.tipo !== "assembleia" ? gerarLinkGoogle(c.cidade, c.uf, temaFinal) : gerarLinkGoogle(c.estado || c.uf, c.uf, temaFinal),
      legisweb: "https://www.legisweb.com.br/legislacao/?busca=" + encodeURIComponent(temaFinal) + "&estado=" + c.uf
    }));

    // Se encontrou notícias, usar IA para extrair referências de leis dos títulos/resumos
    let resultadosEnriquecidos = [];
    if (todasNoticias.length > 0) {
      const listaParaIA = todasNoticias.slice(0, 15).map((n, i) =>
        (i + 1) + '. TITULO: "' + n.titulo + '" | LINK: ' + n.url + ' | RESUMO: "' + (n.resumo || "").slice(0, 200) + '"'
      ).join("\n");

      const promptIA = "Analise estas noticias sobre legislacao municipal brasileira sobre \"" + temaFinal + "\".\n\n" +
        listaParaIA + "\n\n" +
        "Para cada noticia que menciona uma lei, projeto de lei ou decreto municipal especifico, extraia:\n" +
        "- titulo: nome/ementa da lei ou do projeto mencionado na noticia\n" +
        "- numero: numero da lei ou projeto (ex: Lei 1234/2024, PL 56/2023 — se nao aparecer, escreva nao informado)\n" +
        "- ano: ano em formato numerico inteiro (ex: 2024)\n" +
        "- cidade: cidade/municipio mencionado\n" +
        "- uf: sigla do estado (2 letras)\n" +
        "- resumo: o que essa lei faz em 1-2 frases claras\n" +
        "- url_noticia: o LINK original exato da noticia (copie sem modificar)\n" +
        "- tipo: camara ou assembleia\n\n" +
        "Inclua apenas noticias que realmente mencionem leis concretas. Ignore noticias genericas.\n" +
        "Responda SOMENTE com JSON valido sem markdown:\n" +
        '[{"titulo":"...","numero":"Lei 123/2024","ano":2024,"cidade":"...","uf":"SP","resumo":"...","url_noticia":"https://...","tipo":"camara"}]';

      const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 3000,
          messages: [{ role: "user", content: promptIA }]
        })
      });

      if (aiResp.ok) {
        const aiData = await aiResp.json();
        const textoIA = (aiData.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
        try {
          const ini = textoIA.indexOf("[");
          const fim = textoIA.lastIndexOf("]");
          if (ini >= 0 && fim > ini) {
            resultadosEnriquecidos = JSON.parse(textoIA.slice(ini, fim + 1));
            // Filtro de ano suave
            if (anoFiltro) {
              const exato = resultadosEnriquecidos.filter(r => r.ano === anoFiltro);
              if (exato.length > 0) resultadosEnriquecidos = exato;
            }
            // Adicionar campos de busca a cada resultado
            resultadosEnriquecidos = resultadosEnriquecidos.map(r => ({
              ...r,
              casa: r.tipo === "assembleia"
                ? "Assembleia Legislativa de " + r.uf
                : "Câmara Municipal de " + r.cidade + "/" + r.uf,
              num_apenas: (r.numero || "").replace(/[^0-9]/g, ""),
              link_legis: r.cidade ? gerarLinkLegis(r.cidade, r.uf, temaFinal) : null,
              link_google: gerarLinkGoogle(r.cidade || r.uf, r.uf, r.titulo || temaFinal)
            }));
          }
        } catch (e) { /* parseError, sem resultados enriquecidos */ }
      }
    }

    return res.status(200).json({
      resultados: resultadosEnriquecidos,
      noticiasEncontradas: todasNoticias.length,
      linksDiretos,
      tema: temaFinal,
      ano: anoFiltro,
      totalCasas: casas.length,
      casasConsultadas: casasFiltradas.length,
      modo: modo || "especifico",
      fonteReal: todasNoticias.length > 0
    });

  } catch (err) {
    clearTimeout(timer);
    return res.status(500).json({
      erro: err.name === "AbortError"
        ? "Timeout. Tente com menos casas selecionadas."
        : err.message
    });
  }
};
