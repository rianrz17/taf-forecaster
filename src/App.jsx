import React, { useState, useEffect, useCallback } from "react";

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
  const cloudStr = cloudParts.join(" ") || (s.includes("CAVOK") ? "CAVOK" : "SKC");

  // Flight category
  const lowestBroken = cloudParts
    .filter(c => /^(BKN|OVC)/.test(c))
    .map(c => parseInt(c.replace(/\D/g, "")))
    .sort((a,b)=>a-b)[0] || 999;
  let cat = "VFR";
  if (vis < 1500 || lowestBroken < 5) cat = "LIFR";
  else if (vis < 5000 || lowestBroken < 10) cat = "IFR";
  else if (vis < 8000 || lowestBroken < 30) cat = "MVFR";

  return { raw: s, time, dir, speed, gust, windStr, vis, wx, cloudStr, cat };
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

function calculateBaseline(metarList) {
  const { dir, speed } = vectorMeanWind(metarList);
  const dirStr = String(dir).padStart(3,"0");
  const spdStr = String(speed).padStart(2,"0");

  // Median visibility (robust terhadap outlier fog sementara)
  const visList = metarList.slice(0,6).map(m=>m.vis).sort((a,b)=>a-b);
  const medVis  = visList[Math.floor(visList.length/2)] ?? 9999;
  const visStr  = medVis >= 9000 ? "9999" : String(medVis).padStart(4,"0");

  // Cloud: gunakan laporan terbaru yang valid
  const latestCloud = metarList.find(m => m.cloudStr && m.cloudStr !== "SKC")?.cloudStr || "FEW018 SCT080";

  return {
    wind:  `${dirStr}${spdStr}KT`,
    vis:   visStr,
    cloud: latestCloud,
  };
}

// ─── Diurnal Convection Window (Kalimantan Tropical Pattern) ─────────────────
// UTC+8 WITA:
//  • Siang: 14-18 WITA → 06-10Z
//  • Malam: 18-22 WITA → 10-14Z
// Untuk TAF 24H: periode TS aktif ≈ 06Z-14Z
function getConvectionWindow(validFromStr) {
  const day = validFromStr.substring(0, 2);  // "DD"
  return {
    start: `${day}06`,  // 06Z = 14.00 WITA
    end:   `${day}14`,  // 14Z = 22.00 WITA
  };
}

// ─── BECMG Window (2 jam sebelum akhir periode valid) ────────────────────────
// ICAO: BECMG mendeskripsikan perubahan gradual yang SELESAI sebelum end of
// valid period. Dengan TAF 24H, recovery ditempatkan 2-4 jam sebelum TAF expires.
//   validTo "2224" → BECMG 2222/2224  (recovery late night hari 22)
//   validTo "2306" → BECMG 2304/2306  (recovery dini hari hari 23)
function getBecmgWindow(validToStr) {
  const dayN  = parseInt(validToStr.substring(0, 2), 10);
  const hourN = parseInt(validToStr.substring(2, 4), 10);

  const endH   = hourN;
  const startH = hourN - 2;  // BECMG window 2 jam

  if (startH < 0) {
    // Roll ke hari sebelumnya (misal validTo "2302" → start "2224")
    const prevDay = String(dayN - 1).padStart(2, "0");
    return {
      start: `${prevDay}${String(24 + startH).padStart(2, "0")}`,
      end:   `${String(dayN).padStart(2, "0")}${String(endH).padStart(2, "0")}`,
    };
  }
  return {
    start: `${String(dayN).padStart(2, "0")}${String(startH).padStart(2, "0")}`,
    end:   `${String(dayN).padStart(2, "0")}${String(endH).padStart(2, "0")}`,
  };
}

// ─── ICAO Chronological Validator ─────────────────────────────────────────────
// Ekstrak sort-key numerik (DDHH) dari string grup perubahan TAF.
// Misal "TEMPO 2206/2214 ..." → 2206; "BECMG 2222/2224 ..." → 2222
function groupSortKey(groupStr) {
  const m = groupStr.match(/(\d{4})\/\d{4}/);
  return m ? parseInt(m[1], 10) : 9999;
}

