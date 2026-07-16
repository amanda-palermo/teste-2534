// Radar RI - Painel CASH3 > Visao Geral
// Le tudo do Supabase (populado pelo GitHub Actions a partir da planilha + FRED).
// Nao ha nenhum dado mockado aqui: onde a informacao ainda nao existe (base de
// acionistas, free float), a tela mostra um traco em vez de inventar um numero.
//
// Tudo na tela (KPIs, graficos, tabela de peers) e recalculado a partir da
// data escolhida no seletor: mudar a data recorta todas as series ate aquele
// dia e redesenha a pagina inteira "como se aquele fosse o dia atual".

const MONTH_LOOKBACK = 21;  // ~1 mes de pregoes
const YEAR_LOOKBACK = 252;  // ~12 meses de pregoes
const HISTORY_LIMIT = 280;  // pregoes buscados por ticker (~13 meses)

const cfg = window.RADAR_RI_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------------
// Formatacao
// ---------------------------------------------------------------------------
function currencySymbol(currency) {
  return currency === "USD" ? "US$ " : currency === "EUR" ? "€ " : "R$ ";
}
function fmtPrice(value, currency) {
  if (value == null || !isFinite(value)) return "—";
  return currencySymbol(currency) + value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(value) {
  if (value == null || !isFinite(value)) return "—";
  return Math.round(value).toLocaleString("pt-BR");
}
function fmtPct(value, digits = 1) {
  if (value == null || !isFinite(value)) return "—";
  const s = (value * 100).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (value > 0 ? "+" : "") + s + "%";
}
function fmtMoneyAuto(value, currency) {
  if (value == null || !isFinite(value)) return "—";
  const symbol = currencySymbol(currency);
  if (Math.abs(value) >= 1e9) return symbol + (value / 1e9).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " bi";
  return symbol + (value / 1e6).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " mi";
}
function fmtDateBR(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function deltaClass(v) {
  return v > 0.0001 ? "up" : v < -0.0001 ? "down" : "flat";
}
function arrow(v) {
  return v > 0.0001 ? "▲" : v < -0.0001 ? "▼" : "–";
}

// ---------------------------------------------------------------------------
// Acesso a dados (busca tudo uma vez; a navegacao por data so recorta em memoria)
// ---------------------------------------------------------------------------
async function fetchInstruments() {
  const { data, error } = await sb.from("instruments").select("*").order("sort_order");
  if (error) throw error;
  return data;
}

async function fetchSharesOutstanding() {
  const { data, error } = await sb.from("shares_outstanding").select("*");
  if (error) throw error;
  const map = {};
  for (const row of data) map[row.ticker] = row;
  return map;
}

async function fetchSeries(ticker) {
  const { data, error } = await sb
    .from("market_data_daily")
    .select("trade_date, price, volume, financial_volume")
    .eq("ticker", ticker)
    .order("trade_date", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;
  return data.slice().reverse(); // ordem crescente (mais antigo -> mais recente)
}

async function fetchTreasurySeries(seriesId) {
  const { data, error } = await sb
    .from("treasury_yields")
    .select("obs_date, value")
    .eq("series_id", seriesId)
    .order("obs_date", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;
  return data.slice().reverse().map((r) => ({ trade_date: r.obs_date, price: r.value, volume: null, financial_volume: null }));
}

// ---------------------------------------------------------------------------
// Recorte por data: tudo na tela e uma funcao pura de "ate qual dia olhar"
// ---------------------------------------------------------------------------
function sliceUpTo(series, dateIso) {
  return series.filter((r) => r.trade_date <= dateIso);
}

// ---------------------------------------------------------------------------
// Calculos sobre series (mesma serie serve para acoes, indices, cripto, cambio e yields)
// ---------------------------------------------------------------------------
function at(series, offsetFromEnd) {
  const idx = series.length - 1 - offsetFromEnd;
  return idx >= 0 ? series[idx] : null;
}
function pctChange(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return curr / prev - 1;
}
function minMax(series) {
  const prices = series.map((r) => r.price).filter((p) => p != null);
  if (!prices.length) return { min: null, max: null };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
function avgFinancialVolume(series, count, offset = 0) {
  const slice = series.slice(Math.max(0, series.length - offset - count), series.length - offset);
  const vals = slice.map((r) => r.financial_volume).filter((v) => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function computeYtd(series) {
  const last = series[series.length - 1];
  if (!last) return null;
  const currentYear = parseInt(last.trade_date.slice(0, 4), 10);
  let baseline = null;
  for (let i = series.length - 1; i >= 0; i--) {
    const rowYear = parseInt(series[i].trade_date.slice(0, 4), 10);
    if (rowYear < currentYear) {
      baseline = series[i];
      break;
    }
  }
  return baseline ? pctChange(last.price, baseline.price) : null;
}

function computeRow(series) {
  const last = series[series.length - 1] ?? null;
  const monthAgo = at(series, MONTH_LOOKBACK);
  const yearAgo = at(series, YEAR_LOOKBACK);
  const { min, max } = minMax(series);
  const volAvgMonth = avgFinancialVolume(series, MONTH_LOOKBACK, 0);
  const volAvgPrevMonth = avgFinancialVolume(series, MONTH_LOOKBACK, MONTH_LOOKBACK);
  return {
    date: last?.trade_date ?? null,
    price: last?.price ?? null,
    varMes: pctChange(last?.price, monthAgo?.price),
    ytd: computeYtd(series),
    var12m: pctChange(last?.price, yearAgo?.price),
    min,
    max,
    volAvgMonth,
    volVarMonth: pctChange(volAvgMonth, volAvgPrevMonth),
  };
}

function pctCell(v) {
  if (v == null) return '<span style="color:var(--ink-faint);">—</span>';
  const cls = v > 0 ? "ba-pos" : v < 0 ? "ba-neg" : "";
  return `<span class="${cls}">${fmtPct(v)}</span>`;
}

// Barra visual "menor valor — •  — maior valor", igual ao mockup original.
function rangeTrackHtml(min, max, curr, formatFn) {
  if (min == null || max == null) {
    return `<td colspan="3" style="text-align:center;color:var(--ink-faint);">—</td>`;
  }
  const pct = max > min ? ((curr - min) / (max - min)) * 100 : 50;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    `<td class="num">${formatFn(min)}</td>` +
    `<td class="range-track-cell"><div class="range-track"><span class="range-dot" style="left:${clamped.toFixed(1)}%;"></span></div></td>` +
    `<td class="num">${formatFn(max)}</td>`
  );
}

// ---------------------------------------------------------------------------
// KPIs do topo (CASH3)
// ---------------------------------------------------------------------------
let cash3Shares = null;

function renderKpis(cash3Sliced) {
  const curr = cash3Sliced[cash3Sliced.length - 1];
  const prev = cash3Sliced.length > 1 ? cash3Sliced[cash3Sliced.length - 2] : null;
  if (!curr) return;

  const shares = cash3Shares?.shares ?? null;
  const marketCap = shares != null && curr.price != null ? curr.price * shares : cash3Shares?.market_cap_override ?? null;
  const marketCapPrev = prev && shares != null && prev.price != null ? prev.price * shares : null;

  const tiles = [
    {
      label: "Total de acionistas",
      value: "—",
      note: "depende da base de acionistas (ainda nao integrada)",
    },
    {
      label: "Total de ações em circulação",
      value: fmtInt(shares),
      note: shares != null ? "" : "quantidade não disponível na planilha",
    },
    {
      label: `Valor de mercado · ${fmtDateBR(curr.trade_date)}`,
      value: fmtMoneyAuto(marketCap, "BRL"),
      delta: prev ? pctChange(marketCap, marketCapPrev) : null,
    },
    {
      label: "Volume negociado no dia",
      value: fmtMoneyAuto(curr.financial_volume, "BRL"),
      delta: prev ? pctChange(curr.financial_volume, prev.financial_volume) : null,
    },
    {
      label: "Free float",
      value: "—",
      note: "depende do % do grupo controlador (ainda nao integrado)",
    },
  ];

  document.getElementById("kpi-row").innerHTML = tiles
    .map((t) => {
      const deltaHtml =
        t.delta !== undefined && t.delta !== null
          ? `<div class="delta ${deltaClass(t.delta)}">${arrow(t.delta)} ${fmtPct(Math.abs(t.delta))}</div>`
          : t.note
          ? `<div class="delta flat">${t.note}</div>`
          : "";
      return `<div class="stat-tile"><div class="label">${t.label}</div><div class="value">${t.value}</div>${deltaHtml}</div>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Graficos comparativos (Chart.js) - com tooltip mostrando a cotacao do dia
// ---------------------------------------------------------------------------
const chartInstances = {};

function alignByDate(baseSeries, otherSeries, count) {
  const base = baseSeries.slice(-count);
  const otherByDate = new Map(otherSeries.map((r) => [r.trade_date, r.price]));
  return base.map((r) => ({ date: r.trade_date, base: r.price, other: otherByDate.get(r.trade_date) ?? null }));
}

function renderComparisonChart(canvasId, baseSeries, otherSeries, baseLabel, otherLabel, otherColor, otherFormatFn) {
  const aligned = alignByDate(baseSeries, otherSeries, 30);
  const labels = aligned.map((r) => fmtDateBR(r.date).slice(0, 5));
  const baseFormatFn = (v) => fmtPrice(v, "BRL");

  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
  }

  chartInstances[canvasId] = new Chart(document.getElementById(canvasId), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: baseLabel, data: aligned.map((r) => r.base), borderColor: "#FF619A", backgroundColor: "transparent", tension: 0.4, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5, yAxisID: "y" },
        { label: otherLabel, data: aligned.map((r) => r.other), borderColor: otherColor, backgroundColor: "transparent", tension: 0.4, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, yAxisID: "y1" },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
        y: { position: "left", ticks: { callback: (v) => baseFormatFn(v) } },
        y1: { position: "right", grid: { display: false }, ticks: { callback: (v) => otherFormatFn(v) } },
      },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            title: (items) => (items.length ? `Pregão de ${fmtDateBR(aligned[items[0].dataIndex].date)}` : ""),
            label: (item) => {
              if (item.raw == null) return `${item.dataset.label}: sem dado`;
              const fmt = item.datasetIndex === 0 ? baseFormatFn : otherFormatFn;
              return `${item.dataset.label}: ${fmt(item.raw)}`;
            },
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tabela de peers
// ---------------------------------------------------------------------------
function renderPeerTable(instruments, slicedSeriesByTicker, sharesByTicker, treasuryRows) {
  const groups = {};
  for (const inst of instruments) {
    if (!groups[inst.category]) groups[inst.category] = [];
    groups[inst.category].push(inst);
  }

  function tickerRowHtml(inst, series, highlight = false) {
    const r = computeRow(series);
    const shares = sharesByTicker[inst.ticker];
    const marketCap =
      shares?.market_cap_override != null
        ? shares.market_cap_override
        : shares?.shares != null && r.price != null
        ? r.price * shares.shares
        : null;
    return `<tr${highlight ? ' class="meliuz-row"' : ""}>
      <td>${inst.display_name}</td>
      <td>${inst.ticker}</td>
      <td class="num">${fmtPrice(r.price, inst.currency)}</td>
      <td class="num">${pctCell(r.varMes)}</td>
      <td class="num">${pctCell(r.ytd)}</td>
      <td class="num">${pctCell(r.var12m)}</td>
      ${rangeTrackHtml(r.min, r.max, r.price, (v) => fmtPrice(v, inst.currency))}
      <td class="num">${fmtMoneyAuto(r.volAvgMonth, inst.currency)}</td>
      <td class="num">${pctCell(r.volVarMonth)}</td>
      <td class="num">${fmtMoneyAuto(marketCap, inst.currency)}</td>
    </tr>`;
  }

  const order = ["Meliuz", "Tecnologia", "Varejo", "Bitcoin Treasury", "Indices e cambio"];
  let html = "";
  for (const cat of order) {
    if (!groups[cat]) continue;
    html += `<tr class="group-row"><td colspan="12">${cat}</td></tr>`;
    for (const inst of groups[cat]) {
      html += tickerRowHtml(inst, slicedSeriesByTicker[inst.ticker] ?? [], cat === "Meliuz");
    }
  }
  html += `<tr class="group-row"><td colspan="12">Treasury (EUA)</td></tr>`;
  for (const t of treasuryRows) {
    const r = computeRow(t.series);
    const pctFmt = (v) => (v == null ? "—" : v.toFixed(2) + "%");
    html += `<tr>
      <td>${t.label}</td>
      <td>—</td>
      <td class="num">${pctFmt(r.price)}</td>
      <td class="num">${pctCell(r.varMes)}</td>
      <td class="num">${pctCell(r.ytd)}</td>
      <td class="num">${pctCell(r.var12m)}</td>
      ${rangeTrackHtml(r.min, r.max, r.price, pctFmt)}
      <td class="num">—</td>
      <td class="num">—</td>
      <td class="num">—</td>
    </tr>`;
  }

  document.getElementById("peer-table-body").innerHTML = html;
}

// ---------------------------------------------------------------------------
// Boot + navegacao por data (recorta tudo e redesenha a pagina inteira)
// ---------------------------------------------------------------------------
let instruments = [];
let sharesByTicker = {};
let seriesByTicker = {};
let treasurySeriesById = {};

function renderForDate(dateIso) {
  const cash3Sliced = sliceUpTo(seriesByTicker["CASH3"] ?? [], dateIso);
  if (!cash3Sliced.length) return;

  renderKpis(cash3Sliced);

  const ibovSliced = sliceUpTo(seriesByTicker["IBOV"] ?? [], dateIso);
  const btcSliced = sliceUpTo(seriesByTicker["BTCBRL"] ?? [], dateIso);
  renderComparisonChart("chart-cash3-ibov", cash3Sliced, ibovSliced, "CASH3", "IBOV", "#2A2A2A", (v) => Math.round(v).toLocaleString("pt-BR") + " pts");
  renderComparisonChart("chart-cash3-btc", cash3Sliced, btcSliced, "CASH3", "BTC", "#E08A3C", (v) => fmtPrice(v, "BRL"));

  const slicedSeriesByTicker = {};
  for (const inst of instruments) {
    slicedSeriesByTicker[inst.ticker] = sliceUpTo(seriesByTicker[inst.ticker] ?? [], dateIso);
  }
  renderPeerTable(instruments, slicedSeriesByTicker, sharesByTicker, [
    { label: "US Treasury 5Y (%)", series: sliceUpTo(treasurySeriesById["DGS5"] ?? [], dateIso) },
    { label: "US Treasury 10Y (%)", series: sliceUpTo(treasurySeriesById["DGS10"] ?? [], dateIso) },
  ]);
}

async function boot() {
  try {
    [instruments, sharesByTicker] = await Promise.all([fetchInstruments(), fetchSharesOutstanding()]);

    seriesByTicker = {};
    await Promise.all(
      instruments.map(async (inst) => {
        seriesByTicker[inst.ticker] = await fetchSeries(inst.ticker);
      })
    );

    const [dgs5, dgs10] = await Promise.all([fetchTreasurySeries("DGS5"), fetchTreasurySeries("DGS10")]);
    treasurySeriesById = { DGS5: dgs5, DGS10: dgs10 };

    const cash3Series = seriesByTicker["CASH3"] ?? [];
    cash3Shares = sharesByTicker["CASH3"] ?? null;

    if (!cash3Series.length) {
      document.getElementById("visao-geral-root").innerHTML =
        '<div class="empty-state">Ainda não há dados sincronizados no Supabase. Rode o workflow "Sync market data" no GitHub Actions (aba Actions → Run workflow) e recarregue esta página.</div>';
      return;
    }

    const dateSelect = document.getElementById("kpi-date-select");
    dateSelect.innerHTML = cash3Series
      .slice()
      .reverse()
      .map((r) => `<option value="${r.trade_date}">${fmtDateBR(r.trade_date)}</option>`)
      .join("");
    const latestDate = cash3Series[cash3Series.length - 1].trade_date;
    dateSelect.value = latestDate;
    dateSelect.addEventListener("change", () => renderForDate(dateSelect.value));

    renderForDate(latestDate);
  } catch (err) {
    console.error(err);
    document.getElementById("visao-geral-root").innerHTML =
      `<div class="empty-state">Erro ao carregar dados do Supabase: ${err.message}. Confira docs/js/config.js e as políticas de RLS.</div>`;
  }
}

boot();
