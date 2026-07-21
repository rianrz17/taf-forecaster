import React, { useState, useEffect, useRef, useCallback } from "react";

// ─── Station Registry (East Kalimantan focus) ────────────────────────────────
const STATIONS = [
  { icao: "WALS", name: "APT Pranoto - Samarinda" },
  { icao: "WALL", name: "Sepinggan - Balikpapan" },
  { icao: "WAQT", name: "Kalimarau - Tanjung Redeb" },
  { icao: "WAGG", name: "Syamsudin Noor - Banjarmasin" },
  { icao: "WAQQ", name: "Juwata - Tarakan" },
  { icao: "WAQD", name: "Tanjung Harapan - Tanjung Selor" },
  { icao: "WAOO", name: "Syamsudin Noor - Banjarmasin" },
];

const MOCK_MODEL = [
  { period: "00-06Z", wind: "090/04KT", vis: "9999", wx: "-", cloud: "FEW010", cb: false },
  { period: "06-12Z", wind: "120/05KT", vis: "8000", wx: "BR", cloud: "FEW005 SCT060", cb: false },
  { period: "12-18Z", wind: "150/08G15KT", vis: "9000", wx: "-RA", cloud: "SCT015 BKN070", cb: true },
  { period: "18-24Z", wind: "160/10G20KT", vis: "5000", wx: "TSRA", cloud: "SCT018CB BKN080", cb: true },
  { period: "24-30Z", wind: "140/07KT", vis: "9999", wx: "-", cloud: "SCT020 BKN080", cb: false },
  { period: "30-36Z", wind: "100/05KT", vis: "9999", wx: "-", cloud: "FEW018", cb: false },
];

const PHENOMENA_LIST = ["RA","TSRA","DZ","TS","FG","BR","HZ","MIFG","BCFG","SH","SHRA","GR","SS","FC","SQ","PO"];