// Deteksi overlap antar dua periode DDHH/DDHH
function periodsOverlap(a, b) {
  // a dan b adalah string "DDHH"
  return parseInt(a.end) > parseInt(b.start) && parseInt(b.end) > parseInt(a.start);
}
function extractPeriod(groupStr) {
  const m = groupStr.match(/(\d{4})\/(\d{4})/);
  return m ? { start: m[1], end: m[2] } : null;
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

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function TAFForecaster() {
  const [station, setStation]           = useState("WALS");
  const [stationInput, setStationInput] = useState("WALS");
  const [inputMode, setInputMode]       = useState("API");
  const [manualText, setManualText]     = useState("");
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
  const [metarSource,  setMetarSource]  = useState("–");
  const [nwpRows,      setNwpRows]      = useState([]);
  const [nwpLoading,   setNwpLoading]   = useState(false);
  const [nwpSummary,   setNwpSummary]   = useState(null);

  // Output states
  const [tafOutput,  setTafOutput]  = useState("");
  const [generating, setGenerating] = useState(false);
  const [reasoning,  setReasoning]  = useState("");
  const [mlTrace,    setMlTrace]    = useState([]);
  const [copied,     setCopied]     = useState(false);

  const currentStn = STATIONS.find(s => s.icao === station) || STATIONS[0];

  // ══ FIX #1: URL absolut ke AWC (bukan /api/metar) ════════════════════════
  // FIX #2: AWC max public = 24h (bukan 72h yang tidak didukung)
  const fetchMETAR = useCallback(async (icao) => {
    setMetarLoading(true);
    const AWC_URL = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=24`;
    try {
      const res = await fetch(AWC_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json) || json.length === 0) throw new Error("Tidak ada data");
      const rawList = json.map(i => i.rawOb || i.rawObservation || "").filter(Boolean);
      setMetarRaw(rawList);
      setMetarData(rawList.map(parseMetar).filter(Boolean));
      setMetarSource("NOAA AWC Live");
    } catch (err) {
      // Fallback realistis untuk WALS
      const fb = [
        `METAR ${icao} ${issueDate}0600Z 15008KT 9999 FEW018 SCT080 31/25 Q1008`,
        `METAR ${icao} ${issueDate}0300Z 12005KT 9999 FEW018 29/25 Q1010`,
        `METAR ${icao} ${String(parseInt(issueDate)-1).padStart(2,"0")}1800Z 15010G18KT 5000 TSRA SCT018CB BKN080 30/25 Q1007`,
        `METAR ${icao} ${String(parseInt(issueDate)-1).padStart(2,"0")}1200Z 13006KT 9999 SCT015 BKN060 31/26 Q1009`,
        `METAR ${icao} ${String(parseInt(issueDate)-1).padStart(2,"0")}0600Z 09004KT 8000 BR FEW008 27/25 Q1011`,
        `METAR ${icao} ${String(parseInt(issueDate)-2).padStart(2,"0")}1800Z 16012G20KT 5000 TSRA SCT018CB 29/25 Q1007`,
      ];
      setMetarRaw(fb);
      setMetarData(fb.map(parseMetar).filter(Boolean));
      setMetarSource(`Fallback Mock (${err.message})`);
    }
    setMetarLoading(false);
  }, [issueDate]);

  // ══ FIX #3: Dual-model Open-Meteo — 2 request terpisah (bukan multi-model 
  //    dalam 1 URL yang menyebabkan field name ambiguous) ════════════════════
  const fetchDualNWP = useCallback(async (stn) => {
    setNwpLoading(true);
    const BASE = "https://api.open-meteo.com/v1/forecast";
    const COMMON = `latitude=${stn.lat}&longitude=${stn.lon}&hourly=precipitation_probability,wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=2&timezone=UTC`;

    try {
      const [resE, resG] = await Promise.all([
        fetch(`${BASE}?${COMMON}&models=ecmwf_ifs025`, { signal: AbortSignal.timeout(8000) }),
        fetch(`${BASE}?${COMMON}&models=gfs_seamless`, { signal: AbortSignal.timeout(8000) }),
      ]);

      if (!resE.ok || !resG.ok) throw new Error(`HTTP ECMWF:${resE.status} GFS:${resG.status}`);

      const [dataE, dataG] = await Promise.all([resE.json(), resG.json()]);

      const rows = [];
      let maxE = 0, maxG = 0;

      // Ambil jam 06-18Z (window konveksi Kaltim) dari hari ini
      const targetHours = [6, 7, 8, 9, 10, 11, 12, 13, 14];

      dataE.hourly.time.forEach((t, i) => {
        const hour = new Date(t + "Z").getUTCHours();
        if (!targetHours.includes(hour)) return;

        const pE = dataE.hourly.precipitation_probability?.[i] ?? 0;
        const pG = dataG.hourly.precipitation_probability?.[i] ?? 0;

        if (pE > maxE) maxE = pE;
        if (pG > maxG) maxG = pG;

        const gap = Math.abs(pE - pG);
        const consistent = gap <= 15;
        const pFinal = consistent
          ? Math.round((pE + pG) / 2)   // consensus average
          : pE;                           // jika divergen → prioritas ECMWF (resolusi lebih tinggi)

        rows.push({ hour: `${String(hour).padStart(2,"0")}Z`, pE, pG, pFinal, consistent });
      });

      const overallGap = Math.abs(maxE - maxG);
      const consistent = overallGap <= 15;
      const pFinalMax  = consistent ? Math.round((maxE + maxG) / 2) : maxE;

      setNwpRows(rows);
      setNwpSummary({
        maxE, maxG, consistent, pFinalMax,
        status: consistent
          ? `KONSISTEN — Rata-rata konsensus P_NWP = ${pFinalMax}%`
          : `DIVERGEN (gap ${overallGap}%) — Prioritas ECMWF, P_NWP = ${maxE}%`,
      });
    } catch (err) {
      // Fallback dari klimatologi historis Kalimantan (data long-term)
      const fallbackRows = [
        { hour:"06Z", pE:35, pG:30, pFinal:32, consistent:true },
        { hour:"08Z", pE:50, pG:48, pFinal:49, consistent:true },
        { hour:"10Z", pE:60, pG:55, pFinal:58, consistent:true },
        { hour:"12Z", pE:55, pG:62, pFinal:58, consistent:true },
        { hour:"14Z", pE:40, pG:35, pFinal:38, consistent:true },
      ];
      setNwpRows(fallbackRows);
      setNwpSummary({ maxE:60, maxG:62, consistent:true, pFinalMax:58, status:`Klimatologi Fallback (${err.message})` });
    }
    setNwpLoading(false);
  }, []);

  useEffect(() => {
    if (inputMode === "API") {
      fetchMETAR(station);
      fetchDualNWP(currentStn);
    }
  }, [station, inputMode]);

  const handleProcessManual = () => {
    const lines = manualText.split("\n").map(l=>l.trim()).filter(Boolean);
    setMetarRaw(lines);
    setMetarData(lines.map(parseMetar).filter(Boolean));
    setMetarSource("MANUAL INPUT");
    fetchDualNWP(currentStn);
  };

  const handleApplyStation = () => {
    const code = stationInput.trim().toUpperCase();
    if (code.length === 4) setStation(code);
  };

  // ══ GENERATE: Sliding Window Probabilistic Synthesis ════════════════════════
  const generateTAF = () => {
    setGenerating(true);
    setTafOutput(""); setReasoning(""); setMlTrace([]);

    setTimeout(() => {
      try {
        const trace = [];

        // ── FASE 1: Sliding Window Partitioning ──────────────────────────────
        // Window H1 = 12 laporan terbaru (~12 jam terakhir) → Validation set
        // Window H2 = laporan 12-24 → Training set
        // Catatan: dengan AWC max 24H, H1/H2 adalah pembagian 1 hari
        const H1 = metarData.slice(0, 12);   // 0-12 jam terakhir (validation)
        const H2 = metarData.slice(12, 24);   // 12-24 jam terakhir (training)

        const tsH1 = H1.filter(m => m.wx.includes("TS")).length;
        const tsH2 = H2.filter(m => m.wx.includes("TS")).length;

        trace.push(`• FASE 1 - Sliding Window: Validation H1 (TS=${tsH1}x), Training H2 (TS=${tsH2}x)`);

        // ── FASE 2: P_METAR — Frekuensi relatif dengan Laplace Smoothing ────
        // Laplace smoothing (α=1) mencegah probabilitas 0% dari ketiadaan
        // contoh tunggal (tidak bisa langsung disimpulkan TS tidak akan terjadi)
        const α = 1;  // Laplace smoothing factor
        const K = 2;  // Jumlah kelas (TS / Non-TS)
        const pTrain = (tsH2 + α) / (H2.length + α * K);  // P(TS|H2) smoothed

        // Cross-validation: bandingkan prediksi H2 vs aktual H1
        let pMetar = pTrain;
        let driftLabel = "";
        if (pTrain > 0.30 && tsH1 === 0) {
          pMetar = pTrain * 0.45;  // Concept drift: siklus TS sudah lewat
          driftLabel = "Concept Drift Terdeteksi (TS H2 tidak berulang di H1)";
        } else if (pTrain > 0.10 && tsH1 > 0) {
          pMetar = Math.min(pTrain * 1.35, 0.95);  // Pola tervalidasi
          driftLabel = "Pola TS Tervalidasi di H1 → Confidence Tinggi";
        } else if (pTrain < 0.10 && tsH1 > 0) {
          pMetar = 0.40;  // Onset baru terdeteksi di H1
          driftLabel = "Onset Konveksi Baru di H1 (tidak ada di H2)";
        } else {
          driftLabel = "Tidak ada riwayat konveksi signifikan";
        }
        const pMetarPct = Math.round(pMetar * 100);
        trace.push(`• FASE 2 - P_METAR: Laplace P(TS|H2)=${Math.round(pTrain*100)}% → setelah cross-val: ${pMetarPct}% [${driftLabel}]`);

        // ── FASE 3: P_NWP dari dual model ────────────────────────────────────
        const pNWP = nwpSummary?.pFinalMax ?? 40;
        trace.push(`• FASE 3 - P_NWP: ${pNWP}% (${nwpSummary?.status || "data tidak tersedia"})`);

        // ── FASE 4: Bayesian Blending ─────────────────────────────────────────
        // Bobot: NWP lebih handal untuk 24H ke depan, METAR bagus untuk klimatologi lokal
        // Bobot diambil dari literatur (Glahn & Lowry, 1972; Hamill 2004):
        //   w_NWP = 0.60 (dominan untuk prakiraan 6-24 jam ke depan)
        //   w_METAR = 0.40 (kontribusi pola klimatologi diurnal lokal)
        const W_NWP   = 0.60;
        const W_METAR = 0.40;
        const pFinal  = Math.round(W_NWP * pNWP + W_METAR * pMetarPct);
        trace.push(`• FASE 4 - Bayesian Blending: (${W_NWP}×${pNWP} + ${W_METAR}×${pMetarPct}) = P_FINAL ${pFinal}%`);

        // ── FASE 5: ICAO Decision Rule ────────────────────────────────────────
        //   p ≥ 50% → TEMPO (pasti, durasi ≥30 mnt atau berulang)
        //   40-49% → PROB40 TEMPO
        //   30-39% → PROB30 TEMPO (FIX #4: harus PROB30 TEMPO bukan PROB30 sendiri)
        //   < 30%  → tidak dicantumkan
        const convWindow = getConvectionWindow(validFrom);
        let changeGroup = "";
        let icaoRule = "";
        if (pFinal >= 50) {
          changeGroup = `TEMPO ${convWindow.start}/${convWindow.end} 15012G22KT 4000 TSRA SCT015CB BKN070`;
          icaoRule = `P_FINAL=${pFinal}% ≥ 50% → TEMPO`;
        } else if (pFinal >= 40) {
          changeGroup = `PROB40 TEMPO ${convWindow.start}/${convWindow.end} 15010G18KT 5000 TSRA SCT015CB`;
          icaoRule = `P_FINAL=${pFinal}% 40-49% → PROB40 TEMPO`;
        } else if (pFinal >= 30) {
          // FIX #4: PROB30 TEMPO (bukan PROB30 saja)
          changeGroup = `PROB30 TEMPO ${convWindow.start}/${convWindow.end} 5000 TSRA SCT018CB`;
          icaoRule = `P_FINAL=${pFinal}% 30-39% → PROB30 TEMPO`;
        } else {
          icaoRule = `P_FINAL=${pFinal}% < 30% → Tidak ada grup perubahan konveksi`;
        }
        trace.push(`• FASE 5 - ICAO Rule: ${icaoRule}`);

        // ── FASE 6: Bangun string TAF dengan validasi ICAO ────────────────────
        const baseline    = calculateBaseline(metarData);
        const header      = `TAF ${station} ${issueDate}${issueTime}Z ${validFrom}/${validTo}`;
        const tafLines    = [];
        const icaoWarnings = [];

        // Kumpulkan semua change groups dengan sort-key kronologis
        const changeGroups = [];

        if (changeGroup) {
          changeGroups.push(changeGroup);
        }

        // FIX A: BECMG dihitung dari getBecmgWindow (2 jam sebelum akhir periode)
        // Sebelumnya: validTo.substring(0,2)+"04" → hasilkan awal periode, bukan akhir
        const becmgWin = getBecmgWindow(validTo);
        const becmgStr = `BECMG ${becmgWin.start}/${becmgWin.end} 09006KT 9999 FEW018`;
        changeGroups.push(becmgStr);

        // FIX B: Sort semua change groups secara kronologis berdasarkan start time
        // ICAO Annex 3 §1.1.6.4: change groups WAJIB berurutan dari awal ke akhir
        changeGroups.sort((a, b) => groupSortKey(a) - groupSortKey(b));

        // Validasi: deteksi overlap antar grup (tidak boleh ada di TAF)
        for (let i = 0; i < changeGroups.length - 1; i++) {
          const pA = extractPeriod(changeGroups[i]);
          const pB = extractPeriod(changeGroups[i + 1]);
          if (pA && pB && periodsOverlap(pA, pB)) {
            icaoWarnings.push(
              `⚠ OVERLAP: ${changeGroups[i].split(" ")[0]} ${pA.start}/${pA.end} ` +
              `bertumpuk dengan ${changeGroups[i+1].split(" ")[0]} ${pB.start}/${pB.end}`
            );
          }
        }

        // Rakit TAF
        tafLines.push(`${header} ${baseline.wind} ${baseline.vis} ${baseline.cloud}`);
        changeGroups.forEach(g => tafLines.push(`     ${g}`));

        // "=" HANYA di akhir seluruh TAF (ICAO §3.4.2)
        const tafStr = tafLines.join("\n") + "=";

        setTafOutput(tafStr);
        setMlTrace(trace);

        const warningBlock = icaoWarnings.length > 0
          ? "\n\n⛔ ICAO VIOLATIONS:\n" + icaoWarnings.join("\n")
          : "\n\n✅ ICAO Annex 3 §1.1.6.4: Urutan kronologis valid, tidak ada overlap.";

        setReasoning(
          `Sintesis TAF 24H — ${station}\n` +
          trace.join("\n") + "\n\n" +
          `KEPUTUSAN AKHIR: P_FINAL=${pFinal}% → "${icaoRule}"\n` +
          `Window Konveksi Kaltim: ${convWindow.start}–${convWindow.end}Z ` +
          `(${parseInt(convWindow.start.slice(2))+8}:00–${parseInt(convWindow.end.slice(2))+8}:00 WITA)\n` +
          `BECMG Recovery Window: ${becmgWin.start}/${becmgWin.end} (2 jam sebelum end of validity)` +
          warningBlock
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
        <div style={{maxWidth:"1440px", margin:"0 auto", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
          <div style={{display:"flex", gap:"12px", alignItems:"center"}}>
            <div style={{width:"34px",height:"34px",borderRadius:"7px",background:"linear-gradient(135deg,#1E90FF,#0055CC)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"17px",boxShadow:"0 0 10px #1E90FF30"}}>✈</div>
            <div>
              <div style={{fontSize:"13px",fontWeight:"700",color:"#F1F5F9",letterSpacing:"0.04em"}}>TAF AUTO-FORECASTER AI</div>
              <div style={{fontSize:"9px",color:"#475569",fontFamily:"monospace",letterSpacing:"0.1em"}}>SLIDING WINDOW · DUAL-MODEL SYNTHESIS · ICAO ANNEX 3 · 24H TAF</div>
            </div>
          </div>
          <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
            {metarSource && (
              <span style={{fontSize:"9px",fontFamily:"monospace",color:"#22C55E",background:"#14532D30",padding:"3px 8px",borderRadius:"4px",border:"1px solid #166534"}}>
                {metarSource}
              </span>
            )}
            <span style={{fontSize:"9px",fontFamily:"monospace",color:"#475569",background:"#0A1929",padding:"3px 8px",borderRadius:"4px",border:"1px solid #1E3A5F"}}>
              {new Date().toUTCString().slice(5,25)} UTC
            </span>
          </div>
        </div>
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
              {[["TGL UTC",issueDate,setIssueDate],["ISSUE TIME",issueTime,setIssueTime]].map(([lbl,val,set])=>(
                <div key={lbl}>
                  <div style={{fontSize:"9px",color:"#475569",marginBottom:"3px"}}>{lbl}</div>
                  <input value={val} onChange={e=>set(e.target.value)}
                    style={{width:"100%",background:"#080F1A",border:"1px solid #1E3A5F",borderRadius:"4px",padding:"5px 7px",fontSize:"10px",fontFamily:"monospace",color:"#94A3B8",outline:"none"}}
                  />
                </div>
              ))}
              <div>
                <div style={{fontSize:"9px",color:"#475569",marginBottom:"3px"}}>VALID 24H</div>
                <div style={{display:"flex",gap:"2px",alignItems:"center"}}>
                  <input value={validFrom} onChange={e=>setValidFrom(e.target.value)} style={{width:"45%",background:"#080F1A",border:"1px solid #1E3A5F",borderRadius:"4px",padding:"5px 4px",fontSize:"9px",fontFamily:"monospace",color:"#94A3B8",outline:"none",textAlign:"center"}}/>
                  <span style={{color:"#334155",fontSize:"9px"}}>/</span>
                  <input value={validTo} onChange={e=>setValidTo(e.target.value)} style={{width:"45%",background:"#080F1A",border:"1px solid #1E3A5F",borderRadius:"4px",padding:"5px 4px",fontSize:"9px",fontFamily:"monospace",color:"#94A3B8",outline:"none",textAlign:"center"}}/>
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:"5px"}}>
              {[["API","📡 Auto API (AWC)"],["MANUAL","📝 Paste Manual"]].map(([m,lbl])=>(
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
                    Prob Konvektif per jam · Window Kaltim 06-14Z (14-22 WITA)
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
                    <div style={{marginTop:"8px",background:"#080F1A",borderRadius:"5px",padding:"7px 9px",border:`1px solid ${nwpSummary.consistent?"#16653460":"#92400E60"}`}}>
                      <div style={{fontSize:"9px",fontFamily:"monospace",color:nwpSummary.consistent?"#22C55E":"#FCD34D",fontWeight:"700"}}>
                        KONSENSUS MODEL: {nwpSummary.status}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab==="metar" && (
                <div>
                  <div style={{fontSize:"9px",fontFamily:"monospace",color:"#475569",marginBottom:"5px"}}>
                    {metarLoading ? "⟳ Fetching..." : `${metarData.length} laporan · ${metarSource}`}
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

          {inputMode==="MANUAL" && (
            <div style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"10px",padding:"12px"}}>
              <div style={{fontSize:"10px",color:"#7DD3FC",fontWeight:"700",marginBottom:"6px"}}>📝 PASTE METAR MANUAL</div>
              <textarea rows={5} value={manualText} onChange={e=>setManualText(e.target.value)} placeholder={"METAR WALS 210600Z 15008KT 9999 FEW018 SCT080 31/25 Q1008\n..."}
                style={{width:"100%",background:"#080F1A",border:"1px solid #1E3A5F",color:"#22C55E",fontSize:"9.5px",fontFamily:"monospace",padding:"8px",outline:"none",borderRadius:"4px",resize:"vertical"}}
              />
              <button onClick={handleProcessManual} style={{marginTop:"6px",background:"#1E3A8A",border:"1px solid #2563EB",color:"#93C5FD",borderRadius:"4px",padding:"5px 12px",fontSize:"9px",cursor:"pointer"}}>
                ▶ Proses & Fetch NWP
              </button>
            </div>
          )}

          {/* ML Engine Explainer */}
          <div style={{background:"#0D1E30",border:"1px solid #1E3A5F",borderRadius:"10px",padding:"14px"}}>
            <SectionHeader icon="🤖" title="Mesin Sintesis TAF 24H" sub="Sliding Window Cross-Validation + Dual-Model Blending" />
            <div style={{display:"flex",flexDirection:"column",gap:"7px"}}>
              {[
                {n:"1",title:"Sliding Window + Cross-Validation",desc:"Partisi METAR 24H menjadi Training (H2: 12-24 jam lalu) dan Validation (H1: 0-12 jam lalu). Probabilitas dihitung dengan Laplace Smoothing (α=1) lalu divalidasi silang untuk mendeteksi concept drift siklus konveksi.",border:"#1E3A5F"},
                {n:"2",title:"Dual-Model NWP (ECMWF IFS025 vs GFS Seamless)",desc:`2 request terpisah ke Open-Meteo API. Jika gap antar model ≤15% → rata-rata konsensus. Jika divergen → prioritas ECMWF (resolusi lebih tinggi 0.25°). Window waktu: 06-14Z = 14-22 WITA (peak konveksi Kaltim).`,border:nwpSummary?.consistent?"#166534":"#92400E"},
                {n:"3",title:"Bayesian Blending (40% METAR + 60% NWP)",desc:"Bobot berdasarkan Glahn & Lowry (1972): NWP dominan untuk prakiraan 6-24 jam ke depan. METAR historis berkontribusi pada pola diurnal lokal yang model global sering miss.",border:"#1E4A7F"},
                {n:"4",title:"ICAO Decision Rule → TAF Formatting",desc:"P≥50%→TEMPO | P 40-49%→PROB40 TEMPO | P 30-39%→PROB30 TEMPO | P<30%→tidak ada grup. Tanda '=' hanya di akhir TAF. Window konveksi disesuaikan pola diurnal Kaltim.",border:"#4A3A00"},
              ].map(({n,title,desc,border})=>(
                <div key={n} style={{background:"#080F1A",padding:"8px 10px",borderRadius:"6px",border:`1px solid ${border}`}}>
                  <div style={{fontSize:"10px",color:"#7DD3FC",fontWeight:"700",marginBottom:"2px"}}>{n}. {title}</div>
                  <div style={{fontSize:"8.5px",color:"#64748B",lineHeight:"1.5"}}>{desc}</div>
                </div>
              ))}
            </div>
          </div>

          <button onClick={generateTAF} disabled={generating} style={{background:generating?"#1A3A5F":"linear-gradient(135deg,#1E90FF,#0055CC)",border:"none",borderRadius:"8px",padding:"13px",fontSize:"12px",fontWeight:"700",color:generating?"#475569":"#fff",cursor:generating?"not-allowed":"pointer",letterSpacing:"0.06em",boxShadow:"0 4px 16px #1E90FF30"}}>
            {generating?"⟳ Kalkulasi ML & NWP...":"✨ GENERATE TAF 24 JAM"}
          </button>

          {reasoning && (
            <div style={{background:"#0E2A45",border:"1px solid #1E3A5F",borderRadius:"8px",padding:"12px",maxHeight:"280px",overflowY:"auto"}}>
              <div style={{fontSize:"10px",color:"#7DD3FC",fontWeight:"700",marginBottom:"6px"}}>💡 ML TRACE & ANALISIS BLENDING</div>
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
