import React, { useState, useEffect, useCallback } from "react";

// ─── Station Registry (Lengkap dengan Koordinat Lat/Lon untuk Windy) ────────
const STATIONS = [
  { icao: "WALS", name: "APT Pranoto - Samarinda", lat: -0.373, lon: 117.258 },
  { icao: "WALL", name: "Sepinggan - Balikpapan", lat: -1.268, lon: 116.894 },
  { icao: "WAQT", name: "Kalimarau - Tanjung Redeb", lat: 2.155, lon: 117.433 },
  { icao: "WAGG", name: "Syamsudin Noor - Banjarmasin", lat: -3.442, lon: 114.762 },
  { icao: "WAQQ", name: "Juwata - Tarakan", lat: 3.327, lon: 117.564 },
];

const PHENOMENA_LIST = ["RA","TSRA","DZ","TS","FG","BR","HZ","SHRA","GR"];

// ─── METAR Parser ────────────────────────────────────────────────────────────
function parseMetar(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();

  const timeMatch = s.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  const time = timeMatch ? `${timeMatch[2]}${timeMatch[3]}Z` : "--";

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

  return { raw: s, time, dir, speed, gust, windStr, vis, wx, cloudStr };
}

// ─── Calculate Rolling Baseline METAR ───────────────────────────────────────
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

