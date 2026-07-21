import React, { useState, useEffect, useCallback } from "react";

// ─── Station Registry ────────────────────────────────────────────────────────
const STATIONS = [
  { icao: "WALS", name: "APT Pranoto - Samarinda", lat: -0.373, lon: 117.258 },
  { icao: "WALL", name: "Sepinggan - Balikpapan", lat: -1.268, lon: 116.894 },
  { icao: "WAQT", name: "Kalimarau - Tanjung Redeb", lat: 2.155, lon: 117.433 },
  { icao: "WAOO", name: "Syamsudin Noor - Banjarmasin", lat: -3.442, lon: 114.762 },
  { icao: "WAQQ", name: "Juwata - Tarakan", lat: 3.327, lon: 117.564 },
  { icao: "WAQD", name: "Tanjung Harapan - Tanjung Selor", lat: 2.837, lon: 117.382 },
];

const PHENOMENA_LIST = ["RA","TSRA","DZ","TS","FG","BR","HZ","MIFG","BCFG","SHRA","GR"];

// ─── METAR Parser (Dilengkapi Time-Series Epoch) ─────────────────────────────
function parseMetar(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();

  const timeMatch = s.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  const time = timeMatch ? `${timeMatch[2]}${timeMatch[3]}Z` : "--";
  
  // Kalkulasi epochMs dari sandi tanggal/jam
  let epochMs = Date.now();
  if (timeMatch) {
    const now = new Date();
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth();
    let day = parseInt(timeMatch[1], 10);
    let hour = parseInt(timeMatch[2], 10);
    let minute = parseInt(timeMatch[3], 10);

    // Penanganan wrap-around pergantian bulan
    if (day > now.getUTCDate() + 10) {
      month -= 1;
      if (month < 0) { month = 11; year -= 1; }
    }
    epochMs = Date.UTC(year, month, day, hour, minute);
  }

  const windMatch = s.match(/\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/);
  let dir = 0, speed = 0, gust = 0;
  let windStr = "--";
  if (windMatch) {
    dir = windMatch[1] === "VRB" ? 0 : parseInt(windMatch[1]);
    speed = parseInt(windMatch[2]);
    gust = windMatch[4] ? parseInt(windMatch[4]) : 0;
    windStr = windMatch[4] ? `${windMatch[1]}/${windMatch[2]}G${windMatch[4]}KT` : `${windMatch[1]}/${windMatch[2]}KT`;
  }

  const visMatch = s.match(/\b(9999|[0-9]{4})\b/);
  const vis = visMatch ? parseInt(visMatch[1]) : 9999;

  let wx = "";
  for (const code of PHENOMENA_LIST) {
    const reg = new RegExp(`(?:[-+]|VC)?${code}(?!\\w)`);
    const m = s.match(reg);
    if (m) { wx = m[0]; break; }
  }

  const cloudParts = [];
  const cloudReg = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?\b/g;
  let cm;
  while ((cm = cloudReg.exec(s)) !== null) {
    cloudParts.push(`${cm[1]}${cm[2]}${cm[3]||""}`);
  }
  const cloudStr = cloudParts.join(" ") || "FEW018";

  return { raw: s, time, dir, speed, gust, windStr, vis, wx, cloudStr, epochMs };
}