// ─── METAR Parser (raw string → structured object) ───────────────────────────
function parseMetar(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();

  // Time
  const timeMatch = s.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  const time = timeMatch ? `${timeMatch[2]}${timeMatch[3]}Z` : "--";

  // Wind
  const windMatch = s.match(/\b(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT\b/);
  let wind = "--";
  if (windMatch) {
    wind = windMatch[4]
      ? `${windMatch[1]}/${windMatch[2]}G${windMatch[4]}KT`
      : `${windMatch[1]}/${windMatch[2]}KT`;
  }

  // Visibility
  const visMatch = s.match(/\b(9999|[0-9]{4})\b/);
  const vis = visMatch ? visMatch[1] : "----";

  // Weather phenomena
  const wxCodes = ["TSRA","TSGR","TSGS","TS","RASN","RASN","FZRA","FZDZ","SHRA","SHSN","SHGR","SH","DZ","RA","SN","SG","IC","PL","GR","GS","UP","BR","FG","FU","VA","DU","SA","HZ","PY","PO","SQ","FC","SS","DS","BCFG","MIFG","PRFG","DRDU","DRSA","DRSN","BLDU","BLSA","BLSN","BLPY"];
  let wx = "";
  for (const code of wxCodes) {
    const reg = new RegExp(`(?:[-+]|VC)?${code}(?!\\w)`);
    const m = s.match(reg);
    if (m) { wx = m[0]; break; }
  }

  // Cloud
  const cloudParts = [];
  const cloudReg = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?\b/g;
  let cm;
  while ((cm = cloudReg.exec(s)) !== null) {
    cloudParts.push(`${cm[1]}${cm[2]}${cm[3]||""}`);
  }
  if (s.includes("CAVOK")) cloudParts.push("CAVOK");
  if (s.includes("NSC")) cloudParts.push("NSC");
  const cloud = cloudParts.join(" ") || "--";

  // Temp/Dew
  const tempMatch = s.match(/\b(M?\d{2})\/(M?\d{2})\b/);
  const temp = tempMatch ? `${tempMatch[1]}/${tempMatch[2]}` : "--";

  // QNH
  const qnhMatch = s.match(/\bQ(\d{4})\b/);
  const qnh = qnhMatch ? `Q${qnhMatch[1]}` : "--";

  // Flight category
  let cat = "VFR";
  const visNum = parseInt(vis);
  const hasLowCloud = cloudParts.some(c => {
    const m = c.match(/(BKN|OVC)(\d{3})/);
    return m && parseInt(m[2]) * 100 < 1000;
  });
  if (visNum < 1500 || hasLowCloud) cat = "IFR";
  else if (visNum < 5000 || cloudParts.some(c => { const m = c.match(/(BKN|OVC)(\d{3})/); return m && parseInt(m[2])*100 < 3000; })) cat = "MVFR";

  return { raw: s, time, wind, vis, wx, cloud, temp, qnh, cat };
}

// ─── Flight Cat Badge ──────────────────────────────────────────────────────
function CatBadge({ cat }) {
  const colors = {
    VFR:  { bg: "#14532D", border: "#166534", text: "#4ADE80" },
    MVFR: { bg: "#1E3A8A", border: "#1D4ED8", text: "#93C5FD" },
    IFR:  { bg: "#7F1D1D", border: "#991B1B", text: "#FCA5A5" },
    LIFR: { bg: "#4A044E", border: "#86198F", text: "#F0ABFC" },
  };
  const c = colors[cat] || colors.VFR;
  return (
    <span style={{
      fontSize:"9px", fontFamily:"monospace", fontWeight:"700",
      padding:"1px 5px", borderRadius:"3px",
      background:c.bg, border:`1px solid ${c.border}`, color:c.text
    }}>{cat}</span>
  );
}

// ─── Sub Components ──────────────────────────────────────────────────────────
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

function MetarTable({ data, loading, error }) {
  if (loading) return (
    <div style={{padding:"20px", textAlign:"center"}}>
      <div style={{fontSize:"11px", fontFamily:"monospace", color:"#22C55E"}}>
        <span style={{animation:"pulse 1s infinite"}}>⟳</span> Mengambil data METAR...
      </div>
    </div>
  );
  if (error) return (
    <div style={{padding:"12px", background:"#7F1D1D20", border:"1px solid #7F1D1D", borderRadius:"6px"}}>
      <div style={{fontSize:"10px", color:"#FCA5A5", fontFamily:"monospace"}}>⚠ {error}</div>
    </div>
  );
  if (!data || data.length === 0) return (
    <div style={{fontSize:"10px", color:"#475569", fontFamily:"monospace", padding:"12px", textAlign:"center"}}>
      Tidak ada data METAR
    </div>
  );

  return (
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%", fontSize:"9.5px", fontFamily:"monospace", borderCollapse:"collapse"}}>
        <thead>
          <tr style={{color:"#475569", borderBottom:"1px solid #1E3A5F"}}>
            {["TIME","WIND","VIS","WX","CLOUD","T/Td","QNH","CAT"].map(h=>(
              <th key={h} style={{textAlign:"left", padding:"4px 6px 4px 0", fontWeight:"normal"}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((r,i)=>(
            <tr key={i} style={{
              borderBottom:"1px solid #0F2235",
              background: r.wx?.includes("TS") ? "#78350F10" : "transparent",
            }}>
              <td style={{padding:"3px 6px 3px 0", color:"#7DD3FC"}}>{r.time}</td>
              <td style={{paddingRight:"6px", color:"#CBD5E1"}}>{r.wind}</td>
              <td style={{paddingRight:"6px", color: parseInt(r.vis)<5000?"#FCD34D":"#94A3B8"}}>{r.vis}</td>
              <td style={{paddingRight:"6px", color: r.wx?.includes("TS")?"#FCA5A5":r.wx?"#FCD34D":"#334155"}}>{r.wx||"—"}</td>
              <td style={{paddingRight:"6px", color:"#94A3B8", maxWidth:"120px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{r.cloud}</td>
              <td style={{paddingRight:"6px", color:"#64748B"}}>{r.temp}</td>
              <td style={{paddingRight:"6px", color:"#64748B"}}>{r.qnh}</td>
              <td><CatBadge cat={r.cat} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelTable({ data }) {
  return (
    <div style={{display:"flex", flexDirection:"column", gap:"3px"}}>
      {data.map((r,i)=>(
        <div key={i} style={{
          display:"flex", alignItems:"center", gap:"6px",
          fontSize:"9.5px", fontFamily:"monospace",
          padding:"5px 8px", borderRadius:"4px",
          background: r.cb ? "#78350F15" : "#0A1929",
          border: r.cb ? "1px solid #92400E60" : "1px solid transparent",
        }}>
          <span style={{color:"#7DD3FC", minWidth:"52px"}}>{r.period}</span>
          <span style={{color:"#CBD5E1", minWidth:"80px"}}>{r.wind}</span>
          <span style={{color:parseInt(r.vis)<8000?"#FCD34D":"#64748B", minWidth:"44px"}}>{r.vis}</span>
          <span style={{color:r.wx!=="-"?"#FCD34D":"#334155", minWidth:"52px"}}>{r.wx}</span>
          <span style={{color:"#64748B", flex:1}}>{r.cloud}</span>
          {r.cb && <span style={{fontSize:"8px", color:"#FCA5A5", background:"#7F1D1D50", padding:"1px 4px", borderRadius:"2px", border:"1px solid #7F1D1D"}}>CB⚡</span>}
        </div>
      ))}
    </div>
  );
}

function PeriodCard({ period, onChange, onRemove, isBase }) {
  const update = (k, v) => onChange({ ...period, [k]: v });

  return (
    <div style={{
      borderRadius:"8px", border: isBase ? "1px solid #1E4A7F" : "1px solid #1E2A3F",
      background: isBase ? "#0A1F35" : "#080F1A",
      padding:"10px",
    }}>
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"8px"}}>
        <div style={{display:"flex", gap:"6px", alignItems:"center"}}>
          {isBase ? (
            <span style={{fontSize:"9px", fontFamily:"monospace", background:"#1E3A8A", color:"#93C5FD", padding:"2px 6px", borderRadius:"3px", border:"1px solid #2563EB"}}>BASE</span>
          ) : (
            <select
              value={period.type}
              onChange={e=>update("type",e.target.value)}
              style={{background:"#0A1929", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"2px 6px", fontSize:"9px", fontFamily:"monospace", color:"#7DD3FC", outline:"none"}}
            >
              {["BECMG","TEMPO","FM","PROB30","PROB40"].map(t=><option key={t}>{t}</option>)}
            </select>
          )}
          {!isBase && (
            <input
              value={period.time}
              onChange={e=>update("time",e.target.value)}
              placeholder="0106/0112"
              style={{background:"#0A1929", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"2px 6px", fontSize:"9px", fontFamily:"monospace", color:"#94A3B8", outline:"none", width:"90px"}}
            />
          )}
        </div>
        {!isBase && (
          <button onClick={onRemove} style={{background:"none", border:"none", color:"#334155", cursor:"pointer", fontSize:"11px", padding:"0 2px"}}>✕</button>
        )}
      </div>
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px", marginBottom:"6px"}}>
        <div>
          <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px", letterSpacing:"0.06em"}}>WIND</div>
          <input value={period.wind} onChange={e=>update("wind",e.target.value)} placeholder="150/10G20KT"
            style={{width:"100%", background:"#0A1929", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"4px 6px", fontSize:"10px", fontFamily:"monospace", color:"#CBD5E1", outline:"none", boxSizing:"border-box"}}
          />
        </div>
        <div>
          <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px", letterSpacing:"0.06em"}}>VISIBILITY</div>
          <select value={period.vis} onChange={e=>update("vis",e.target.value)}
            style={{width:"100%", background:"#0A1929", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"4px 6px", fontSize:"10px", fontFamily:"monospace", color:"#CBD5E1", outline:"none"}}
          >
            {["9999","8000","6000","5000","4000","3000","2000","1500","1000","0800","0500"].map(v=>(
              <option key={v} value={v}>{v}M</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{marginBottom:"6px"}}>
        <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px", letterSpacing:"0.06em"}}>PRESENT WEATHER</div>
        <div style={{display:"flex", flexWrap:"wrap", gap:"3px"}}>
          {PHENOMENA_LIST.map(p=>(
            <button key={p}
              onClick={()=>{
                const arr = period.wx ? period.wx.split(" ").filter(Boolean) : [];
                const idx = arr.indexOf(p);
                update("wx", idx>=0 ? arr.filter(x=>x!==p).join(" ") : [...arr,p].join(" "));
              }}
              style={{
                fontSize:"9px", fontFamily:"monospace",
                padding:"2px 5px", borderRadius:"3px",
                background: period.wx?.includes(p) ? "#78350F" : "#0A1929",
                border: period.wx?.includes(p) ? "1px solid #D97706" : "1px solid #1E3A5F",
                color: period.wx?.includes(p) ? "#FCD34D" : "#475569",
                cursor:"pointer",
              }}
            >{p}</button>
          ))}
        </div>
      </div>
      <div>
        <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px", letterSpacing:"0.06em"}}>CLOUD / VV</div>
        <input value={period.cloud} onChange={e=>update("cloud",e.target.value)} placeholder="SCT018CB BKN080"
          style={{width:"100%", background:"#0A1929", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"4px 6px", fontSize:"10px", fontFamily:"monospace", color:"#CBD5E1", outline:"none", boxSizing:"border-box"}}
        />
      </div>
      {period.wx?.includes("TS") && !period.cloud?.includes("CB") && (
        <div style={{marginTop:"6px", fontSize:"9px", color:"#FCD34D", background:"#78350F20", padding:"4px 8px", borderRadius:"4px", border:"1px solid #92400E60"}}>
          ⚡ TS terdeteksi — tambahkan CB pada grup cloud (mis: SCT018CB)
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function TAFForecaster() {
  const [station, setStation] = useState("WALS");
  const [stationInput, setStationInput] = useState("WALS");
  const [activeTab, setActiveTab] = useState("metar");
  const [issueDate, setIssueDate] = useState(() => String(new Date().getUTCDate()).padStart(2,"0"));
  const [issueTime, setIssueTime] = useState("0600");
  const [validFrom, setValidFrom] = useState("0106");
  const [validTo, setValidTo] = useState("0130");

  // METAR fetch state
  const [metarData, setMetarData] = useState([]);
  const [metarRaw, setMetarRaw] = useState([]);
  const [metarLoading, setMetarLoading] = useState(false);
  const [metarError, setMetarError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [dataSource, setDataSource] = useState(null);

  // TAF state
  const [periods, setPeriods] = useState([
    { id:1, type:"BASE", time:"", wind:"", vis:"9999", wx:"", cloud:"" },
    { id:2, type:"TEMPO", time:"", wind:"", vis:"9999", wx:"", cloud:"" },
  ]);
  const [tafOutput, setTafOutput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [reasoning, setReasoning] = useState("");
  const [accuracy, setAccuracy] = useState(null);
  const [copied, setCopied] = useState(false);
  const [validationErrors, setValidationErrors] = useState([]);

  // ── Fetch METAR from AWC (NOAA) ──────────────────────────────────────────
  const fetchMETAR = useCallback(async (icao) => {
    setMetarLoading(true);
    setMetarError(null);
    setMetarData([]);
    setMetarRaw([]);
    setDataSource(null);

    // Try AWC API first
    const awcUrl = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=24`;

    try {
      const res = await fetch(awcUrl, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      if (!Array.isArray(json) || json.length === 0) {
        throw new Error(`Tidak ada data METAR untuk ${icao} dalam 24 jam terakhir`);
      }

      // json items can have rawOb or rawObservation field
      const rawList = json
        .map(item => item.rawOb || item.rawObservation || item.metar || "")
        .filter(Boolean);

      const parsed = rawList.map(parseMetar).filter(Boolean);
      setMetarData(parsed);
      setMetarRaw(rawList);
      setLastFetch(new Date().toUTCString().slice(17,25));
      setDataSource("NOAA AWC");

      // Auto-fill base period from latest METAR
      if (parsed.length > 0) {
        const latest = parsed[0];
        setPeriods(prev => prev.map((p,i) => i===0 ? {
          ...p,
          wind: latest.wind !== "--" ? latest.wind : p.wind,
          vis: latest.vis !== "----" ? latest.vis : p.vis,
          wx: latest.wx || p.wx,
          cloud: latest.cloud !== "--" ? latest.cloud : p.cloud,
        } : p));
      }

    } catch (err) {
      // Fallback: try text format
      try {
        const textUrl = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=raw&hours=24`;
        const res2 = await fetch(textUrl, { signal: AbortSignal.timeout(8000) });
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
        const text = await res2.text();
        const lines = text.split("\n").map(l=>l.trim()).filter(l=>l.startsWith("METAR") || l.startsWith("SPECI") || l.match(/^[A-Z]{4}\s/));
        if (lines.length === 0) throw new Error("Tidak ada data");
        const parsed2 = lines.map(parseMetar).filter(Boolean);
        setMetarData(parsed2);
        setMetarRaw(lines);
        setLastFetch(new Date().toUTCString().slice(17,25));
        setDataSource("NOAA AWC (text)");
      } catch (err2) {
        setMetarError(`Gagal mengambil data METAR: ${err.message}. Pastikan koneksi internet aktif atau cek CORS browser. Data mock ditampilkan.`);
        // Use fallback mock data
        const fallback = [
          "METAR WALS 210000Z 09004KT 9999 FEW018 SCT080 28/25 Q1010",
          "METAR WALS 202100Z 16008KT 9999 FEW018 SCT080 32/26 Q1009",
          "METAR WALS 201800Z 15010G18KT 6000 TSRA SCT018CB BKN080 30/25 Q1007",
          "METAR WALS 201500Z 14006KT 9999 -RA SCT015 BKN070 31/25 Q1008",
          "METAR WALS 201200Z 12004KT 9999 FEW010 SCT080 29/25 Q1010",
          "METAR WALS 200900Z 09003KT 8000 BR FEW008 SCT060 26/25 Q1011",
          "METAR WALS 200600Z 08002KT 5000 BR FEW005 SCT040 25/24 Q1012",
        ].map(s => s.replace("WALS", icao));
        const parsedFB = fallback.map(parseMetar).filter(Boolean);
        setMetarData(parsedFB);
        setMetarRaw(fallback);
        setDataSource("MOCK (API offline)");
        setLastFetch(new Date().toUTCString().slice(17,25));
      }
    }
    setMetarLoading(false);
  }, []);

  // Auto-fetch on mount and station change
  useEffect(() => { fetchMETAR(station); }, [station]);

  const handleApplyStation = () => {
    const code = stationInput.trim().toUpperCase();
    if (code.length === 4) setStation(code);
  };

  const validateTAF = (taf) => {
    const errors = [];
    if (!taf.startsWith("TAF")) errors.push("Harus diawali dengan TAF");
    if (!taf.includes(station)) errors.push(`Kode ICAO ${station} tidak ditemukan`);
    if (!/\d{6}Z/.test(taf)) errors.push("Format waktu penerbitan tidak valid (DDHHmmZ)");
    if (!/\d{4}\/\d{4}/.test(taf)) errors.push("Periode validitas tidak ditemukan (DDHH/DDHH)");
    if (taf.includes("TS") && !taf.includes("CB")) errors.push("TS dicantumkan tapi tidak ada CB pada grup cloud");
    return errors;
  };

  const generateTAF = async () => {
    setGenerating(true);
    setTafOutput(""); setReasoning(""); setAccuracy(null); setValidationErrors([]);

    const metarContext = metarRaw.slice(0,6).join("\n") || "(tidak tersedia)";
    const modelStr = MOCK_MODEL.map(m =>
      `${m.period}: Wind ${m.wind}, Vis ${m.vis}, WX ${m.wx}, Cloud ${m.cloud}${m.cb?" [CB]":""}`
    ).join("\n");
    const periodStr = periods.map((p,i) => {
      if(i===0) return `BASE: Wind ${p.wind||"(kosong)"}, Vis ${p.vis}M, WX ${p.wx||"NIL"}, Cloud ${p.cloud||"(kosong)"}`;
      return `${p.type} ${p.time}: Wind ${p.wind||"(kosong)"}, Vis ${p.vis}M, WX ${p.wx||"NIL"}, Cloud ${p.cloud||"(kosong)"}`;
    }).join("\n");

    const prompt = `You are an expert aviation meteorologist at BMKG Indonesia (Station: ${station} - East Kalimantan). Generate a TAF strictly following ICAO Annex 3 / WMO No.49.

=== METAR AKTUAL (24 jam terakhir, sumber: ${dataSource||"mock"}) ===
${metarContext}

=== MODEL NWP GUIDANCE ===
${modelStr}

=== INPUT FORECASTER ===
${periodStr}

=== PARAMETER PENERBITAN ===
Station ICAO: ${station}
Issue: ${issueDate}${issueTime}Z
Valid: ${validFrom}/${validTo}

=== ATURAN WAJIB ===
1. Format persis: TAF CCCC DDHHmmZ DDHH/DDHH dddff(Gfmfm)KT VVVV [w'w'w'] NsNsNshshshs [BECMG/TEMPO/FM/PROB dddff(Gfmfm)KT ...]
2. Angin dalam KT, arah 3 digit, kecepatan 2-3 digit
3. Visibility dalam meter (9999 = ≥10km), atau CAVOK jika syarat terpenuhi
4. Awan: FEW/SCT/BKN/OVC + ketinggian 3 digit (dalam ratus kaki), tambahkan CB untuk cumulonimbus
5. TEMPO < 60 mnt, total < 50% periode; BECMG perubahan gradual; FM perubahan cepat
6. PROB30/PROB40 untuk kejadian tidak pasti
7. Berikan NOSIG jika tidak ada perubahan signifikan
8. TIDAK mencantumkan suhu dan QNH dalam TAF
9. Perhatikan pola cuaca tropis Indonesia (konveksi sore/malam, angin darat-laut, awan rendah pagi)
10. Output HANYA teks bulletin TAF saja (mulai dari "TAF"), tidak ada penjelasan lain

Setelah TAF, tambahkan:
ACCURACY: [angka 0-100]%
REASONING: [2 kalimat analisis meteorologi dalam Bahasa Indonesia]`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-6", max_tokens:1000,
          messages:[{role:"user", content:prompt}]
        })
      });
      const data = await res.json();
      const raw = data.content?.map(c=>c.text||"").join("\n")||"";

      let tafLines=[], accVal=null, reasonVal="";
      for (const line of raw.split("\n")) {
        if (line.startsWith("ACCURACY:")) {
          const m = line.match(/(\d+)/); if(m) accVal = parseInt(m[1]);
        } else if (line.startsWith("REASONING:")) {
          reasonVal = line.replace("REASONING:","").trim();
        } else if (line.trim()) {
          tafLines.push(line);
        }
      }
      const taf = tafLines.join("\n").trim();
      setTafOutput(taf);
      setAccuracy(accVal);
      setReasoning(reasonVal);
      setValidationErrors(validateTAF(taf));
    } catch(e) {
      setTafOutput("ERROR: Gagal menghubungi Claude API — " + e.message);
    }
    setGenerating(false);
  };

  const handleCopy = () => {
    if (!tafOutput) return;
    navigator.clipboard.writeText(tafOutput);
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };

  const tabs = [
    {id:"metar", label:"METAR Live", icon:"📡"},
    {id:"raw", label:"Raw METAR", icon:"📄"},
    {id:"model", label:"NWP Model", icon:"🌐"},
    {id:"radar", label:"Radar/Sat", icon:"🛰️"},
  ];

  const S = (style) => style; // style helper

  return (
    <div style={{fontFamily:"'Inter','Segoe UI',sans-serif", background:"#060D16", minHeight:"100vh", color:"#CBD5E1"}}>
      <style>{`
        @keyframes spin { from {transform:rotate(0deg)} to {transform:rotate(360deg)} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes radarSweep { from {transform:rotate(0deg)} to {transform:rotate(360deg)} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background: #060D16; }
        ::-webkit-scrollbar-thumb { background: #1E3A5F; border-radius:2px; }
      `}</style>

      {/* Header */}
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
              <div style={{fontSize:"13px", fontWeight:"700", color:"#F1F5F9", letterSpacing:"0.04em"}}>TAF FORECASTER AI</div>
              <div style={{fontSize:"9px", color:"#475569", fontFamily:"monospace", letterSpacing:"0.1em"}}>
                BMKG · AVIATION MET · ICAO ANNEX 3
              </div>
            </div>
          </div>
          <div style={{display:"flex", gap:"10px", alignItems:"center"}}>
            {dataSource && (
              <div style={{fontSize:"9px", fontFamily:"monospace", color:"#22C55E", background:"#14532D30", padding:"3px 8px", borderRadius:"4px", border:"1px solid #166534"}}>
                SRC: {dataSource}
              </div>
            )}
            <div style={{fontSize:"9px", fontFamily:"monospace", color:"#475569", background:"#0A1929", padding:"3px 8px", borderRadius:"4px", border:"1px solid #1E3A5F"}}>
              UTC {new Date().toUTCString().slice(17,25)}
            </div>
            <div style={{width:"7px", height:"7px", borderRadius:"50%", background:"#22C55E", boxShadow:"0 0 5px #22C55E"}}/>
            <span style={{fontSize:"9px", color:"#22C55E"}}>LIVE</span>
          </div>
        </div>
      </div>

      <div style={{maxWidth:"1440px", margin:"0 auto", padding:"14px 20px", display:"grid", gridTemplateColumns:"320px 1fr 350px", gap:"14px"}}>

        {/* ══ COL 1: Data Sources ══ */}
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>

          {/* Station config */}
          <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"12px"}}>
            <SectionHeader icon="⚙️" title="Stasiun" />
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px", marginBottom:"8px"}}>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px", letterSpacing:"0.06em"}}>ICAO CODE</div>
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
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px", letterSpacing:"0.06em"}}>STASIUN</div>
                <select
                  value={station}
                  onChange={e=>{setStation(e.target.value); setStationInput(e.target.value);}}
                  style={{width:"100%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 7px", fontSize:"10px", fontFamily:"monospace", color:"#94A3B8", outline:"none"}}
                >
                  {STATIONS.map(s=><option key={s.icao} value={s.icao}>{s.icao} – {s.name.split("-")[0].trim()}</option>)}
                </select>
              </div>
            </div>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"6px"}}>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px"}}>TGL UTC</div>
                <input value={issueDate} onChange={e=>setIssueDate(e.target.value)} placeholder="DD"
                  style={{width:"100%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 7px", fontSize:"10px", fontFamily:"monospace", color:"#94A3B8", outline:"none"}}
                />
              </div>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px"}}>ISSUE</div>
                <select value={issueTime} onChange={e=>setIssueTime(e.target.value)}
                  style={{width:"100%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 7px", fontSize:"10px", fontFamily:"monospace", color:"#94A3B8", outline:"none"}}
                >
                  {["0000","0600","1200","1800"].map(t=><option key={t} value={t}>{t}Z</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:"9px", color:"#475569", marginBottom:"3px"}}>VALID</div>
                <div style={{display:"flex", gap:"2px", alignItems:"center"}}>
                  <input value={validFrom} onChange={e=>setValidFrom(e.target.value)} placeholder="0106"
                    style={{width:"45%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 4px", fontSize:"9px", fontFamily:"monospace", color:"#94A3B8", outline:"none", textAlign:"center"}}
                  />
                  <span style={{color:"#334155", fontSize:"9px"}}>/</span>
                  <input value={validTo} onChange={e=>setValidTo(e.target.value)} placeholder="0130"
                    style={{width:"45%", background:"#080F1A", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"5px 4px", fontSize:"9px", fontFamily:"monospace", color:"#94A3B8", outline:"none", textAlign:"center"}}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Data tabs */}
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

            <div style={{padding:"10px", maxHeight:"320px", overflowY:"auto"}}>
              {activeTab==="metar" && (
                <div>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"6px"}}>
                    <span style={{fontSize:"9px", fontFamily:"monospace", color:"#475569"}}>
                      {station} · {metarData.length} laporan {lastFetch ? `· refresh ${lastFetch}` : ""}
                    </span>
                    <button
                      onClick={()=>fetchMETAR(station)}
                      disabled={metarLoading}
                      style={{background:"#0A1929", border:"1px solid #1E3A5F", borderRadius:"4px", padding:"2px 7px", fontSize:"9px", color:"#7DD3FC", cursor:"pointer"}}
                    >
                      {metarLoading ? "..." : "↻ Refresh"}
                    </button>
                  </div>
                  <MetarTable data={metarData} loading={metarLoading} error={metarError} />
                </div>
              )}

              {activeTab==="raw" && (
                <div>
                  <div style={{fontSize:"9px", color:"#475569", fontFamily:"monospace", marginBottom:"6px"}}>
                    Raw METAR strings · Sumber: {dataSource||"–"}
                  </div>
                  {metarRaw.length === 0
                    ? <div style={{fontSize:"9px", color:"#334155", fontFamily:"monospace"}}>Belum ada data</div>
                    : metarRaw.map((r,i)=>(
                      <div key={i} style={{
                        fontSize:"9px", fontFamily:"monospace", color:"#94A3B8",
                        padding:"4px 6px", borderRadius:"3px",
                        background: i%2===0 ? "#080F1A" : "transparent",
                        marginBottom:"2px", lineHeight:"1.6",
                        wordBreak:"break-all"
                      }}>
                        <span style={{color:"#334155"}}>{i+1}.</span> {r}
                      </div>
                    ))
                  }
                </div>
              )}

              {activeTab==="model" && (
                <div>
                  <div style={{fontSize:"9px", color:"#475569", fontFamily:"monospace", marginBottom:"6px"}}>
                    GFS/ECMWF blended · Run 00Z · {station} (simulasi)
                  </div>
                  <ModelTable data={MOCK_MODEL} />
                </div>
              )}

              {activeTab==="radar" && (
                <div style={{textAlign:"center"}}>
                  <div style={{
                    width:"100%", height:"180px", background:"#010A03",
                    borderRadius:"8px", border:"1px solid #1A3A1A",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    position:"relative", overflow:"hidden"
                  }}>
                    {[35,70,105].map(r=>(
                      <div key={r} style={{position:"absolute", borderRadius:"50%", width:`${r}%`, height:`${r}%`, border:"1px solid #0D2010"}}/>
                    ))}
                    <div style={{position:"absolute", width:"100%", height:"1px", background:"#0D2010"}}/>
                    <div style={{position:"absolute", height:"100%", width:"1px", background:"#0D2010"}}/>
                    <div style={{position:"absolute", top:"28%", left:"43%", width:"22px", height:"16px", borderRadius:"50%", background:"radial-gradient(circle,#FF4500,#FF000030)", filter:"blur(2px)"}}/>
                    <div style={{position:"absolute", top:"52%", left:"56%", width:"12px", height:"10px", borderRadius:"50%", background:"radial-gradient(circle,#FFD700,#FFA50030)", filter:"blur(1.5px)"}}/>
                    <div style={{position:"absolute", top:"62%", left:"34%", width:"8px", height:"7px", borderRadius:"50%", background:"radial-gradient(circle,#00FF00,#00800030)", filter:"blur(1.5px)"}}/>
                    <div style={{position:"absolute", width:"5px", height:"5px", borderRadius:"50%", background:"#00FF9D", boxShadow:"0 0 5px #00FF9D"}}/>
                    <div style={{
                      position:"absolute", width:"50%", height:"2px",
                      background:"linear-gradient(to right,transparent,#00FF9D20)",
                      transformOrigin:"left center", left:"50%", top:"50%",
                      animation:"radarSweep 4s linear infinite"
                    }}/>
                  </div>
                  <div style={{marginTop:"6px", display:"flex", gap:"6px", justifyContent:"center", flexWrap:"wrap"}}>
                    {[{c:"#00AA00",l:"<35 dBZ"},{c:"#FFFF00",l:"35-45"},{c:"#FF8C00",l:"45-55"},{c:"#FF0000",l:">55 dBZ"}].map(({c,l})=>(
                      <div key={l} style={{display:"flex", alignItems:"center", gap:"3px"}}>
                        <div style={{width:"7px", height:"7px", background:c, borderRadius:"2px"}}/>
                        <span style={{fontSize:"8px", color:"#475569", fontFamily:"monospace"}}>{l}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:"4px", fontSize:"9px", color:"#334155", fontFamily:"monospace"}}>
                    BMKG Radar · {station} Area · Simulasi
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Sat indicators */}
          <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"12px"}}>
            <SectionHeader icon="🛰️" title="Indikator Satelit" sub="Himawari-9 Band 13 IR" />
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"5px"}}>
              {[
                {label:"Cloud Top Temp",val:"-42°C",c:"#FCA5A5",bg:"#7F1D1D"},
                {label:"OLR Index",val:"180 W/m²",c:"#FCD34D",bg:"#78350F"},
                {label:"CBM Index",val:"HIGH",c:"#FCA5A5",bg:"#7F1D1D"},
                {label:"Moisture Band",val:"WET",c:"#93C5FD",bg:"#1E3A8A"},
              ].map(({label,val,c,bg})=>(
                <div key={label} style={{background:"#080F1A", borderRadius:"5px", padding:"7px", border:`1px solid ${bg}50`}}>
                  <div style={{fontSize:"8px", color:"#475569", marginBottom:"2px"}}>{label}</div>
                  <div style={{fontSize:"11px", fontFamily:"monospace", color:c, fontWeight:"700"}}>{val}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ══ COL 2: Forecast Editor ══ */}
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>
          <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"12px"}}>
            <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"10px"}}>
              <SectionHeader icon="📝" title="Periode Prakiraan" sub="Isi kondisi cuaca setiap periode" />
              <button
                onClick={()=>setPeriods(p=>[...p,{id:Date.now(),type:"TEMPO",time:"",wind:"",vis:"9999",wx:"",cloud:""}])}
                style={{background:"#1E90FF15", border:"1px solid #1E90FF40", borderRadius:"5px", padding:"4px 10px", fontSize:"9px", color:"#7DD3FC", cursor:"pointer"}}
              >+ Periode</button>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:"8px", maxHeight:"500px", overflowY:"auto", paddingRight:"2px"}}>
              {periods.map((p,i)=>(
                <PeriodCard key={p.id} period={p} isBase={i===0}
                  onChange={val=>setPeriods(ps=>ps.map(x=>x.id===p.id?{...x,...val}:x))}
                  onRemove={()=>setPeriods(ps=>ps.filter(x=>x.id!==p.id))}
                />
              ))}
            </div>
          </div>

          {/* Generate button */}
          <button onClick={generateTAF} disabled={generating} style={{
            background: generating ? "#1A3A5F" : "linear-gradient(135deg,#1E90FF,#0055CC)",
            border:"none", borderRadius:"8px", padding:"12px",
            fontSize:"12px", fontWeight:"700",
            color: generating ? "#475569" : "#fff",
            cursor: generating ? "not-allowed" : "pointer",
            letterSpacing:"0.06em",
            boxShadow: generating ? "none" : "0 4px 16px #1E90FF30",
            display:"flex", alignItems:"center", justifyContent:"center", gap:"8px"
          }}>
            {generating
              ? <><span style={{display:"inline-block", animation:"spin 1s linear infinite"}}>⟳</span> Generating TAF...</>
              : <>✈ GENERATE TAF dengan AI</>
            }
          </button>

          {/* Validation */}
          {validationErrors.length > 0 && (
            <div style={{background:"#7F1D1D20", border:"1px solid #7F1D1D60", borderRadius:"7px", padding:"9px"}}>
              <div style={{fontSize:"10px", fontWeight:"700", color:"#FCA5A5", marginBottom:"4px"}}>⚠ Hasil Validasi TAF</div>
              {validationErrors.map((e,i)=>(
                <div key={i} style={{fontSize:"9px", color:"#FDA4AF", fontFamily:"monospace", marginBottom:"2px"}}>• {e}</div>
              ))}
            </div>
          )}

          {/* Reasoning */}
          {reasoning && (
            <div style={{background:"#0E2A45", border:"1px solid #1E3A5F", borderRadius:"7px", padding:"9px"}}>
              <div style={{fontSize:"9px", color:"#475569", marginBottom:"4px", letterSpacing:"0.06em"}}>💡 ANALISIS METEOROLOGI</div>
              <div style={{fontSize:"10px", color:"#94A3B8", lineHeight:"1.7"}}>{reasoning}</div>
            </div>
          )}

          {/* Quick ref */}
          <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"12px"}}>
            <SectionHeader icon="📚" title="Referensi Cepat ICAO Annex 3" />
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"5px"}}>
              {[
                {k:"CAVOK",v:"Vis≥10km, no cloud <1500ft, no CB, no sig WX"},
                {k:"BECMG",v:"Perubahan gradual, selesai dalam ≤2 jam"},
                {k:"TEMPO",v:"Fluktuasi <60 mnt, total <50% periode valid"},
                {k:"NOSIG",v:"Tidak ada perubahan signifikan expected"},
                {k:"PROB30",v:"Peluang 30-39% terjadinya fenomena"},
                {k:"FM",v:"Perubahan cepat, selesai dalam <30 menit"},
                {k:"NSC",v:"No Significant Cloud (tapi tak penuhi CAVOK)"},
                {k:"VRB",v:"Angin variabel, biasanya jika kec < 3 KT"},
              ].map(({k,v})=>(
                <div key={k} style={{background:"#080F1A", borderRadius:"5px", padding:"6px 8px"}}>
                  <div style={{fontSize:"9px", fontFamily:"monospace", color:"#7DD3FC", marginBottom:"2px"}}>{k}</div>
                  <div style={{fontSize:"8.5px", color:"#64748B", lineHeight:"1.4"}}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ══ COL 3: TAF Terminal Output ══ */}
        <div style={{display:"flex", flexDirection:"column", gap:"10px"}}>

          {/* Terminal */}
          <div style={{
            background:"#000D06", border:"1px solid #004D1A",
            borderRadius:"10px", overflow:"hidden",
            boxShadow:"0 0 24px #00FF9D08",
            flex:"1"
          }}>
            {/* Terminal header */}
            <div style={{
              background:"#001208", borderBottom:"1px solid #003D12",
              padding:"8px 12px", display:"flex", alignItems:"center", justifyContent:"space-between"
            }}>
              <div style={{display:"flex", alignItems:"center", gap:"7px"}}>
                <div style={{display:"flex", gap:"4px"}}>
                  {["#FF5F56","#FFBD2E","#27C93F"].map(c=>(
                    <div key={c} style={{width:"9px", height:"9px", borderRadius:"50%", background:c}}/>
                  ))}
                </div>
                <span style={{fontSize:"9px", fontFamily:"monospace", color:"#22C55E"}}>
                  AFIS TERMINAL · {station} · TAF OUTPUT
                </span>
              </div>
              <div style={{display:"flex", gap:"5px", alignItems:"center"}}>
                {accuracy !== null && (
                  <div style={{
                    fontSize:"9px", fontFamily:"monospace",
                    color: accuracy>=80?"#22C55E":accuracy>=60?"#EAB308":"#EF4444",
                    background: accuracy>=80?"#14532D30":"#78350F30",
                    border:`1px solid ${accuracy>=80?"#166534":"#92400E"}`,
                    padding:"2px 6px", borderRadius:"3px"
                  }}>ACC: {accuracy}%</div>
                )}
                <button onClick={handleCopy} disabled={!tafOutput} style={{
                  background: copied?"#14532D":"#001208",
                  border:`1px solid ${copied?"#166534":"#003D12"}`,
                  borderRadius:"3px", padding:"2px 7px",
                  fontSize:"9px", fontFamily:"monospace",
                  color: copied?"#22C55E":"#475569",
                  cursor: tafOutput?"pointer":"default"
                }}>{copied?"✓ COPIED":"COPY"}</button>
              </div>
            </div>

            {/* Terminal body */}
            <div style={{padding:"14px", minHeight:"220px"}}>
              {generating ? (
                <div style={{display:"flex", flexDirection:"column", gap:"5px"}}>
                  {["Membaca data METAR terkini...","Mencocokkan model NWP...","Menerapkan aturan ICAO Annex 3...","Menyusun bulletin TAF..."].map((l,i)=>(
                    <div key={i} style={{fontSize:"10px", fontFamily:"monospace", color: i===0?"#22C55E":"#166534"}}>
                      {i===0 && <span style={{animation:"pulse 0.8s infinite"}}>▌</span>} {l}
                    </div>
                  ))}
                </div>
              ) : tafOutput ? (
                <pre style={{
                  fontFamily:"'JetBrains Mono','Courier New',monospace",
                  fontSize:"11.5px", color:"#22C55E", lineHeight:"1.9",
                  whiteSpace:"pre-wrap", margin:0,
                  textShadow:"0 0 7px #22C55E30"
                }}>
                  {tafOutput}<span style={{animation:"pulse 1s infinite", color:"#22C55E60"}}>█</span>
                </pre>
              ) : (
                <div style={{display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"170px", gap:"8px"}}>
                  <span style={{fontSize:"28px", opacity:0.15}}>✈</span>
                  <span style={{fontSize:"10px", fontFamily:"monospace", color:"#0F3020"}}>
                    Klik GENERATE TAF untuk memulai...
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Confidence */}
          {accuracy !== null && (
            <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"12px"}}>
              <SectionHeader icon="🎯" title="Confidence Score" />
              <div style={{display:"flex", justifyContent:"space-between", marginBottom:"5px"}}>
                <span style={{fontSize:"10px", color:"#64748B"}}>Estimasi Akurasi AI</span>
                <span style={{fontSize:"15px", fontFamily:"monospace", fontWeight:"700",
                  color:accuracy>=80?"#22C55E":accuracy>=60?"#EAB308":"#EF4444"
                }}>{accuracy}%</span>
              </div>
              <div style={{height:"5px", background:"#080F1A", borderRadius:"3px", overflow:"hidden", marginBottom:"6px"}}>
                <div style={{
                  height:"100%", width:`${accuracy}%`,
                  background: accuracy>=80 ? "linear-gradient(to right,#14532D,#22C55E)" : "linear-gradient(to right,#92400E,#EAB308)",
                  borderRadius:"3px", transition:"width 0.8s ease",
                  boxShadow: accuracy>=80 ? "0 0 6px #22C55E50" : "none"
                }}/>
              </div>
              <div style={{fontSize:"9px", color:"#64748B"}}>
                {accuracy>=80 ? "✅ Memenuhi target akurasi >80% ICAO" : accuracy>=60 ? "⚠️ Review manual diperlukan sebelum publish" : "❌ Akurasi rendah — tinjau ulang data input"}
              </div>
            </div>
          )}

          {/* TAF Structure */}
          <div style={{background:"#0D1E30", border:"1px solid #1E3A5F", borderRadius:"10px", padding:"12px"}}>
            <SectionHeader icon="🏗️" title="Struktur TAF ICAO" sub="Format WMO No.49" />
            <div style={{fontFamily:"monospace", fontSize:"9px", lineHeight:"2"}}>
              {[
                {c:"#7DD3FC",k:"TAF",d:"Header jenis pesan"},
                {c:"#22C55E",k:"WALS",d:"ICAO stasiun (4 huruf)"},
                {c:"#A78BFA",k:"210600Z",d:"Tanggal & waktu penerbitan UTC"},
                {c:"#F59E0B",k:"2106/2130",d:"Periode valid (DDHH/DDHH)"},
                {c:"#60A5FA",k:"16010KT",d:"Angin arah/kecepatan knot"},
                {c:"#34D399",k:"9999",d:"Jarak pandang meter"},
                {c:"#FCA5A5",k:"SCT018CB",d:"Awan (jumlah/ketinggian/CB)"},
                {c:"#F59E0B",k:"TEMPO",d:"Perubahan sementara"},
              ].map(({c,k,d})=>(
                <div key={k} style={{display:"flex", gap:"8px", alignItems:"baseline"}}>
                  <span style={{color:c, minWidth:"72px"}}>{k}</span>
                  <span style={{color:"#334155", fontSize:"8.5px"}}>{d}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Export */}
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"7px"}}>
            {[
              {icon:"📋", label:"Salin ke AFTN", fn: handleCopy},
              {icon:"📄", label:"Export .txt", fn: ()=>{
                if(!tafOutput) return;
                const blob = new Blob([tafOutput],{type:"text/plain"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href=url; a.download=`TAF_${station}_${issueDate}${issueTime}Z.txt`; a.click();
              }},
            ].map(({icon,label,fn})=>(
              <button key={label} onClick={fn} disabled={!tafOutput} style={{
                background:"#0D1E30", border:"1px solid #1E3A5F",
                borderRadius:"7px", padding:"9px",
                fontSize:"10px", color:tafOutput?"#94A3B8":"#1E3A5F",
                cursor:tafOutput?"pointer":"default",
                display:"flex", alignItems:"center", justifyContent:"center", gap:"5px"
              }}>{icon} {label}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