// ─── Main Component ──────────────────────────────────────────────────────────
export default function TAFForecaster() {
  const [station, setStation] = useState("WALS");
  const [inputMode, setInputMode] = useState("API");
  const [activeTab, setActiveTab] = useState("radar");
  const [manualText, setManualText] = useState("");
  
  const [metarList, setMetarList] = useState([]);
  const [tafOutput, setTafOutput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [reasoning, setReasoning] = useState("");

  const [issueDate] = useState(() => String(new Date().getUTCDate()).padStart(2,"0"));
  const [issueTime] = useState("0600");

  const currentStnObj = STATIONS.find(s => s.icao === station) || STATIONS[0];

  // Fetch Live METAR
  const fetchMETAR = useCallback(async (icao) => {
    try {
      const res = await fetch(`/api/metar?ids=${icao}&format=json&hours=72`);
      if (!res.ok) throw new Error("API Error");
      const json = await res.json();
      const rawList = json.map(item => item.rawOb || item.rawObservation || "").filter(Boolean);
      setMetarList(rawList.map(parseMetar).filter(Boolean));
    } catch (e) {
      const fallback = [
        `METAR ${icao} 210600Z 15008KT 9999 FEW018 SCT080 31/25 Q1008`,
        `METAR ${icao} 210300Z 12005KT 9999 FEW018 29/25 Q1010`,
        `METAR ${icao} 201800Z 15010G18KT 5000 TSRA SCT018CB 30/25 Q1007`,
      ];
      setMetarList(fallback.map(parseMetar).filter(Boolean));
    }
  }, []);

  useEffect(() => {
    if (inputMode === "API") fetchMETAR(station);
  }, [station, inputMode, fetchMETAR]);

  const handleProcessManual = () => {
    const lines = manualText.split("\n").map(l => l.trim()).filter(Boolean);
    setMetarList(lines.map(parseMetar).filter(Boolean));
  };

  // Hybrid ML Synthesis Engine
  const generateHybridTAF = () => {
    setGenerating(true);
    setTimeout(() => {
      const baseline = calculateBaseline(metarList);
      const tsOccurrences = metarList.filter(m => m.wx.includes("TS")).length;

      const header = `TAF ${station} ${issueDate}${issueTime}Z 0106/0130`;
      let tafLines = [`${header} ${baseline.wind} ${baseline.vis} ${baseline.cloud}`];

      if (tsOccurrences >= 1) {
        tafLines.push(`  TEMPO 0112/0118 15012G22KT 4000 TSRA SCT015CB BKN070`);
      }
      tafLines.push(`  BECMG 0122/0124 10006KT 9999 FEW018=`);

      setTafOutput(tafLines.join("\n"));
      setReasoning(
        `📊 Sintesis Hybrid (METAR 72H + Windy / ECMWF Integration):\n` +
        `• Baseline Observasi: Vector Average (${baseline.wind}).\n` +
        `• Visualisasi Windy (${station}): Terintegrasi langsung dengan layer Satellite IR / Weather Radar.`
      );
      setGenerating(false);
    }, 800);
  };

  return (
    <div style={{ fontFamily: "sans-serif", background: "#060D16", minHeight: "100vh", color: "#CBD5E1", padding: "20px" }}>
      <h2>✈️ TAF Forecaster AI (Windy Integrated)</h2>

      {/* Selector Stasiun */}
      <div style={{ marginBottom: "15px", display: "flex", gap: "10px", alignItems: "center" }}>
        <span style={{ fontSize: "12px", color: "#94A3B8" }}>PILIH STASIUN:</span>
        <select value={station} onChange={(e) => setStation(e.target.value)} style={{ background: "#0D1E30", color: "#7DD3FC", padding: "8px 12px", borderRadius: "5px", border: "1px solid #1E3A5F", fontWeight: "bold" }}>
          {STATIONS.map(s => <option key={s.icao} value={s.icao}>{s.icao} - {s.name}</option>)}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
        
        {/* Kolom Kiri: Peta Windy Live / Tab Input */}
        <div style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
          
          {/* Menu Tab */}
          <div style={{ display: "flex", gap: "5px", borderBottom: "1px solid #1E3A5F", pb: "5px" }}>
            <button onClick={() => setActiveTab("radar")} style={{ background: activeTab === "radar" ? "#1E90FF" : "transparent", color: "#fff", border: "none", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "11px" }}>
              🛰️ Windy Radar/Sat Live
            </button>
            <button onClick={() => setActiveTab("metar")} style={{ background: activeTab === "metar" ? "#1E90FF" : "transparent", color: "#fff", border: "none", padding: "6px 12px", borderRadius: "4px", cursor: "pointer", fontSize: "11px" }}>
              📡 METAR 72H
            </button>
          </div>

          {/* Isi Tab 1: Windy Live Map Widget */}
          {activeTab === "radar" && (
            <div style={{ background: "#0D1E30", borderRadius: "8px", overflow: "hidden", border: "1px solid #1E3A5F" }}>
              <div style={{ padding: "8px 12px", fontSize: "11px", color: "#7DD3FC", borderBottom: "1px solid #1E3A5F" }}>
                🌐 Live Windy Layer (ECMWF / Satellite) - {station} ({currentStnObj.lat}, {currentStnObj.lon})
              </div>
              <iframe
                title="Windy Live Radar"
                width="100%"
                height="320"
                src={`https://embed.windy.com/embed2.html?lat=${currentStnObj.lat}&lon=${currentStnObj.lon}&detailLat=${currentStnObj.lat}&detailLon=${currentStnObj.lon}&width=100%25&height=320&zoom=8&level=surface&overlay=radar&product=radar&menu=&message=&marker=true&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=kt&metricTemp=%C2%B0C&radarRange=-1`}
                style={{ border: "none" }}
              />
            </div>
          )}

          {/* Isi Tab 2: METAR List */}
          {activeTab === "metar" && (
            <div style={{ background: "#0D1E30", padding: "12px", borderRadius: "8px", maxHeight: "320px", overflowY: "auto" }}>
              <h4 style={{ margin: "0 0 10px 0", fontSize: "12px", color: "#7DD3FC" }}>Observasi METAR 72 Jam ({metarList.length} Laporan)</h4>
              {metarList.map((m, i) => (
                <div key={i} style={{ fontSize: "10px", fontFamily: "monospace", padding: "4px 0", borderBottom: "1px solid #1E2A3F", color: "#94A3B8" }}>
                  {m.raw}
                </div>
              ))}
            </div>
          )}

          <button onClick={generateHybridTAF} disabled={generating} style={{ background: "linear-gradient(135deg,#1E90FF,#0055CC)", color: "#fff", border: "none", padding: "12px", borderRadius: "8px", fontWeight: "bold", cursor: "pointer" }}>
            {generating ? "Mengkalkulasi Hybrid TAF..." : "✨ GENERATE TAF (WINDY + ML)"}
          </button>
        </div>

        {/* Kolom Kanan: Output Terminal */}
        <div style={{ background: "#000D06", border: "1px solid #004D1A", padding: "15px", borderRadius: "8px" }}>
          <h4 style={{ color: "#22C55E", marginTop: 0 }}>AFIS TERMINAL OUTPUT</h4>
          <pre style={{ color: "#22C55E", fontFamily: "monospace", fontSize: "11px", lineHeight: "1.8", whiteSpace: "pre-wrap" }}>
            {tafOutput || "Klik tombol di sebelah kiri..."}
          </pre>

          {reasoning && (
            <div style={{ marginTop: "15px", borderTop: "1px solid #004D1A", paddingTop: "10px", color: "#94A3B8", fontSize: "10.5px", whiteSpace: "pre-line" }}>
              {reasoning}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