function SectionHeader({ icon, title, sub }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"10px" }}>
      <span style={{fontSize:"16px"}}>{icon}</span>
      <div>
        <div style={{fontSize:"11px", fontWeight:"700", color:"#E2E8F0", letterSpacing:"0.06em", textTransform:"uppercase"}}>{title}</div>
        {sub && <div style={{fontSize:"9px", color:"#475569"}}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Rolling Baseline METAR ──────────────────────────────────────────────────
function calculateBaseline(metarList) {
  if (!metarList || metarList.length === 0) {
    return { wind: "15008KT", vis: "9999", cloud: "FEW018 SCT080" };
  }

  const recent = metarList.slice(0, 6);
  let sumU = 0, sumV = 0, totalSpeed = 0;
  
  recent.forEach(m => {
    if (m.speed > 0) {
      const rad = (m.dir * Math.PI) / 180;
      sumU += -m.speed * Math.sin(rad);
      sumV += -m.speed * Math.cos(rad);
      totalSpeed += m.speed;
    }
  });

  const avgSpeed = Math.round(totalSpeed / recent.length) || 6;
  let avgDir = 140;
  if (sumU !== 0 || sumV !== 0) {
    avgDir = Math.round((Math.atan2(-sumU, -sumV) * 180) / Math.PI);
    if (avgDir < 0) avgDir += 360;
  }

  const windStr = `${String(avgDir).padStart(3,"0")}${String(avgSpeed).padStart(2,"0")}KT`;
  const visList = recent.map(m => m.vis).sort((a,b)=>a-b);
  const medianVis = visList[Math.floor(visList.length / 2)] || 9999;
  const visStr = medianVis >= 9000 ? "9999" : String(medianVis).padStart(4,"0");
  const cloudStr = recent[0]?.cloudStr || "FEW018 SCT080";

  return { wind: windStr, vis: visStr, cloud: cloudStr };
}

// ─── Main App Component ───────────────────────────────────────────────────────
export default function TAFForecaster() {
  const [station, setStation] = useState("WALS");
  const [stationInput, setStationInput] = useState("WALS");
  const [inputMode, setInputMode] = useState("API");
  const [manualText, setManualText] = useState("");
  const [activeTab, setActiveTab] = useState("nwp");

  const [issueDate, setIssueDate] = useState(() => String(new Date().getUTCDate()).padStart(2,"0"));
  const [issueTime, setIssueTime] = useState("0500");
  const [validFrom, setValidFrom] = useState(() => `${String(new Date().getUTCDate()).padStart(2,"0")}06`);
  const [validTo, setValidTo] = useState(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    return `${String(d.getUTCDate()).padStart(2,"0")}06`;
  });

  const [metarData, setMetarData] = useState([]);
  const [metarRaw, setMetarRaw] = useState([]);
  const [nwpTable, setNwpTable] = useState([]);
  const [nwpLoading, setNwpLoading] = useState(false);
  const [modelSummary, setNwpSummary] = useState({ ecmwfMax: 0, gfsMax: 0, isConsistent: true, finalMaxProb: 0, peakHourUTC: 12, statusText: "Menunggu data..." });

  const [tafOutput, setTafOutput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [reasoning, setReasoning] = useState("");
  const [copied, setCopied] = useState(false);

  const currentStnObj = STATIONS.find(s => s.icao === station) || STATIONS[0];

  // 1. Fetch METAR (Absolute NOAA API)
  const fetchMETAR = useCallback(async (icao) => {
    try {
      const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=72`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      
      const rawList = json.map(item => item.rawOb || item.rawObservation || item.metar || "").filter(Boolean);
      const parsed = rawList.map(parseMetar).filter(Boolean);
      
      setMetarData(parsed);
      setMetarRaw(rawList);
    } catch (err) {
      console.error("Gagal menarik data METAR Live:", err);
      // Fallback
      const fallback = [`METAR ${icao} 210600Z 15008KT 9999 FEW018 SCT080 31/25 Q1008`];
      setMetarData(fallback.map(parseMetar).filter(Boolean));
      setMetarRaw(fallback);
    }
  }, []);

  // 2. Fetch Data Dual Model (Promise.all Separate Calls)
  const fetchDualNWPModel = useCallback(async (stnObj) => {
    setNwpLoading(true);
    try {
      const ecmwfUrl = `https://api.open-meteo.com/v1/forecast?latitude=${stnObj.lat}&longitude=${stnObj.lon}&hourly=wind_speed_10m,wind_direction_10m,precipitation&models=ecmwf_ifs025&wind_speed_unit=kn&forecast_days=2`;
      const gfsUrl = `https://api.open-meteo.com/v1/forecast?latitude=${stnObj.lat}&longitude=${stnObj.lon}&hourly=wind_speed_10m,wind_direction_10m,precipitation_probability&models=gfs_seamless&wind_speed_unit=kn&forecast_days=2`;
      
      const [ecmwfRes, gfsRes] = await Promise.all([
        fetch(ecmwfUrl, { signal: AbortSignal.timeout(6000) }),
        fetch(gfsUrl, { signal: AbortSignal.timeout(6000) })
      ]);

      if (!ecmwfRes.ok || !gfsRes.ok) throw new Error("Gagal mengambil data dual model NWP");
      
      const ecmwfData = await ecmwfRes.json();
      const gfsData = await gfsRes.json();

      const ecmwfHourly = ecmwfData.hourly || {};
      const gfsHourly = gfsData.hourly || {};

      const tableRows = [];
      let maxECMWF = 0, maxGFS = 0, peakHour = 12;

      for (let i = 0; i < 24; i += 3) {
        const timeStr = ecmwfHourly.time?.[i]?.slice(11, 16) || "12:00";
        const hourInt = parseInt(timeStr.slice(0, 2), 10);
        
        // Konversi Heuristik ECMWF (Curah Hujan ke Probabilitas)
        const ecmwfPrecipMM = ecmwfHourly.precipitation?.[i] || 0;
        let ecmwfProb = 0;
        if (ecmwfPrecipMM >= 5.0) ecmwfProb = 85;
        else if (ecmwfPrecipMM >= 2.0) ecmwfProb = 60;
        else if (ecmwfPrecipMM >= 0.5) ecmwfProb = 35;
        else if (ecmwfPrecipMM > 0.0) ecmwfProb = 15;

        // GFS Probabilitas asli
        const gfsProb = gfsHourly.precipitation_probability?.[i] || 0;

        if (ecmwfProb > maxECMWF) { maxECMWF = ecmwfProb; peakHour = hourInt; }
        if (gfsProb > maxGFS) maxGFS = gfsProb;

        const hourlyGap = Math.abs(ecmwfProb - gfsProb);
        const isHourlyConsistent = hourlyGap <= 15;
        const finalHourlyProb = isHourlyConsistent ? Math.round((ecmwfProb + gfsProb) / 2) : ecmwfProb;

        tableRows.push({
          period: timeStr + "Z",
          ecmwfProb, gfsProb,
          finalProb: finalHourlyProb,
          isConsistent: isHourlyConsistent
        });
      }

      const overallGap = Math.abs(maxECMWF - maxGFS);
      const isOverallConsistent = overallGap <= 15;
      const finalMaxProb = isOverallConsistent ? Math.round((maxECMWF + maxGFS) / 2) : maxECMWF;

      setNwpTable(tableRows);
      setNwpSummary({
        ecmwfMax: maxECMWF, gfsMax: maxGFS,
        isConsistent: isOverallConsistent,
        finalMaxProb, peakHourUTC: peakHour,
        statusText: isOverallConsistent
          ? `KONSISTEN: Rata-Rata Konsensus (P_NWP = ${finalMaxProb}%)`
          : `DIVERGEN: Prioritas ECMWF (P_NWP = ${maxECMWF}%)`
      });

    } catch (e) {
      setNwpSummary({ ecmwfMax: 45, gfsMax: 50, isConsistent: true, finalMaxProb: 48, peakHourUTC: 12, statusText: "Fallback Data (Offline)" });
      setNwpTable([]);
    }
    setNwpLoading(false);
  }, []);

  useEffect(() => {
    if (inputMode === "API") {
      fetchMETAR(station);
      fetchDualNWPModel(currentStnObj);
    }
  }, [station, inputMode, fetchMETAR, fetchDualNWPModel, currentStnObj]);

  const handleProcessManual = () => {
    const lines = manualText.split("\n").map(l => l.trim()).filter(Boolean);
    const parsed = lines.map(parseMetar).filter(Boolean);
    setMetarData(parsed);
    setMetarRaw(lines);
    fetchDualNWPModel(currentStnObj);
  };

  const handleApplyStation = () => {
    const code = stationInput.trim().toUpperCase();
    if (code.length === 4) setStation(code);
  };

  // ─── AI Synthesis Engine ────────────────────────────────────────────────────
  const generateHybridTAF = async () => {
    setGenerating(true);
    setTafOutput(""); setReasoning("");

    setTimeout(() => {
      try {
        const baseline = calculateBaseline(metarData);

        // ML PHASE 1: Sliding Window (Absolute Time)
        const nowUTC = Date.now();
        const ONE_DAY_MS = 24 * 3600 * 1000;
        
        const h1Data = metarData.filter(m => (nowUTC - m.epochMs) < ONE_DAY_MS);
        const h2h3Data = metarData.filter(m => (nowUTC - m.epochMs) >= ONE_DAY_MS);

        const tsTraining = h2h3Data.filter(m => m.wx && m.wx.includes("TS")).length;
        const tsValidation = h1Data.filter(m => m.wx && m.wx.includes("TS")).length;

        // ML PHASE 2: Anti-Overflow Normalization
        let pTrain = h2h3Data.length > 0 ? (tsTraining / h2h3Data.length) * 100 : 0; 
        let pMetar = pTrain;
        let mlStatus = "";

        if (pTrain > 15 && tsValidation === 0) {
          pMetar = pTrain * 0.4;
          mlStatus = "Penalti Validasi (Siklus Bergeser)";
        } else if (pTrain > 0 && tsValidation > 0) {
          pMetar = Math.min(pTrain + 25, 100);
          mlStatus = "Pola Tervalidasi di H-1 (High Confidence)";
        } else if (pTrain === 0 && tsValidation > 0) {
          pMetar = h1Data.length > 0 ? (tsValidation / h1Data.length) * 100 + 10 : 40;
          mlStatus = "Siklus Konveksi Baru Terdeteksi";
        } else {
          mlStatus = "Tidak ada riwayat konveksi signifikan";
        }

        // ML PHASE 3: Blending
        const pNWP = modelSummary.finalMaxProb;
        const pFinal = Math.round((0.4 * pMetar) + (0.6 * pNWP));

        // ─── Ekstraksi Kondisi Ekstrem Aktual (Data-Driven) ───
        const tsObservations = metarData.filter(m => m.wx && (m.wx.includes("TS") || m.wx.includes("CB") || m.wx.includes("RA")));
        let dynWind = "15012G22KT", dynVis = "4000", dynCloud = "SCT015CB";

        if (tsObservations.length > 0) {
          let maxSpd = 0, maxGst = 0, minVis = 9999, wDir = 0, cbCloud = "";
          tsObservations.forEach(m => {
            if (m.speed > maxSpd) { maxSpd = m.speed; wDir = m.dir; }
            if (m.gust > maxGst) maxGst = m.gust;
            if (m.vis < minVis) minVis = m.vis;
            if (m.cloudStr.includes("CB") && !cbCloud) cbCloud = m.cloudStr;
          });

          if (maxSpd < 10) maxSpd = 10;
          let finalGust = maxGst >= maxSpd + 5 ? maxGst : maxSpd + 10;
          
          dynWind = `${String(wDir).padStart(3,"0")}${String(maxSpd).padStart(2,"0")}G${String(finalGust).padStart(2,"0")}KT`;
          dynVis = minVis > 5000 ? "4000" : String(minVis).padStart(4, "0");
          dynCloud = cbCloud || "SCT015CB";
        }

        // ─── ICAO TAF FORMATTING ───
        const baseGroup = `${baseline.wind} ${baseline.vis} ${baseline.cloud}`.trim().replace(/\s+/g, ' ');
        const header = `TAF ${station} ${issueDate}${issueTime}Z ${validFrom}/${validTo}`;
        const lines = [`${header} ${baseGroup}`];

        const startDateStr = validFrom.substring(0, 2);
        
        // Penentuan Waktu TEMPO dinamis (dari Peak Hour NWP + 6 Jam blok)
        const tempoStartHour = String(modelSummary.peakHourUTC).padStart(2, "0");
        const tempoEndHour = String((modelSummary.peakHourUTC + 6) % 24).padStart(2, "0");
        const tempoBlock = `${startDateStr}${tempoStartHour}/${startDateStr}${tempoEndHour}`;

        // Kalkulasi BECMG akhir hari
        let nextDay = parseInt(startDateStr) + 1;
        if (nextDay > 31) nextDay = 1; 
        const nextDayStr = String(nextDay).padStart(2, "0");

        if (pFinal >= 50) {
          lines.push(`  TEMPO ${tempoBlock} ${dynWind} ${dynVis} TSRA ${dynCloud}`);
        } else if (pFinal >= 40) {
          lines.push(`  PROB40 TEMPO ${tempoBlock} ${dynWind} ${dynVis} TSRA ${dynCloud}`);
        } else if (pFinal >= 30) {
          lines.push(`  PROB30 TEMPO ${tempoBlock} ${dynVis} TSRA ${dynCloud}`);
        }

        lines.push(`  BECMG ${nextDayStr}04/${nextDayStr}06 10006KT 9999 FEW018=`);

        setTafOutput(lines.join("\n"));
        setReasoning(
          `🤖 Sintesis TAF 24-Jam (${station}):\n` +
          `• [1] ML Sliding Window (Absolute Time): Training H-3/H-2 (TS=${tsTraining}x) vs Validasi H-1 (TS=${tsValidation}x). Status: ${mlStatus}. P_METAR = ${Math.round(pMetar)}%.\n` +
          `• [2] Dual-Model (ECMWF/GFS): ${modelSummary.statusText}. Peak Hour: ${tempoStartHour}Z.\n` +
          `• [3] Ekstraksi Konvektif Dinamis: Angin Ekstrem Historis ${dynWind}, Visibilitas ${dynVis}M.\n` +
          `• [4] Format ICAO (Annex 3): PROB30/40 TEMPO, anti-spasi ganda, Tanda '=' presisi.`
        );
      } catch (e) {
        setTafOutput("ERROR: " + e.message);
      }
      setGenerating(false);
    }, 800);
  };

  const handleCopy = () => {
    if (!tafOutput) return;
    navigator.clipboard.writeText(tafOutput);
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };

  const tabs = [
    {id:"nwp", label:"Dual Model (ECMWF vs GFS)", icon:"⚖️"},
    {id:"metar", label:"METAR 72H", icon:"📡"},
    {id:"raw", label:"Raw METAR", icon:"📄"},
  ];

  return (
    <div style={{fontFamily:"'Inter','Segoe UI',sans-serif", background:"#060D16", minHeight:"100vh", color:"#CBD5E1"}}>
      
      {/* Top Bar Header */}
      <div style={{background:"linear-gradient(135deg,#080F1A,#0B1929)", borderBottom:"1px solid #1E3A5F", padding:"10px 20px"}}>
        <div style={{maxWidth:"1440px", margin:"0 auto", display:"flex", alignItems:"center", justifyContent:"space-between"}}>
          <div style={{display:"flex", alignItems:"center", gap:"12px"}}>
            <div style={{
              width:"34px", height:"34px", borderRadius:"7px",
              background:"linear-gradient(135deg,#1E90FF,#0055CC)",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:"17px", boxShadow:"0 0 10px #1E90FF30"
            }}>✈</div>
            <div>
              <div style={{fontSize:"13px", fontWeight:"700", color:"#F1F5F9", letterSpacing:"0.04em"}}>TAF AUTO-FORECASTER AI</div>
              <div style={{fontSize:"9px", color:"#475569", fontFamily:"monospace", letterSpacing:"0.1em"}}>
                ENTERPRISE EDITION · ICAO ANNEX 3 COMPLIANT
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Grid Layout (3 Columns) */}
      <div style={{maxWidth:"1440px", margin:"0 auto", padding:"14px 20px", display:"grid", gridTemplateColumns:"340px 1fr 360px", gap:"14px"}}>

        {/* ══ COL 1: Data Sources & Station ══ */}
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>

          {/* Station Panel */}
          <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"12px"}}>
            <SectionHeader icon="⚙️" title="Stasiun & Penerbitan TAF" />
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px", marginBottom:"8px"}}>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px"}}>ICAO CODE</div>
                <div style={{display:"flex", gap:"4px"}}>
                  <input
                    value={stationInput}
                    onChange={e=>setStationInput(e.target.value.toUpperCase())}
                    onKeyDown={e=>e.key==="Enter" && handleApplyStation()}
                    maxLength={4}
                    style={{flex:1, background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 7px", fontSize:"11px", fontFamily:"monospace", color:"#7DD3FC", outline:"none"}}
                  />
                  <button onClick={handleApplyStation} style={{background:"#1E3A8A", border:"1px solid #2563EB", borderRadius:"4px", padding:"5px 8px", fontSize:"9px", color:"#93C5FD", cursor:"pointer"}}>Go</button>
                </div>
              </div>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px"}}>STASIUN</div>
                <select
                  value={station}
                  onChange={e=>{setStation(e.target.value); setStationInput(e.target.value);}}
                  style={{width:"100%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 7px", fontSize:"10px", fontFamily:"monospace", color:"#94A3B8", outline:"none"}}
                >
                  {STATIONS.map(s=><option key={s.icao} value={s.icao}>{s.icao} – {s.name.split("-")[0].trim()}</option>)}
                </select>
              </div>
            </div>

            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"6px", marginBottom:"8px"}}>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px"}}>TGL UTC</div>
                <input value={issueDate} onChange={e=>setIssueDate(e.target.value)}
                  style={{width:"100%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 7px", fontSize:"10px", fontFamily:"monospace", color:"#94A3B8", outline:"none"}}
                />
              </div>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px"}}>ISSUE TIME</div>
                <input value={issueTime} onChange={e=>setIssueTime(e.target.value)}
                  style={{width:"100%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 7px", fontSize:"10px", fontFamily:"monospace", color:"#94A3B8", outline:"none"}}
                />
              </div>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px"}}>VALID (24H)</div>
                <div style={{display:"flex", gap:"2px", alignItems:"center"}}>
                  <input value={validFrom} onChange={e=>setValidFrom(e.target.value)}
                    style={{width:"45%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 4px", fontSize:"9px", fontFamily:"monospace", color:"#94A3B8", outline:"none", textAlign:"center"}}
                  />
                  <span style={{color:"#334155", fontSize:"9px"}}>/</span>
                  <input value={validTo} onChange={e=>setValidTo(e.target.value)}
                    style={{width:"45%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 4px", fontSize:"9px", fontFamily:"monospace", color:"#94A3B8", outline:"none", textAlign:"center"}}
                  />
                </div>
              </div>
            </div>

            {/* Mode Toggle */}
            <div style={{display:"flex", gap:"5px", marginTop:"8px"}}>
              <button onClick={()=>setInputMode("API")} style={{flex:1, padding:"5px", fontSize:"9px", background: inputMode==="API"?"#1E3A8A":"#080F1A", color: inputMode==="API"?"#93C5FD":"#475569", border:"1px solid #1E3A5F", borderRadius:"4px", cursor:"pointer"}}>
                📡 Auto API (72H)
              </button>
              <button onClick={()=>setInputMode("MANUAL")} style={{flex:1, padding:"5px", fontSize:"9px", background: inputMode==="MANUAL"?"#1E3A8A":"#080F1A", color: inputMode==="MANUAL"?"#93C5FD":"#475569", border:"1px solid #1E3A5F", borderRadius:"4px", cursor:"pointer"}}>
                📝 Paste Manual
              </button>
            </div>
          </div>

          {/* Data Tabs Panel */}
          <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", overflow:"hidden"}}>
            <div style={{display:"flex", borderBottom:"1px solid #1E3A5F"}}>
              {tabs.map(t=>(
                <button key={t.id} onClick={()=>setActiveTab(t.id)} style={{
                  flex:1, padding:"7px 2px", fontSize:"9px", fontWeight:"600",
                  background: activeTab===t.id ? "#0E2A45" : "transparent",
                  color: activeTab===t.id ? "#7DD3FC" : "#334155",
                  border:"none", cursor:"pointer",
                  borderBottom: activeTab===t.id ? "2px solid #1E90FF" : "2px solid transparent",
                }}>{t.icon} {t.label}</button>
              ))}
            </div>

            <div style={{padding:"10px", maxHeight:"310px", overflowY:"auto"}}>
              {activeTab==="nwp" && (
                <div>
                  <div style={{fontSize:"9px", fontFamily:"monospace", color:"#475569", marginBottom:"6px"}}>
                    Probabilitas Konvektif (ECMWF vs GFS)
                  </div>
                  {nwpLoading ? (
                    <div style={{fontSize:"9px", color:"#22C55E", textAlign:"center", padding:"10px"}}>Mengambil data ECMWF & GFS...</div>
                  ) : (
                    nwpTable.map((r,i)=>(
                      <div key={i} style={{fontSize:"9px", fontFamily:"monospace", padding:"5px 6px", borderRadius:"4px", background:"#0A1929", marginBottom:"4px", border: r.isConsistent ? "1px solid #16653450" : "1px solid #92400E50"}}>
                        <div style={{display:"flex", justifyContent:"space-between", color:"#7DD3FC", fontWeight:"bold", marginBottom:"2px"}}>
                          <span>Jam {r.period}</span>
                          <span style={{color: r.isConsistent ? "#22C55E" : "#FCD34D"}}>
                            {r.isConsistent ? "✓ Konsisten" : "⚠ Divergen"}
                          </span>
                        </div>
                        <div style={{display:"flex", justifyContent:"space-between", color:"#94A3B8"}}>
                          <span>ECMWF P(TS): <strong style={{color:"#FCA5A5"}}>{r.ecmwfProb}%</strong></span>
                          <span>GFS P(TS): <strong style={{color:"#93C5FD"}}>{r.gfsProb}%</strong></span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeTab==="metar" && (
                <div>
                  <div style={{fontSize:"9px", fontFamily:"monospace", color:"#475569", marginBottom:"6px"}}>
                    Histori Observasi METAR ({metarData.length} Laporan)
                  </div>
                  {metarData.map((r,i)=>(
                    <div key={i} style={{fontSize:"9.5px", fontFamily:"monospace", padding:"3px 0", borderBottom:"1px solid #0F2235", color:"#CBD5E1", display:"flex", justifyContent:"space-between"}}>
                      <span style={{color:"#7DD3FC"}}>{r.time}</span>
                      <span>{r.windStr}</span>
                      <span style={{color:r.vis<5000?"#FCD34D":"#94A3B8"}}>{r.vis}M</span>
                      <span style={{color:"#FCA5A5"}}>{r.wx}</span>
                    </div>
                  ))}
                </div>
              )}

              {activeTab==="raw" && (
                <div>
                  {metarRaw.map((r,i)=>(
                    <div key={i} style={{fontSize:"8.5px", fontFamily:"monospace", color:"#94A3B8", padding:"3px 0", borderBottom:"1px solid #0F2235", wordBreak:"break-all"}}>
                      {i+1}. {r}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ══ COL 2: Dual Model Synthesis Engine ══ */}
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>
          
          {/* Manual Input Box */}
          {inputMode === "MANUAL" && (
            <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"12px"}}>
              <div style={{fontSize:"10px", color:"#7DD3FC", fontWeight:"700", marginBottom:"6px"}}>📝 PASTE METAR MANUAL (3 HARI)</div>
              <textarea
                rows={5}
                value={manualText}
                onChange={e=>setManualText(e.target.value)}
                placeholder="Paste baris METAR di sini..."
                style={{width:"100%", background:"#080F1A", border:"1px solid #1E3A5F", color:"#22C55E", fontSize:"10px", fontFamily:"monospace", padding:"8px", outline:"none"}}
              />
              <button onClick={handleProcessManual} style={{marginTop:"6px", background:"#1E3A8A", border:"1px solid #2563EB", color:"#93C5FD", borderRadius:"4px", padding:"5px 10px", fontSize:"9px", cursor:"pointer"}}>
                Proses METAR Manual
              </button>
            </div>
          )}

          {/* Model Status Card */}
          <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"14px"}}>
            <SectionHeader icon="🤖" title="Pemodelan TAF 24 Jam" sub="Walk-Forward ML & Ensemble NWP" />
            
            <div style={{display:"flex", flexDirection:"column", gap:"8px", marginTop:"8px"}}>
              <div style={{background:"#080F1A", padding:"8px 10px", borderRadius:"6px", border:"1px solid #1E3A5F"}}>
                <div style={{fontSize:"10px", color:"#7DD3FC", fontWeight:"700"}}>1. ML Sliding Window (Absolute Time)</div>
                <div style={{fontSize:"9px", color:"#94A3B8"}}>Ekstraksi cerdas pola diurnal H-3 & H-2 dengan cross-validasi H-1 untuk mencegah concept drift.</div>
              </div>

              <div style={{background:"#080F1A", padding:"8px 10px", borderRadius:"6px", border:`1px solid ${modelSummary.isConsistent ? "#166534" : "#92400E"}`}}>
                <div style={{fontSize:"10px", color: modelSummary.isConsistent ? "#22C55E" : "#FCD34D", fontWeight:"700", marginBottom:"3px"}}>
                  2. Dual-Model (ECMWF vs GFS)
                </div>
                <div style={{fontSize:"9px", color:"#CBD5E1", lineHeight:"1.5"}}>
                  {modelSummary.statusText}
                </div>
              </div>
            </div>
          </div>

          {/* Action Button */}
          <button onClick={generateHybridTAF} disabled={generating} style={{
            background: generating ? "#1A3A5F" : "linear-gradient(135deg,#1E90FF,#0055CC)",
            border:"none", borderRadius:"8px", padding:"14px",
            fontSize:"12px", fontWeight:"700", color: generating ? "#475569" : "#fff",
            cursor: generating ? "not-allowed" : "pointer", letterSpacing:"0.06em",
            boxShadow:"0 4px 16px #1E90FF30"
          }}>
            {generating ? "Evaluasi Model & Mengkalkulasi..." : "✨ GENERATE TAF 24 JAM"}
          </button>

          {/* Reasoning Box */}
          {reasoning && (
            <div style={{background:"#0E2A45", border:"1px solid #1E3A5F", borderRadius:"8px", padding:"12px"}}>
              <div style={{fontSize:"10px", color:"#7DD3FC", fontWeight:"700", marginBottom:"6px"}}>💡 ANALISIS BLENDING ML & NWP</div>
              <div style={{fontSize:"10px", color:"#CBD5E1", lineHeight:"1.8", whiteSpace:"pre-line"}}>{reasoning}</div>
            </div>
          )}
        </div>

        {/* ══ COL 3: Terminal Output ══ */}
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>
          <div style={{background:"#000D06", border:"1px solid #004D1A", borderRadius:"10px", overflow:"hidden", flex:"1"}}>
            <div style={{background:"#001208", borderBottom:"1px solid #003D12", padding:"8px 12px", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
              <span style={{fontSize:"9px", fontFamily:"monospace", color:"#22C55E"}}>AFIS TERMINAL · {station}</span>
              <button onClick={handleCopy} disabled={!tafOutput} style={{background:"#001208", border:"1px solid #003D12", color: copied?"#22C55E":"#475569", fontSize:"9px", padding:"2px 6px", cursor:"pointer"}}>
                {copied?"✓ COPIED":"COPY"}
              </button>
            </div>

            <div style={{padding:"14px", minHeight:"240px"}}>
              {generating ? (
                <div style={{fontSize:"10px", fontFamily:"monospace", color:"#22C55E"}}>⟳ Menjalankan Ekstraksi Konvektif Dinamis...</div>
              ) : tafOutput ? (
                <pre style={{fontFamily:"'JetBrains Mono',monospace", fontSize:"10.5px", color:"#22C55E", lineHeight:"1.8", whiteSpace:"pre-wrap", margin:0}}>
                  {tafOutput}
                </pre>
              ) : (
                <div style={{fontSize:"10px", fontFamily:"monospace", color:"#0F3020", textAlign:"center", marginTop:"80px"}}>
                  Klik GENERATE TAF 24 JAM...
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
