// Radar RI - sync diario: Google Sheets (cotacoes + quantidade de acoes) e FRED (US5Y/US10Y) -> Supabase
//
// Roda via `npm run sync`. Precisa das variaveis de ambiente descritas em .env.example
// (localmente via arquivo .env, em producao via Secrets do GitHub Actions).
//
// Este script e idempotente: pode rodar quantas vezes quiser que so faz upsert
// (nao duplica linhas nem apaga historico).

import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SHEET_ID,
  SHEET_GID_COTACOES,
  SHEET_GID_COTACOES_HISTORICO,
  SHEET_GID_ACOES,
  SHEET_GID_SHARES_HISTORY,
  SHEET_GID_IR_LINKS,
  FRED_API_KEY,
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Variavel de ambiente ausente: ${name}. Veja .env.example.`);
  }
  return value;
}

requireEnv("SUPABASE_URL", SUPABASE_URL);
requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
requireEnv("SHEET_ID", SHEET_ID);
requireEnv("SHEET_GID_COTACOES", SHEET_GID_COTACOES);
requireEnv("SHEET_GID_COTACOES_HISTORICO", SHEET_GID_COTACOES_HISTORICO);
requireEnv("SHEET_GID_ACOES", SHEET_GID_ACOES);
requireEnv("SHEET_GID_SHARES_HISTORY", SHEET_GID_SHARES_HISTORY);
requireEnv("SHEET_GID_IR_LINKS", SHEET_GID_IR_LINKS);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// CSV parsing (aceita campos entre aspas, virgulas e quebras de linha dentro de aspas)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ""));
}

async function fetchSheetCsv(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Falha ao baixar a aba (gid=${gid}): HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseCsv(text);
}

// ---------------------------------------------------------------------------
// Parsing de numeros no formato BR ("R$ 1.234,56", "17.258.800", "-5,12") e datas M/D/YYYY
// ---------------------------------------------------------------------------
const INVALID_TOKENS = new Set(["#N/A", "#N/D", "#VALUE!", "#REF!", "#DIV/0!", "", "-"]);

function parseBrNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (INVALID_TOKENS.has(s)) return null;
  const cleaned = s.replace(/[^\d,.\-]/g, "");
  if (!cleaned) return null;
  const normalized = cleaned.split(".").join("").replace(",", ".");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseUsDate(raw) {
  const s = String(raw ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Layout fixo das colunas da aba de cotacoes (confirmado a partir do CSV real).
// Cada ticker de acao/cripto ocupa 3 colunas: preco, volume, volume financeiro.
// No fim da planilha vem uma coluna unica por ativo (indices, cripto, cambio).
// ---------------------------------------------------------------------------
const TRIPLE_TICKERS = [
  "CASH3", "TOTS3", "BMOB3", "LWSA3", "DOTZ3", "INTB3", "IBTA",
  "AMER3", "MGLU3", "ALPA4", "BHIA3", "RADL3", "MELI", "AZZA3",
  "OBTC3", "MSTR", "XYZ", "ALCPB", "MTPLF",
];
const SINGLE_TICKERS = ["IBOV", "IXIC", "BTCBRL", "BTCUSD", "USDBRL", "EURBRL"];

function syncMarketDataRows(rows) {
  // linha 0: categorias, linha 1: tickers, linha 2: lixo de formula quebrada -> ignoradas.
  // dados de verdade comecam quando a coluna A e uma data valida (M/D/YYYY).
  const out = [];
  for (const cols of rows) {
    const tradeDate = parseUsDate(cols[0]);
    if (!tradeDate) continue; // pula cabecalhos e linhas invalidas

    let col = 1;
    for (const ticker of TRIPLE_TICKERS) {
      const price = parseBrNumber(cols[col]);
      const volume = parseBrNumber(cols[col + 1]);
      const financialVolume = parseBrNumber(cols[col + 2]);
      col += 3;
      if (price == null && volume == null && financialVolume == null) continue;
      out.push({ ticker, trade_date: tradeDate, price, volume, financial_volume: financialVolume });
    }
    for (const ticker of SINGLE_TICKERS) {
      const price = parseBrNumber(cols[col]);
      col += 1;
      if (price == null) continue;
      out.push({ ticker, trade_date: tradeDate, price, volume: null, financial_volume: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aba "Quantidade de acoes para calcular mkt cap": nome de exibicao -> ticker
// ---------------------------------------------------------------------------
const DISPLAY_NAME_TO_TICKER = {
  "MELIUZ": "CASH3",
  "BEMOBI": "BMOB3",
  "LOCAWEB": "LWSA3",
  "TOTVS": "TOTS3",
  "DOTZ": "DOTZ3",
  "INTELBRAS": "INTB3",
  "IBOTTA": "IBTA",
  "AMERICANAS": "AMER3",
  "MAGAZINE LUIZA": "MGLU3",
  "ALPARGATAS": "ALPA4",
  "GRUPO CASAS BAHIA": "BHIA3",
  "RAIADROGASIL": "RADL3",
  "MERCADO LIVRE": "MELI",
  "AZZAS 2154": "AZZA3",
  "ORANJEBTC": "OBTC3",
  "STRATEGY": "MSTR",
  "BLOCK INC": "XYZ",
  "CAPITAL B (BLOCKCHAIN GROUP)": "ALCPB",
  "METAPLANET": "MTPLF",
};

function normalizeName(raw) {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function syncSharesOutstandingRows(rows) {
  const out = [];
  let asOfDate = null;

  for (const cols of rows) {
    const dateMatch = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(cols[2] ?? "");
    if (dateMatch) {
      const [, dd, mm, yyyy] = dateMatch;
      asOfDate = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    }

    const name = normalizeName(cols[0]);
    const ticker = DISPLAY_NAME_TO_TICKER[name];
    if (!ticker) continue;

    const shares = parseBrNumber(cols[1]);
    const marketCapOverride = parseBrNumber(cols[2]);
    if (shares == null && marketCapOverride == null) continue;

    out.push({
      ticker,
      shares: shares ?? null,
      market_cap_override: shares == null ? marketCapOverride : null,
      as_of_date: asOfDate,
      updated_at: new Date().toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aba "historico de qtde de acoes": data da mudanca -> nova qtde de acoes (CASH3).
// A aba nao tem coluna de empresa (e so da Meliuz), entao o ticker fica fixo.
// Quando ha mais de uma mudanca no mesmo dia, fica valendo a ultima da planilha.
// ---------------------------------------------------------------------------
function syncSharesHistoryRows(rows) {
  const byDate = new Map();
  for (const cols of rows) {
    const dateMatch = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(cols[0] ?? "");
    if (!dateMatch) continue; // pula cabecalho
    const [, dd, mm, yyyy] = dateMatch;
    const effectiveDate = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    const shares = parseBrNumber(cols[1]);
    if (shares == null) continue;
    byDate.set(effectiveDate, shares);
  }
  return Array.from(byDate, ([effective_date, shares]) => ({ ticker: "CASH3", effective_date, shares }));
}

// ---------------------------------------------------------------------------
// Aba "Site RI": nome de exibicao -> link do site de relacoes com investidores.
// Reaproveita o mesmo de-para nome->ticker da aba de quantidade de acoes.
// ---------------------------------------------------------------------------
function buildIrLinkUpdates(rows) {
  const out = [];
  for (const cols of rows) {
    const name = normalizeName(cols[0]);
    const ticker = DISPLAY_NAME_TO_TICKER[name];
    const url = String(cols[1] ?? "").trim();
    if (!ticker || !url) continue;
    out.push({ ticker, ir_url: url });
  }
  return out;
}

async function updateIrLinks(updates) {
  for (const { ticker, ir_url } of updates) {
    const { error } = await supabase.from("instruments").update({ ir_url }).eq("ticker", ticker);
    if (error) throw new Error(`Erro ao atualizar ir_url de ${ticker}: ${error.message}`);
  }
  console.log(`[supabase] instruments.ir_url: ${updates.length} link(s) atualizados.`);
}

// ---------------------------------------------------------------------------
// FRED: US Treasury 5Y (DGS5) e 10Y (DGS10)
// ---------------------------------------------------------------------------
async function fetchFredSeries(seriesId) {
  // Endpoint publico (sem chave). Se parar de funcionar, cai para a API oficial
  // (precisa de FRED_API_KEY, gratuita em https://fred.stlouisfed.org/docs/api/api_key.html).
  try {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    const [, ...dataRows] = rows; // primeira linha = cabecalho ("DATE",SERIES_ID)
    return dataRows
      .map(([date, value]) => ({
        series_id: seriesId,
        obs_date: date,
        value: value === "." ? null : parseFloat(value),
      }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.obs_date));
  } catch (err) {
    if (!FRED_API_KEY) {
      console.warn(`[fred] falha ao buscar ${seriesId} via fredgraph.csv e FRED_API_KEY nao definida:`, err.message);
      return [];
    }
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[fred] falha ao buscar ${seriesId} via API oficial: HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    return (json.observations ?? []).map((o) => ({
      series_id: seriesId,
      obs_date: o.date,
      value: o.value === "." ? null : parseFloat(o.value),
    }));
  }
}

// ---------------------------------------------------------------------------
// Upsert em lotes (Supabase aceita arrays grandes, mas quebramos por seguranca)
// ---------------------------------------------------------------------------
async function upsertInChunks(table, rows, conflictKeys, chunkSize = 500) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict: conflictKeys });
    if (error) throw new Error(`Erro no upsert de ${table}: ${error.message}`);
  }
  console.log(`[supabase] ${table}: ${rows.length} linha(s) sincronizada(s).`);
}

async function main() {
  console.log("== Radar RI: sync de dados de mercado ==");

  console.log("[1/6] Baixando aba de cotacoes...");
  const cotacoesRows = await fetchSheetCsv(SHEET_GID_COTACOES);
  const marketDataRows = syncMarketDataRows(cotacoesRows);
  await upsertInChunks("market_data_daily", marketDataRows, "ticker,trade_date");

  // Aba auxiliar com valores fixos (sem formula), cobrindo o trecho antigo do
  // historico ate 19/05/2025. A aba de cotacoes normal usa uma formula GOOGLEFINANCE
  // por celula que, em blocos grandes de historico, as vezes retorna #N/A so na
  // exportacao (mesmo aparecendo certo na tela) - essa aba serve de reforco: como
  // linhas com #N/A sao puladas (nao geram upsert), ela nunca sobrescreve um valor
  // bom com um valor ruim, so preenche o que a formula deixou faltando.
  console.log("[2/6] Baixando aba de cotacoes historicas (valores fixos, ate 19/05/2025)...");
  const historicoRows = await fetchSheetCsv(SHEET_GID_COTACOES_HISTORICO);
  const historicoMarketDataRows = syncMarketDataRows(historicoRows);
  await upsertInChunks("market_data_daily", historicoMarketDataRows, "ticker,trade_date");

  console.log("[3/6] Baixando aba de quantidade de acoes (snapshot atual)...");
  const acoesRows = await fetchSheetCsv(SHEET_GID_ACOES);
  const sharesRows = syncSharesOutstandingRows(acoesRows);
  await upsertInChunks("shares_outstanding", sharesRows, "ticker");

  console.log("[4/6] Baixando aba de historico de qtde de acoes (CASH3)...");
  const sharesHistoryRows = await fetchSheetCsv(SHEET_GID_SHARES_HISTORY);
  const sharesHistory = syncSharesHistoryRows(sharesHistoryRows);
  await upsertInChunks("shares_outstanding_history", sharesHistory, "ticker,effective_date");

  console.log("[5/6] Baixando aba de links de RI...");
  const irRows = await fetchSheetCsv(SHEET_GID_IR_LINKS);
  const irUpdates = buildIrLinkUpdates(irRows);
  await updateIrLinks(irUpdates);

  console.log("[6/6] Baixando series do FRED (US5Y / US10Y)...");
  const dgs5 = await fetchFredSeries("DGS5");
  const dgs10 = await fetchFredSeries("DGS10");
  await upsertInChunks("treasury_yields", [...dgs5, ...dgs10], "series_id,obs_date");

  console.log("== Sync concluido com sucesso ==");
}

main().catch((err) => {
  console.error("Sync falhou:", err);
  process.exit(1);
});
