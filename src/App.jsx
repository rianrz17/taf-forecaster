import React, { useState, useEffect, useCallback, useMemo } from "react";

// ─── Station Registry ─────────────────────────────────────────────────────────
const STATIONS = [
  { icao: "WALS", name: "APT Pranoto - Samarinda",       lat: -0.373, lon: 117.258 },
  { icao: "WALL", name: "Sepinggan - Balikpapan",         lat: -1.268, lon: 116.894 },
  { icao: "WAQT", name: "Kalimarau - Tanjung Redeb",      lat:  2.155, lon: 117.433 },
  { icao: "WAOO", name: "Syamsudin Noor - Banjarmasin",   lat: -3.442, lon: 114.762 },
  { icao: "WAQQ", name: "Juwata - Tarakan",               lat:  3.327, lon: 117.564 },
  { icao: "WAQD", name: "Tanjung Harapan - Tanjung Selor",lat:  2.837, lon: 117.382 },
];

// ─── METAR Parser ─────────────────────────────────────────────────────────────
function parseMetar(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  const timeMatch = s.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  const day  = timeMatch ? timeMatch[1] : null;
  const time = timeMatch ? `${timeMatch[2]}${timeMatch[3]}Z` : "--";

  const windMatch = s.match(/\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/);
  let dir = 0, speed = 0, gust = 0, windStr = "--";
  if (windMatch) {
    dir   = windMatch[1] === "VRB" ? 0 : parseInt(windMatch[1]);
    speed = parseInt(windMatch[2]);
    gust  = windMatch[4] ? parseInt(windMatch[4]) : 0;
    windStr = gust > 0
      ? `${windMatch[1]}/${windMatch[2]}G${windMatch[4]}KT`
      : `${windMatch[1]}/${windMatch[2]}KT`;
  }

  const visMatch = s.match(/\b(9999|[0-9]{4})\b/);
  const vis = visMatch ? parseInt(visMatch[1]) : 9999;

  const wxCodes = ["TSRA","TSGR","TS","SHRA","-RA","RA","FG","BR","HZ","DZ","SN","MIFG","BCFG"];
  let wx = "";
  for (const code of wxCodes) {
    if (s.includes(code)) { wx = code; break; }
  }

  const cloudParts = [];
  const cloudReg = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?\b/g;
  let cm;
  while ((cm = cloudReg.exec(s)) !== null) {
    cloudParts.push(`${cm[1]}${cm[2]}${cm[3]||""}`);
  }
  const hasCB   = cloudParts.some(c => c.includes("CB") || c.includes("TCU"));
  const cloudStr = cloudParts.join(" ") || (s.includes("CAVOK") ? "CAVOK" : "SKC");

  // Flight category (approximation — meter thresholds, not the FAA statute-mile scale)
  const lowestBroken = cloudParts
    .filter(c => /^(BKN|OVC)/.test(c))
    .map(c => parseInt(c.replace(/\D/g, "")))
    .sort((a,b)=>a-b)[0] || 999;
  let cat = "VFR";
  if (vis < 1500 || lowestBroken < 5) cat = "LIFR";
  else if (vis < 5000 || lowestBroken < 10) cat = "IFR";
  else if (vis < 8000 || lowestBroken < 30) cat = "MVFR";

  return { raw: s, day, time, dir, speed, gust, windStr, vis, wx, cloudStr, hasCB, cat };
}

// ─── Wind Vector Mean (Meteorologically Correct) ─────────────────────────────
function vectorMeanWind(metarList) {
  if (!metarList || metarList.length === 0) return { dir: 140, speed: 8 };
  const valid = metarList.filter(m => m.speed > 0).slice(0, 12);
  if (valid.length === 0) return { dir: 140, speed: 6 };
  let su = 0, sv = 0;
  valid.forEach(m => {
    const rad = m.dir * Math.PI / 180;
    su += m.speed * Math.sin(rad);
    sv += m.speed * Math.cos(rad);
  });
  const n    = valid.length;
  const dir  = Math.round((Math.atan2(su/n, sv/n) * 180 / Math.PI + 360) % 360);
  const spd  = Math.round(Math.sqrt((su/n)**2 + (sv/n)**2));
  return { dir, speed: spd };
}

// FIX: baseline harus mencerminkan kondisi PREVAILING, bukan kejadian ekstrem
// terakhir. Laporan dengan CB/TS dikeluarkan dari kandidat baseline cloud —
// kondisi itu tetap direpresentasikan lewat grup TEMPO/PROB, bukan header TAF.
function calculateBaseline(metarList) {
  const { dir, speed } = vectorMeanWind(metarList);
  const dirStr = String(dir).padStart(3,"0");
  const spdStr = String(speed).padStart(2,"0");

  // Median visibility (robust terhadap outlier fog/TS sementara)
  const visList = metarList.slice(0,6).map(m=>m.vis).sort((a,b)=>a-b);
  const medVis  = visList.length ? visList[Math.floor(visList.length/2)] : 9999;
  const visStr  = medVis >= 9000 ? "9999" : String(medVis).padStart(4,"0");

  // Cloud baseline: laporan non-konvektif terbaru (mengecualikan CB/TCU)
  const nonConvective = metarList.find(m => m.cloudStr && m.cloudStr !== "SKC" && !m.hasCB);
  const anyRecent     = metarList.find(m => m.cloudStr && m.cloudStr !== "SKC");
  const latestCloud   = nonConvective?.cloudStr || anyRecent?.cloudStr || "FEW018 SCT080";

  return {
    wind:  `${dirStr}${spdStr}KT`,
    vis:   visStr,
    cloud: latestCloud,
    windSpeed: speed,
  };
}

// ─── Diurnal Convection Window (Kalimantan Tropical Pattern) ─────────────────
// UTC+8 WITA:  Siang 14–22 WITA ≈ 06–14Z (heuristik klimatologi kasar, BUKAN
// hasil deteksi dari data NWP yang di-fetch — lihat catatan di UI).
function getConvectionWindow(validFromStr) {
  const day = validFromStr.substring(0, 2);  // "DD"
  return {
    start: `${day}06`,  // 06Z = 14.00 WITA
    end:   `${day}14`,  // 14Z = 22.00 WITA
  };
}

// FIX: bangun isi grup TEMPO/PROB dari data aktual (baseline + severity),
// bukan string cuaca buruk yang hardcoded secara statis.
function buildConvectiveGroup(level, pFinal, baseline) {
  if (level === "NONE") return "";
  // Skala tingkat keparahan sederhana berdasarkan P_FINAL — tetap heuristik,
  // bukan hasil model, tapi setidaknya proporsional terhadap probabilitas.
  const gustAdd   = level === "TEMPO" ? 10 : level === "PROB40" ? 8 : 6;
  const baseSpeed = Math.max(baseline.windSpeed || 8, 8);
  const gust      = baseSpeed + gustAdd;
  const dirPart   = baseline.wind.slice(0,3);
  const visConv   = level === "TEMPO" ? 3000 : level === "PROB40" ? 4000 : 5000;
  const cloudConv = level === "TEMPO" ? "SCT015CB BKN070" : level === "PROB40" ? "SCT015CB" : "SCT018CB";
  const windPart  = `${dirPart}${String(baseSpeed).padStart(2,"0")}G${String(gust).padStart(2,"0")}KT`;
  const prefix    = level === "TEMPO" ? "TEMPO" : `${level} TEMPO`;
  return { prefix, windPart, visConv, cloudConv };
}

// ─── Helpers UI ───────────────────────────────────────────────────────────────
function SectionHeader({ icon, title, sub }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"10px" }}>
      <span style={{ fontSize:"16px" }}>{icon}</span>
      <div>
        <div style={{ fontSize:"11px", fontWeight:"700", color:"#E2E8F0", letterSpacing:"0.06em", textTransform:"uppercase" }}>{title}</div>
        {sub && <div style={{ fontSize:"9px", color:"#475569" }}>{sub}</div>}
      </div>
    </div>
  );
}

function CatBadge({ cat }) {
  const C = { VFR:["#14532D","#22C55E"], MVFR:["#1E3A8A","#93C5FD"], IFR:["#7F1D1D","#FCA5A5"], LIFR:["#4A044E","#F0ABFC"] };
  const [bg, fg] = C[cat] || C.VFR;
  return (
    <span style={{ fontSize:"9px", fontFamily:"monospace", fontWeight:"700", padding:"1px 5px", borderRadius:"3px", background:bg, color:fg }}>
      {cat}
    </span>
  );
}

function ProbBar({ ecmwf, gfs, final, label }) {
  const gap = Math.abs(ecmwf - gfs);
  const consistent = gap <= 15;
  return (
    <div style={{ background:"#080F1A", padding:"8px 10px", borderRadius:"6px", border:`1px solid ${consistent?"#16653460":"#92400E60"}`, marginBottom:"5px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"4px" }}>
        <span style={{ fontSize:"9px", fontFamily:"monospace", color:"#7DD3FC", fontWeight:"700" }}>{label}</span>
        <span style={{ fontSize:"9px", fontFamily:"monospace", color: consistent ? "#22C55E" : "#FCD34D" }}>
          {consistent ? "✓ Konsisten" : `⚠ Divergen (Gap ${gap}%)`}
        </span>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"4px", marginBottom:"4px" }}>
        {[["ECMWF", ecmwf, "#FCA5A5"], ["GFS", gfs, "#93C5FD"], ["FINAL", final, "#22C55E"]].map(([nm,val,col])=>(
          <div key={nm}>
            <div style={{ fontSize:"8px", color:"#475569", marginBottom:"1px" }}>{nm}</div>
            <div style={{ height:"4px", background:"#1E2A3F", borderRadius:"2px", marginBottom:"2px" }}>
              <div style={{ height:"100%", width:`${val}%`, background:col, borderRadius:"2px" }} />
            </div>
            <div style={{ fontSize:"10px", fontFamily:"monospace", color:col, fontWeight:"700" }}>{val}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Validasi ringan untuk field DDHH / DDHHMM supaya header TAF tidak rusak diam-diam
const isDDHH   = v => /^\d{4}$/.test(v);
const isHHMM   = v => /^\d{4}$/.test(v);
const isDD     = v => /^\d{2}$/.test(v) && parseInt(v) >= 1 && parseInt(v) <= 31;

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function TAFForecaster() {
  const [station, setStation]           = useState("WALS");
  const [stationInput, setStationInput] = useState("WALS");
  const [inputMode, setInputMode]       = useState("UPLOAD");
  const [manualText, setManualText]     = useState("");
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [activeTab, setActiveTab]       = useState("nwp");

  const [issueDate, setIssueDate] = useState(() => String(new Date().getUTCDate()).padStart(2,"0"));
  const [issueTime, setIssueTime] = useState("0500");
  const [validFrom, setValidFrom] = useState(() => `${String(new Date().getUTCDate()).padStart(2,"0")}06`);
  const [validTo,   setValidTo]   = useState(() => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return `${String(tomorrow.getUTCDate()).padStart(2,"0")}06`;
  });

  // Data states
  const [metarData,    setMetarData]    = useState([]);
  const [metarRaw,     setMetarRaw]     = useState([]);
  const [metarLoading, setMetarLoading] = useState(false);
  const [metarSource,  setMetarSource]  = useState("Belum ada data — silakan upload file METAR");
  const [metarIsFallback, setMetarIsFallback] = useState(false);
  const [nwpRows,      setNwpRows]      = useState([]);
  const [nwpLoading,   setNwpLoading]   = useState(false);
  const [nwpSummary,   setNwpSummary]   = useState(null);
  const [nwpIsFallback, setNwpIsFallback] = useState(false);

  // Output states
  const [tafOutput,  setTafOutput]  = useState("");
  const [generating, setGenerating] = useState(false);
  const [reasoning,  setReasoning]  = useState("");
  const [mlTrace,    setMlTrace]    = useState([]);
  const [copied,     setCopied]     = useState(false);
  const [formError,  setFormError]  = useState("");

  const currentStn = STATIONS.find(s => s.icao === station) || STATIONS[0];

  const validationError = useMemo(() => {
    if (!isDD(issueDate)) return "Tanggal UTC harus 2 digit (01-31).";
    if (!isHHMM(issueTime)) return "Jam penerbitan harus format HHMM (4 digit).";
    if (!isDDHH(validFrom)) return "Valid-from harus format DDHH (4 digit).";
    if (!isDDHH(validTo)) return "Valid-to harus format DDHH (4 digit).";
    return "";
  }, [issueDate, issueTime, validFrom, validTo]);

  // METAR sekarang diambil dari file yang diupload pengguna (bukan live API),
  // supaya tidak lagi bergantung pada aviationweather.gov yang sering diblokir
  // CORS di lingkungan browser/artifact dan diam-diam jatuh ke data sintetis.
  // Format yang diterima: file teks (.txt/.csv/.log) berisi satu laporan METAR
  // mentah per baris, mis. "METAR WALS 210600Z 15008KT 9999 FEW018 31/25 Q1008".
  const processMetarText = useCallback((text, sourceLabel) => {
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    const parsed = lines.map(parseMetar).filter(Boolean);

    setMetarRaw(lines);
    setMetarData(parsed);

    if (lines.length === 0) {
      setMetarSource("File kosong — tidak ada baris yang bisa dibaca");
      setMetarIsFallback(true);
    } else if (parsed.length === 0) {
      setMetarSource(`${sourceLabel}: 0/${lines.length} baris berhasil diparse — cek format`);
      setMetarIsFallback(true);
    } else if (parsed.length < lines.length) {
      setMetarSource(`${sourceLabel}: ${parsed.length}/${lines.length} baris berhasil diparse (sebagian gagal)`);
      setMetarIsFallback(true);
    } else {
      setMetarSource(`${sourceLabel}: ${parsed.length} laporan`);
      setMetarIsFallback(false);
    }
  }, []);

  const handleFileUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMetarLoading(true);
    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      processMetarText(String(ev.target.result || ""), `Upload (${file.name})`);
      setMetarLoading(false);
    };
    reader.onerror = () => {
      setMetarSource(`Gagal membaca file ${file.name}`);
      setMetarIsFallback(true);
      setMetarLoading(false);
    };
    reader.readAsText(file);
    // reset input value supaya file yang sama bisa diupload ulang jika perlu
    e.target.value = "";
  }, [processMetarText]);

  const handleDownloadSample = () => {
    const sample = [
      `METAR ${station} ${issueDate}0600Z 15008KT 9999 FEW018 SCT080 31/25 Q1008`,
      `METAR ${station} ${issueDate}0300Z 12005KT 9999 FEW018 29/25 Q1010`,
      `METAR ${station} ${String(Math.max(parseInt(issueDate)-1,1)).padStart(2,"0")}1800Z 15010G18KT 5000 TSRA SCT018CB BKN080 30/25 Q1007`,
    ].join("\n");
    const blob = new Blob([sample], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "contoh_format_metar.txt";
    a.click();
  };

  // Dual-model Open-Meteo — 2 request terpisah supaya field per-model tidak ambigu.
  // FIX: filter jam target sekarang berbasis TANGGAL KALENDER target (bukan cuma
  // jam-of-day), karena forecast_days=2 mengembalikan jam yang sama untuk dua
  // hari berbeda — tanpa filter tanggal, data besok dan lusa bisa tercampur.
  const fetchDualNWP = useCallback(async (stn, targetDD) => {
    setNwpLoading(true);
    const BASE = "https://api.open-meteo.com/v1/forecast";
    const COMMON = `latitude=${stn.lat}&longitude=${stn.lon}&hourly=precipitation_probability,wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=2&timezone=UTC`;

    // Tentukan tanggal kalender penuh (YYYY-MM-DD) yang berkorespondensi dengan
    // digit hari (DD) dari validFrom, menangani kemungkinan lompat bulan.
    const now = new Date();
    let candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), parseInt(targetDD)));
    if (candidate < now && (now.getUTCDate() - parseInt(targetDD) > 15)) {
      candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, parseInt(targetDD)));
    }
    const targetISODate = candidate.toISOString().slice(0,10); // "YYYY-MM-DD"

    try {
      const [resE, resG] = await Promise.all([
        fetch(`${BASE}?${COMMON}&models=ecmwf_ifs025`, { signal: AbortSignal.timeout(8000) }),
        fetch(`${BASE}?${COMMON}&models=gfs_seamless`, { signal: AbortSignal.timeout(8000) }),
      ]);

      if (!resE.ok || !resG.ok) throw new Error(`HTTP ECMWF:${resE.status} GFS:${resG.status}`);

      const [dataE, dataG] = await Promise.all([resE.json(), resG.json()]);

      const rows = [];
      let maxE = 0, maxG = 0;
      const targetHours = [6, 7, 8, 9, 10, 11, 12, 13, 14];

      dataE.hourly.time.forEach((t, i) => {
        const dateStr = t.slice(0, 10);
        if (dateStr !== targetISODate) return;           // ← FIX tanggal
        const hour = new Date(t + "Z").getUTCHours();
        if (!targetHours.includes(hour)) return;

        const pE = dataE.hourly.precipitation_probability?.[i] ?? 0;
        const pG = dataG.hourly.precipitation_probability?.[i] ?? 0;

        if (pE > maxE) maxE = pE;
        if (pG > maxG) maxG = pG;

        const gap = Math.abs(pE - pG);
        const consistent = gap <= 15;
        const pFinal = consistent
          ? Math.round((pE + pG) / 2)
          : pE; // divergen → prioritas ECMWF (resolusi lebih tinggi)

        rows.push({ hour: `${String(hour).padStart(2,"0")}Z`, pE, pG, pFinal, consistent });
      });

      if (rows.length === 0) throw new Error("Tidak ada jam target pada tanggal yang cocok");

      const overallGap = Math.abs(maxE - maxG);
      const consistent = overallGap <= 15;
      const pFinalMax  = consistent ? Math.round((maxE + maxG) / 2) : maxE;

      setNwpRows(rows);
      setNwpSummary({
        maxE, maxG, consistent, pFinalMax,
        status: consistent
          ? `KONSISTEN — Rata-rata konsensus P_NWP = ${pFinalMax}% (tgl target ${targetISODate})`
          : `DIVERGEN (gap ${overallGap}%) — Prioritas ECMWF, P_NWP = ${maxE}% (tgl target ${targetISODate})`,
      });
      setNwpIsFallback(false);
    } catch (err) {
      // Fallback klimatologi Kalimantan — nilai indikatif historis, BUKAN forecast hari ini
      const fallbackRows = [
        { hour:"06Z", pE:35, pG:30, pFinal:32, consistent:true },
        { hour:"08Z", pE:50, pG:48, pFinal:49, consistent:true },
        { hour:"10Z", pE:60, pG:55, pFinal:58, consistent:true },
        { hour:"12Z", pE:55, pG:62, pFinal:58, consistent:true },
        { hour:"14Z", pE:40, pG:35, pFinal:38, consistent:true },
      ];
      setNwpRows(fallbackRows);
      setNwpSummary({ maxE:60, maxG:62, consistent:true, pFinalMax:58, status:`Klimatologi fallback, bukan forecast live (${err.message})` });
      setNwpIsFallback(true);
    }
    setNwpLoading(false);
  }, []);

  useEffect(() => {
    // NWP (Open-Meteo) tetap auto-fetch berdasarkan stasiun — ini tidak
    // bergantung pada bagaimana METAR dimasukkan (upload/manual).
    fetchDualNWP(currentStn, validFrom.substring(0,2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station]);

  const handleProcessManual = () => {
    processMetarText(manualText, "Tempel manual");
    fetchDualNWP(currentStn, validFrom.substring(0,2));
  };

  const handleApplyStation = () => {
    const code = stationInput.trim().toUpperCase();
    if (code.length === 4) setStation(code);
  };

  // ══ GENERATE: Rule-Based Heuristic Blend (bukan model ML terlatih) ═════════
  // Nama "sliding window" / "cross-validation" / "Bayesian" pada versi sebelumnya
  // menyesatkan: yang berjalan adalah pembagian data + heuristik if/else dengan
  // konstanta tetap, dan rata-rata tertimbang (bukan posterior Bayesian).
  // Label di bawah sekarang menyebutnya apa adanya.
  const generateTAF = () => {
    if (validationError) { setFormError(validationError); return; }
    if (metarLoading || nwpLoading) { setFormError("Tunggu data METAR/NWP selesai dimuat."); return; }
    setFormError("");
    setGenerating(true);
    setTafOutput(""); setReasoning(""); setMlTrace([]);

    setTimeout(() => {
      try {
        const trace = [];

        // ── FASE 1: Partisi Data (heuristik, bukan cross-validation formal) ──
        // H1 = 12 laporan terbaru dipakai untuk cek konsistensi; H2 = 12
        // laporan sebelumnya dipakai untuk hitung frekuensi dasar. Ini adalah
        // pembagian sederhana, bukan k-fold cross-validation.
        const H1 = metarData.slice(0, 12);
        const H2 = metarData.slice(12, 24);

        const tsH1 = H1.filter(m => m.wx.includes("TS")).length;
        const tsH2 = H2.filter(m => m.wx.includes("TS")).length;

        trace.push(`• FASE 1 - Partisi data: kelompok terbaru H1 (TS=${tsH1}x dari ${H1.length}), kelompok sebelumnya H2 (TS=${tsH2}x dari ${H2.length})`);

        // ── FASE 2: P_METAR — Frekuensi relatif dengan Laplace Smoothing ────
        const α = 1;
        const K = 2;
        const pTrain = H2.length > 0 ? (tsH2 + α) / (H2.length + α * K) : 0.5;

        let pMetar = pTrain;
        let driftLabel = "";
        if (pTrain > 0.30 && tsH1 === 0) {
          pMetar = pTrain * 0.45;
          driftLabel = "Pola TS di kelompok lama tidak berulang di kelompok baru → probabilitas diturunkan (aturan tetap, bukan hasil pembelajaran)";
        } else if (pTrain > 0.10 && tsH1 > 0) {
          pMetar = Math.min(pTrain * 1.35, 0.95);
          driftLabel = "Pola TS konsisten di kedua kelompok → probabilitas dinaikkan (aturan tetap)";
        } else if (pTrain < 0.10 && tsH1 > 0) {
          pMetar = 0.40;
          driftLabel = "TS baru muncul di kelompok terbaru, tanpa riwayat sebelumnya → nilai tetap 40%";
        } else {
          driftLabel = "Tidak ada riwayat konveksi signifikan";
        }
        const pMetarPct = Math.round(pMetar * 100);
        trace.push(`• FASE 2 - P_METAR (heuristik): Laplace P(TS|H2)=${Math.round(pTrain*100)}% → setelah aturan penyesuaian: ${pMetarPct}% [${driftLabel}]`);

        // ── FASE 3: P_NWP dari dual model ────────────────────────────────────
        // Catatan domain: precipitation_probability adalah peluang hujan umum
        // dari Open-Meteo, BUKAN peluang thunderstorm/CB secara spesifik — ini
        // proxy kasar, bukan pengukuran langsung probabilitas TS.
        const pNWP = nwpSummary?.pFinalMax ?? 40;
        trace.push(`• FASE 3 - P_NWP (proxy peluang hujan, bukan peluang TS langsung): ${pNWP}% (${nwpSummary?.status || "data tidak tersedia"})`);

        // ── FASE 4: Rata-rata Tertimbang (bukan Bayesian) ────────────────────
        // Ini adalah weighted average sederhana, bukan pembaruan Bayesian
        // (tidak ada prior/likelihood/posterior). Bobot 60/40 dipilih sebagai
        // heuristik operasional, bukan hasil kalibrasi statistik formal.
        const W_NWP   = 0.60;
        const W_METAR = 0.40;
        const pFinal  = Math.round(W_NWP * pNWP + W_METAR * pMetarPct);
        trace.push(`• FASE 4 - Rata-rata tertimbang: (${W_NWP}×${pNWP} + ${W_METAR}×${pMetarPct}) = P_FINAL ${pFinal}%`);

        // ── FASE 5: ICAO Decision Rule ────────────────────────────────────────
        const convWindow = getConvectionWindow(validFrom);
        const baseline = calculateBaseline(metarData);
        let level = "NONE";
        let icaoRule = "";
        if (pFinal >= 50)      { level = "TEMPO";  icaoRule = `P_FINAL=${pFinal}% ≥ 50% → TEMPO`; }
        else if (pFinal >= 40) { level = "PROB40";  icaoRule = `P_FINAL=${pFinal}% 40-49% → PROB40 TEMPO`; }
        else if (pFinal >= 30) { level = "PROB30";  icaoRule = `P_FINAL=${pFinal}% 30-39% → PROB30 TEMPO`; }
        else                    { icaoRule = `P_FINAL=${pFinal}% < 30% → Tidak ada grup perubahan konveksi`; }
        trace.push(`• FASE 5 - Aturan ICAO: ${icaoRule}`);

        const conv = buildConvectiveGroup(level, pFinal, baseline);
        if (conv) {
          trace.push(`• FASE 6 - Grup dibangun dari baseline aktual: angin ${conv.windPart}, vis ${conv.visConv}M, awan ${conv.cloudConv}`);
        }

        // ── FASE 7: Bangun string TAF ──────────────────────────────────────────
        const header = `TAF ${station} ${issueDate}${issueTime}Z ${validFrom}/${validTo}`;
        const lines  = [];
        lines.push(`${header} ${baseline.wind} ${baseline.vis} ${baseline.cloud}`);
        if (conv) {
          lines.push(`     ${conv.prefix} ${convWindow.start}/${convWindow.end} ${conv.windPart} ${conv.visConv} TSRA ${conv.cloudConv}`);
        }
        lines.push(`     BECMG ${validTo.substring(0,2)}04/${validTo.substring(0,2)}06 09006KT 9999 FEW018`);

        const tafStr = lines.join("\n") + "=";  // tanda "=" hanya sekali, di akhir seluruh TAF

        setTafOutput(tafStr);
        setMlTrace(trace);
        setReasoning(
          `Sintesis TAF 24H (heuristik rule-based) — ${station}\n` +
          trace.join("\n") + "\n\n" +
          `KEPUTUSAN AKHIR: P_FINAL=${pFinal}% → "${icaoRule}"\n` +
          `Window konveksi Kaltim (klimatologi kasar, bukan dari deteksi NWP jam-per-jam): ${convWindow.start}–${convWindow.end}Z\n` +
          (metarData.length === 0 ? `⚠ PERHATIAN: belum ada METAR yang diupload — baseline TAF memakai nilai default netral, bukan observasi aktual.\n` : "") +
          (metarIsFallback ? `⚠ PERHATIAN: sebagian/semua baris METAR gagal diparse — periksa kembali format file yang diupload.\n` : "") +
          (nwpIsFallback ? `⚠ PERHATIAN: NWP memakai klimatologi fallback, bukan forecast live.` : "")
        );
      } catch (e) {
        setTafOutput(`ERROR: ${e.message}`);
      }
      setGenerating(false);
    }, 600);
  };

  const handleCopy = () => {
    if (!tafOutput) return;
    navigator.clipboard.writeText(tafOutput);
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };

  const tabs = [
    { id:"nwp",   label:"Dual Model (ECMWF/GFS)", icon:"⚖️" },
    { id:"metar", label:"METAR 24H",              icon:"📡" },
    { id:"raw",   label:"Raw METAR",              icon:"📄" },
  ];

  const anyFallback = metarIsFallback || nwpIsFallback;

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{fontFamily:"'Inter','Segoe UI',sans-serif", background:"#060D16", minHeight:"100vh", color:"#CBD5E1"}}>
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-thumb { background:#1E3A5F; border-radius:2px; }
        @keyframes spin { to { transform:rotate(360deg) } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.2} }
      `}</style>

      {/* ── Header ── */}
      <div style={{background:"linear-gradient(135deg,#080F1A,#0B1929)", borderBottom:"1px solid #1E3A5F", padding:"10px 20px"}}>
        <div style={{maxWidth:"1440px", margin:"0 auto", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:"8px"}}>
          <div style={{display:"flex", gap:"12px", alignItems:"center"}}>
            <div style={{width:"34px",height:"34px",borderRadius:"7px",background:"linear-gradient(135deg,#1E90FF,#0055CC)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"17px",boxShadow:"0 0 10px #1E90FF30"}}>✈</div>
            <div>
              <div style={{fontSize:"13px",fontWeight:"700",color:"#F1F5F9",letterSpacing:"0.04em"}}>TAF AUTO-FORECASTER (RULE-BASED)</div>
              <div style={{fontSize:"9px",color:"#475569",fontFamily:"monospace",letterSpacing:"0.1em"}}>METAR VIA UPLOAD · NWP LIVE (OPEN-METEO) · ICAO ANNEX 3 · 24H TAF · BUKAN MODEL ML TERLATIH</div>
            </div>
          </div>
          <div style={{display:"flex",gap:"8px",alignItems:"center",flexWrap:"wrap"}}>
            {metarData.length === 0 ? (
              <span style={{fontSize:"9px",fontFamily:"monospace",color:"#64748B",background:"#0A192930",padding:"3px 8px",borderRadius:"4px",border:"1px solid #1E3A5F"}}>
                ○ {metarSource}
              </span>
            ) : (
              <span style={{fontSize:"9px",fontFamily:"monospace",color:metarIsFallback?"#FCD34D":"#22C55E",background:metarIsFallback?"#4A3A0030":"#14532D30",padding:"3px 8px",borderRadius:"4px",border:`1px solid ${metarIsFallback?"#92400E":"#166534"}`}}>
                {metarIsFallback ? "⚠ " : "● "}{metarSource}
              </span>
            )}
            <span style={{fontSize:"9px",fontFamily:"monospace",color:"#475569",background:"#0A1929",padding:"3px 8px",borderRadius:"4px",border:"1px solid #1E3A5F"}}>
              {new Date().toUTCString().slice(5,25)} UTC
            </span>
          </div>
        </div>
        {anyFallback && (
          <div style={{maxWidth:"1440px",margin:"8px auto 0",background:"#4A3A0030",border:"1px solid #92400E",borderRadius:"6px",padding:"6px 10px",fontSize:"9.5px",color:"#FCD34D",fontFamily:"monospace"}}>
            ⚠ Sebagian data memakai fallback/sintetis (bukan observasi atau forecast live) — jangan pakai untuk keputusan operasional tanpa verifikasi manual.
          </div>
        )}
      </div>

      <div style={{maxWidth:"1440px",margin:"0 auto",padding:"14px 20px",display:"grid",gridTemplateColumns:"330px 1fr 360px",gap:"14px"}}>

        {/* ══ COL 1: Station + Data Tabs ══ */}
        <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>

          {/* Station Panel */}
          <div style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"10px",padding:"12px"}}>
            <SectionHeader icon="⚙️" title="Stasiun & Penerbitan TAF" />
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px",marginBottom:"8px"}}>
              <div>
                <div style={{fontSize:"9px",color:"#475569",marginBottom:"3px"}}>ICAO CODE</div>
                <div style={{display:"flex",gap:"4px"}}>
                  <input value={stationInput} onChange={e=>setStationInput(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&handleApplyStation()} maxLength={4}
                    style={{flex:1,background:"#080F1A",border:"1px solid #1E3A5F",borderRadius:"4px",padding:"5px 7px",fontSize:"11px",fontFamily:"monospace",color:"#7DD3FC",outline:"none"}}
                  />
                  <button onClick={handleApplyStation} style={{background:"#1E3A8A",border:"1px solid #2563EB",borderRadius:"4px",padding:"5px 8px",fontSize:"9px",color:"#93C5FD",cursor:"pointer"}}>Go</button>
                </div>
              </div>
              <div>
                <div style={{fontSize:"9px",color:"#475569",marginBottom:"3px"}}>STASIUN</div>
                <select value={station} onChange={e=>{setStation(e.target.value);setStationInput(e.target.value);}}
                  style={{width:"100%",background:"#080F1A",border:"1px solid #1E3A5F",borderRadius:"4px",padding:"5px 7px",fontSize:"10px",fontFamily:"monospace",color:"#94A3B8",outline:"none"}}
                >
                  {STATIONS.map(s=><option key={s.icao} value={s.icao}>{s.icao} – {s.name.split("-")[0].trim()}</option>)}
                </select>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"6px",marginBottom:"8px"}}>
              {[["TGL UTC",issueDate,setIssueDate,isDD(issueDate)],["ISSUE TIME",issueTime,setIssueTime,isHHMM(issueTime)]].map(([lbl,val,set,valid])=>(
                <div key={lbl}>
                  <div style={{fontSize:"9px",color:"#475569",marginBottom:"3px"}}>{lbl}</div>
                  <input value={val} onChange={e=>set(e.target.value)}
                    style={{width:"100%",background:"#080F1A",border:`1px solid ${valid?"#1E3A5F":"#B91C1C"}`,borderRadius:"4px",padding:"5px 7px",fontSize:"10px",fontFamily:"monospace",color:"#94A3B8",outline:"none"}}
                  />
                </div>
              ))}
              <div>
                <div style={{fontSize:"9px",color:"#475569",marginBottom:"3px"}}>VALID 24H</div>
                <div style={{display:"flex",gap:"2px",alignItems:"center"}}>
                  <input value={validFrom} onChange={e=>setValidFrom(e.target.value)} style={{width:"45%",background:"#080F1A",border:`1px solid ${isDDHH(validFrom)?"#1E3A5F":"#B91C1C"}`,borderRadius:"4px",padding:"5px 4px",fontSize:"9px",fontFamily:"monospace",color:"#94A3B8",outline:"none",textAlign:"center"}}/>
                  <span style={{color:"#334155",fontSize:"9px"}}>/</span>
                  <input value={validTo} onChange={e=>setValidTo(e.target.value)} style={{width:"45%",background:"#080F1A",border:`1px solid ${isDDHH(validTo)?"#1E3A5F":"#B91C1C"}`,borderRadius:"4px",padding:"5px 4px",fontSize:"9px",fontFamily:"monospace",color:"#94A3B8",outline:"none",textAlign:"center"}}/>
                </div>
              </div>
            </div>
            {validationError && (
              <div style={{fontSize:"8.5px",color:"#FCA5A5",fontFamily:"monospace",marginBottom:"8px"}}>⚠ {validationError}</div>
            )}
            <div style={{display:"flex",gap:"5px"}}>
              {[["UPLOAD","📁 Upload File"],["MANUAL","📝 Paste Manual"]].map(([m,lbl])=>(
                <button key={m} onClick={()=>setInputMode(m)} style={{flex:1,padding:"5px",fontSize:"9px",background:inputMode===m?"#1E3A8A":"#080F1A",color:inputMode===m?"#93C5FD":"#475569",border:"1px solid #1E3A5F",borderRadius:"4px",cursor:"pointer"}}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* Data Tabs */}
          <div style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"10px",overflow:"hidden"}}>
            <div style={{display:"flex",borderBottom:"1px solid #1E3A5F"}}>
              {tabs.map(t=>(
                <button key={t.id} onClick={()=>setActiveTab(t.id)} style={{flex:1,padding:"7px 2px",fontSize:"9px",fontWeight:"600",background:activeTab===t.id?"#0E2A45":"transparent",color:activeTab===t.id?"#7DD3FC":"#334155",border:"none",cursor:"pointer",borderBottom:activeTab===t.id?"2px solid #1E90FF":"2px solid transparent"}}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
            <div style={{padding:"10px",maxHeight:"340px",overflowY:"auto"}}>

              {activeTab==="nwp" && (
                <div>
                  <div style={{fontSize:"9px",fontFamily:"monospace",color:"#475569",marginBottom:"6px"}}>
                    Peluang hujan per jam (proxy, bukan peluang TS langsung) · Window Kaltim 06-14Z (14-22 WITA)
                  </div>
                  {nwpLoading
                    ? <div style={{fontSize:"9px",color:"#22C55E",textAlign:"center",padding:"10px"}}>⟳ Fetching ECMWF & GFS...</div>
                    : nwpRows.length === 0
                      ? <div style={{fontSize:"9px",color:"#334155",textAlign:"center"}}>Tidak ada data NWP</div>
                      : nwpRows.map((r,i)=>(
                          <ProbBar key={i} label={`Jam ${r.hour}`} ecmwf={r.pE} gfs={r.pG} final={r.pFinal} />
                        ))
                  }
                  {nwpSummary && (
                    <div style={{marginTop:"8px",background:"#080F1A",borderRadius:"5px",padding:"7px 9px",border:`1px solid ${nwpIsFallback?"#92400E60":(nwpSummary.consistent?"#16653460":"#92400E60")}`}}>
                      <div style={{fontSize:"9px",fontFamily:"monospace",color:nwpIsFallback?"#FCD34D":(nwpSummary.consistent?"#22C55E":"#FCD34D"),fontWeight:"700"}}>
                        {nwpIsFallback ? "⚠ FALLBACK: " : "KONSENSUS MODEL: "}{nwpSummary.status}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab==="metar" && (
                <div>
                  <div style={{fontSize:"9px",fontFamily:"monospace",color:"#475569",marginBottom:"5px"}}>
                    {metarLoading ? "⟳ Membaca file..." : `${metarData.length} laporan · ${metarSource}`}
                  </div>
                  {metarData.map((r,i)=>(
                    <div key={i} style={{fontSize:"9px",fontFamily:"monospace",padding:"4px 0",borderBottom:"1px solid #0F2235",display:"grid",gridTemplateColumns:"52px 90px 48px 56px 1fr 40px",gap:"4px",alignItems:"center"}}>
                      <span style={{color:"#7DD3FC"}}>{r.time}</span>
                      <span style={{color:"#CBD5E1"}}>{r.windStr}</span>
                      <span style={{color:r.vis<5000?"#FCD34D":"#64748B"}}>{r.vis}M</span>
                      <span style={{color:r.wx.includes("TS")?"#FCA5A5":r.wx?"#FCD34D":"#334155"}}>{r.wx||"—"}</span>
                      <span style={{color:"#475569",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.cloudStr}</span>
                      <CatBadge cat={r.cat}/>
                    </div>
                  ))}
                </div>
              )}

              {activeTab==="raw" && (
                <div>
                  {metarRaw.map((r,i)=>(
                    <div key={i} style={{fontSize:"8.5px",fontFamily:"monospace",color:"#64748B",padding:"3px 0",borderBottom:"1px solid #0F2235",wordBreak:"break-all",lineHeight:"1.5"}}>
                      <span style={{color:"#334155"}}>{i+1}.</span> {r}
                    </div>
                  ))}
                </div>
              )}

            </div>
          </div>
        </div>

        {/* ══ COL 2: Engine ══ */}
        <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>

          {inputMode==="UPLOAD" && (
            <div style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"10px",padding:"12px"}}>
              <div style={{fontSize:"10px",color:"#7DD3FC",fontWeight:"700",marginBottom:"6px"}}>📁 UPLOAD FILE METAR</div>
              <div style={{fontSize:"8.5px",color:"#64748B",lineHeight:"1.5",marginBottom:"8px"}}>
                File teks (.txt/.csv/.log), satu laporan METAR mentah per baris. Baris yang tidak cocok pola METAR akan diabaikan otomatis.
              </div>
              <label style={{display:"block",background:"#080F1A",border:"1px dashed #1E3A5F",borderRadius:"6px",padding:"16px",textAlign:"center",cursor:"pointer"}}>
                <input type="file" accept=".txt,.csv,.log,text/plain" onChange={handleFileUpload} style={{display:"none"}} />
                <div style={{fontSize:"10px",color:"#7DD3FC"}}>⬆ Klik untuk pilih file</div>
                <div style={{fontSize:"8.5px",color:"#475569",marginTop:"3px"}}>{uploadedFileName || "Belum ada file dipilih"}</div>
              </label>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:"8px"}}>
                <span style={{fontSize:"8.5px",color:"#475569",fontFamily:"monospace"}}>
                  {metarLoading ? "⟳ Membaca file..." : metarData.length > 0 ? `${metarData.length} laporan terbaca` : "Menunggu file"}
                </span>
                <button onClick={handleDownloadSample} style={{background:"transparent",border:"1px solid #1E3A5F",color:"#475569",borderRadius:"4px",padding:"4px 8px",fontSize:"8.5px",cursor:"pointer"}}>
                  📄 Unduh contoh format
                </button>
              </div>
            </div>
          )}

          {inputMode==="MANUAL" && (
            <div style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"10px",padding:"12px"}}>
              <div style={{fontSize:"10px",color:"#7DD3FC",fontWeight:"700",marginBottom:"6px"}}>📝 TEMPEL METAR MANUAL</div>
              <textarea rows={5} value={manualText} onChange={e=>setManualText(e.target.value)} placeholder={"METAR WALS 210600Z 15008KT 9999 FEW018 SCT080 31/25 Q1008\n..."}
                style={{width:"100%",background:"#080F1A",border:"1px solid #1E3A5F",color:"#22C55E",fontSize:"9.5px",fontFamily:"monospace",padding:"8px",outline:"none",borderRadius:"4px",resize:"vertical"}}
              />
              <button onClick={handleProcessManual} style={{marginTop:"6px",background:"#1E3A8A",border:"1px solid #2563EB",color:"#93C5FD",borderRadius:"4px",padding:"5px 12px",fontSize:"9px",cursor:"pointer"}}>
                ▶ Proses Data
              </button>
            </div>
          )}

          {/* Engine Explainer */}
          <div style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"10px",padding:"14px"}}>
            <SectionHeader icon="🧮" title="Mesin Sintesis TAF 24H" sub="Heuristik rule-based + rata-rata tertimbang dua model NWP (bukan model ML terlatih)" />
            <div style={{display:"flex",flexDirection:"column",gap:"7px"}}>
              {[
                {n:"1",title:"Partisi Data METAR (dari file upload) + Aturan Penyesuaian",desc:"METAR diambil dari file yang diupload pengguna (bukan API live), lalu dibagi menjadi kelompok baru (0-12 jam) dan lama (12-24 jam). Frekuensi TS dihitung dengan Laplace Smoothing (α=1), lalu disesuaikan via aturan if/else tetap — ini heuristik, bukan cross-validation atau pembelajaran mesin.",border:"#1E3A5F"},
                {n:"2",title:"Dual-Model NWP (ECMWF IFS025 vs GFS Seamless)",desc:"2 request terpisah ke Open-Meteo, difilter ke tanggal kalender target (bukan cuma jam-of-day) supaya data besok/lusa tidak tercampur. Nilai yang dipakai adalah peluang hujan umum — proxy kasar untuk peluang TS, bukan pengukuran langsung. Gap ≤15% → rata-rata; jika divergen → prioritas ECMWF.",border:nwpSummary?.consistent?"#166534":"#92400E"},
                {n:"3",title:"Rata-rata Tertimbang (60% NWP + 40% METAR)",desc:"Bobot tetap yang dipilih sebagai heuristik operasional (terinspirasi gagasan umum blending MOS), BUKAN hasil kalibrasi Bayesian atau statistik formal.",border:"#1E4A7F"},
                {n:"4",title:"Aturan ICAO → Format TAF",desc:"P≥50%→TEMPO | 40-49%→PROB40 TEMPO | 30-39%→PROB30 TEMPO | <30%→tidak ada grup. Isi grup (angin/vis/awan) sekarang diturunkan dari baseline aktual, bukan string statis. Tanda '=' hanya di akhir TAF.",border:"#4A3A00"},
              ].map(({n,title,desc,border})=>(
                <div key={n} style={{background:"#080F1A",padding:"8px 10px",borderRadius:"6px",border:`1px solid ${border}`}}>
                  <div style={{fontSize:"10px",color:"#7DD3FC",fontWeight:"700",marginBottom:"2px"}}>{n}. {title}</div>
                  <div style={{fontSize:"8.5px",color:"#64748B",lineHeight:"1.5"}}>{desc}</div>
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={generateTAF}
            disabled={generating || metarLoading || nwpLoading}
            style={{
              background: (generating || metarLoading || nwpLoading) ? "#1A3A5F" : "linear-gradient(135deg,#1E90FF,#0055CC)",
              border:"none",borderRadius:"8px",padding:"13px",fontSize:"12px",fontWeight:"700",
              color:(generating || metarLoading || nwpLoading) ? "#475569" : "#fff",
              cursor:(generating || metarLoading || nwpLoading) ? "not-allowed" : "pointer",
              letterSpacing:"0.06em",boxShadow:"0 4px 16px #1E90FF30"
            }}
          >
            {generating ? "⟳ Menghitung heuristik & NWP..." : (metarLoading || nwpLoading) ? "⟳ Menunggu data METAR/NWP..." : "✨ GENERATE TAF 24 JAM"}
          </button>
          {formError && (
            <div style={{fontSize:"9px",color:"#FCA5A5",fontFamily:"monospace",marginTop:"-4px"}}>⚠ {formError}</div>
          )}

          {reasoning && (
            <div style={{background:"#0E2A45",border:"1px solid #1E3A5F",borderRadius:"8px",padding:"12px",maxHeight:"280px",overflowY:"auto"}}>
              <div style={{fontSize:"10px",color:"#7DD3FC",fontWeight:"700",marginBottom:"6px"}}>💡 TRACE PERHITUNGAN & ANALISIS BLENDING</div>
              <pre style={{fontSize:"9px",color:"#CBD5E1",lineHeight:"1.8",whiteSpace:"pre-wrap",margin:0,fontFamily:"monospace"}}>{reasoning}</pre>
            </div>
          )}
        </div>

        {/* ══ COL 3: Terminal Output ══ */}
        <div style={{display:"flex",flexDirection:"column",gap:"10px"}}>
          <div style={{background:"#000D06",border:"1px solid #004D1A",borderRadius:"10px",overflow:"hidden",flex:"1"}}>
            <div style={{background:"#001208",borderBottom:"1px solid #003D12",padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",gap:"5px"}}>
                {["#FF5F56","#FFBD2E","#27C93F"].map(c=><div key={c} style={{width:"9px",height:"9px",borderRadius:"50%",background:c}}/>)}
                <span style={{fontSize:"9px",fontFamily:"monospace",color:"#22C55E",marginLeft:"4px"}}>AFIS TERMINAL · {station} TAF</span>
              </div>
              <button onClick={handleCopy} disabled={!tafOutput} style={{background:copied?"#14532D":"#001208",border:`1px solid ${copied?"#166534":"#003D12"}`,borderRadius:"3px",padding:"2px 7px",fontSize:"9px",fontFamily:"monospace",color:copied?"#22C55E":"#475569",cursor:tafOutput?"pointer":"default"}}>
                {copied?"✓ COPIED":"COPY"}
              </button>
            </div>
            <div style={{padding:"14px",minHeight:"220px"}}>
              {generating
                ? <div style={{fontSize:"10px",fontFamily:"monospace",color:"#22C55E"}}><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span> Mengevaluasi model & kalkulasi probabilitas...</div>
                : tafOutput
                  ? <pre style={{fontFamily:"'JetBrains Mono',monospace",fontSize:"11px",color:"#22C55E",lineHeight:"1.9",whiteSpace:"pre-wrap",margin:0,textShadow:"0 0 7px #22C55E25"}}>{tafOutput}</pre>
                  : <div style={{fontSize:"10px",fontFamily:"monospace",color:"#0F3020",textAlign:"center",marginTop:"80px"}}>Klik GENERATE TAF 24 JAM...</div>
              }
            </div>
          </div>

          {/* Struktur TAF */}
          <div style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"10px",padding:"12px"}}>
            <SectionHeader icon="🏗️" title="Struktur TAF ICAO" sub="Format WMO No.49" />
            <div style={{fontFamily:"monospace",fontSize:"9px",lineHeight:"2"}}>
              {[
                ["#7DD3FC","TAF","Header jenis pesan"],
                ["#22C55E","WALS","ICAO 4 huruf"],
                ["#A78BFA","210500Z","Tgl/jam penerbitan UTC"],
                ["#F59E0B","2106/2206","Valid period DDHH/DDHH"],
                ["#60A5FA","14008KT","Angin arah/kecepatan KT"],
                ["#34D399","9999","Vis meter (9999=≥10km)"],
                ["#FCA5A5","SCT018CB","Awan jumlah/tinggi/CB"],
                ["#FCD34D","PROB40 TEMPO","Grup perubahan sementara"],
                ["#94A3B8","=","Tanda akhir seluruh TAF"],
              ].map(([c,k,d])=>(
                <div key={k} style={{display:"flex",gap:"8px"}}>
                  <span style={{color:c,minWidth:"88px"}}>{k}</span>
                  <span style={{color:"#334155",fontSize:"8.5px"}}>{d}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Export */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"7px"}}>
            {[
              {icon:"📋",label:"Salin AFTN",fn:handleCopy},
              {icon:"📄",label:"Export .txt",fn:()=>{
                if(!tafOutput) return;
                const blob=new Blob([tafOutput],{type:"text/plain"});
                const a=document.createElement("a");
                a.href=URL.createObjectURL(blob);
                a.download=`TAF_${station}_${issueDate}${issueTime}Z.txt`;
                a.click();
              }},
            ].map(({icon,label,fn})=>(
              <button key={label} onClick={fn} disabled={!tafOutput} style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"7px",padding:"9px",fontSize:"10px",color:tafOutput?"#94A3B8":"#1E3A5F",cursor:tafOutput?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",gap:"5px"}}>
                {icon} {label}
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
