import { useState, useRef, useCallback, useEffect } from "react";

const SYSTEM_PROMPT = `You are a Visual Compare Agent for the OMS (Order Management System) application.
Compare an actual OMS system screenshot against a Figma design PNG and produce a differences report with highlight coordinates.

## Rules
- Compare: layout, labels, colours, spacing, icons, component states, typography, alignment, missing/extra elements
- Keep the report factual
- Be specific about element locations

## CRITICAL: Highlight Coordinates
After the report output this exact block:

HIGHLIGHTS_JSON:
[
  { "id": 1, "label": "short label", "severity": "high|medium|low", "figma": {"x":10,"y":5,"w":80,"h":8}, "actual": {"x":10,"y":5,"w":80,"h":8} }
]
END_HIGHLIGHTS

x,y,w,h are percentages (0-100) of image dimensions. One entry per difference. Set absent-side coords to null.

## Report Format

### Visual Comparison Report
**Page:** [page name]
**Figma Frame:** [figma filename]
**Overall Match:** [Excellent / Good / Needs Attention / Poor]

---

### Differences Found

| # | Element | Location | Figma Design | Actual System | Severity |
|---|---------|----------|-------------|---------------|----------|
| 1 | ... | ... | ... | ... | High/Medium/Low |

---

### Severity Summary
- High (functional or brand-breaking): [count]
- Medium (visible inconsistency): [count]
- Low (minor spacing/colour variance): [count]

---

### Recommendations
[Brief bullet list of priority fixes]`;

const SEV = {
  high:   { label: "#c0392b", badge: "#ffeaea" },
  medium: { label: "#b7770d", badge: "#fff8e1" },
  low:    { label: "#0a7c4e", badge: "#e8fdf5" },
};

const PALETTE = [
  { fill:"rgba(230,0,115,0.50)",   stroke:"rgba(210,0,100,1)",    hex:"#d60064" },
  { fill:"rgba(0,160,220,0.50)",   stroke:"rgba(0,120,200,1)",    hex:"#0078c8" },
  { fill:"rgba(40,190,70,0.50)",   stroke:"rgba(20,160,45,1)",    hex:"#14a02d" },
  { fill:"rgba(255,150,0,0.55)",   stroke:"rgba(210,115,0,1)",    hex:"#d27300" },
  { fill:"rgba(130,0,210,0.50)",   stroke:"rgba(100,0,180,1)",    hex:"#6400b4" },
  { fill:"rgba(0,200,175,0.50)",   stroke:"rgba(0,165,145,1)",    hex:"#00a591" },
  { fill:"rgba(255,70,40,0.55)",   stroke:"rgba(215,40,10,1)",    hex:"#d7280a" },
  { fill:"rgba(0,70,200,0.50)",    stroke:"rgba(0,45,170,1)",     hex:"#002daa" },
  { fill:"rgba(185,185,0,0.55)",   stroke:"rgba(145,145,0,1)",    hex:"#919100" },
  { fill:"rgba(190,0,45,0.55)",    stroke:"rgba(160,0,25,1)",     hex:"#a00019" },
  { fill:"rgba(0,185,255,0.50)",   stroke:"rgba(0,145,220,1)",    hex:"#0091dc" },
  { fill:"rgba(255,85,195,0.50)",  stroke:"rgba(215,45,165,1)",   hex:"#d72da5" },
  { fill:"rgba(90,195,40,0.50)",   stroke:"rgba(60,158,15,1)",    hex:"#3c9e0f" },
  { fill:"rgba(255,40,140,0.55)",  stroke:"rgba(215,10,110,1)",   hex:"#d70a6e" },
  { fill:"rgba(40,40,215,0.50)",   stroke:"rgba(15,15,185,1)",    hex:"#0f0fb9" },
  { fill:"rgba(255,195,0,0.55)",   stroke:"rgba(205,152,0,1)",    hex:"#cd9800" },
  { fill:"rgba(0,155,90,0.50)",    stroke:"rgba(0,120,65,1)",     hex:"#007841" },
  { fill:"rgba(170,0,170,0.50)",   stroke:"rgba(140,0,140,1)",    hex:"#8c008c" },
  { fill:"rgba(255,120,0,0.55)",   stroke:"rgba(205,90,0,1)",     hex:"#cd5a00" },
  { fill:"rgba(0,90,145,0.50)",    stroke:"rgba(0,65,115,1)",     hex:"#004173" },
];
const getCol = (id) => PALETTE[(id - 1) % PALETTE.length];

const toBase64  = (f) => new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(f); });
const toDataURL = (f) => new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(f); });
const normName  = (n) => n.toLowerCase().replace(/\.[^.]+$/,"").replace(/[-_\s]+/g," ").trim();
const similarity= (a,b) => {
  const wa=new Set(normName(a).split(" ")), wb=new Set(normName(b).split(" "));
  const inter=[...wa].filter(w=>wb.has(w)).length;
  const union=new Set([...wa,...wb]).size;
  return union===0?0:inter/union;
};
const autoMatch = (figs,pdfs) => {
  const used=new Set();
  return pdfs.map(pdf=>{
    let best=null,bestS=0;
    figs.forEach(f=>{ if(used.has(f.name))return; const s=similarity(f.name,pdf.name); if(s>bestS){bestS=s;best=f;} });
    if(best&&bestS>0)used.add(best.name);
    return {pdf,figma:best,score:bestS,confident:bestS>=0.3};
  });
};
const parseH = (text) => { const m=text.match(/HIGHLIGHTS_JSON:\s*([\s\S]*?)END_HIGHLIGHTS/); if(!m)return[]; try{return JSON.parse(m[1].trim());}catch{return[];} };
const stripH  = (text) => text.replace(/HIGHLIGHTS_JSON:[\s\S]*?END_HIGHLIGHTS/g,"").trim();

// Draw: diffMode=true → greyscale bg (pixel-based) + coloured highlights; diffMode=false → plain image
// pinnedId: if set, dim all other highlights; focusId = pinnedId ?? activeId
const drawCanvas = (canvas, imgEl, highlights, side, activeId, diffMode, pinnedId) => {
  if (!canvas || !imgEl || !imgEl.complete || imgEl.naturalWidth === 0) return;
  const W = imgEl.naturalWidth, H = imgEl.naturalHeight;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,W,H);
  ctx.drawImage(imgEl,0,0);

  if (!diffMode) return;

  // Pixel greyscale — works everywhere, no compositing quirks
  const id = ctx.getImageData(0,0,W,H);
  const d = id.data;
  for (let i=0;i<d.length;i+=4) {
    const g = Math.round(d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114);
    d[i]=d[i+1]=d[i+2]=Math.round(g*0.68); // slightly darkened grey
  }
  ctx.putImageData(id,0,0);

  const focusId = (pinnedId !== null && pinnedId !== undefined) ? pinnedId : activeId;

  highlights.forEach(h => {
    const c = h[side]; if (!c) return;
    const col = getCol(h.id);
    const x=(c.x/100)*W, y=(c.y/100)*H, w=(c.w/100)*W, ht=(c.h/100)*H;
    const isFocus = focusId === h.id;
    const isDimmed = (focusId !== null && focusId !== undefined) && !isFocus;

    ctx.save();
    ctx.globalAlpha = isDimmed ? 0.15 : 1;
    ctx.fillStyle = isFocus ? col.fill.replace(/[\d.]+\)$/,"0.75)") : col.fill;
    ctx.fillRect(x,y,w,ht);
    ctx.strokeStyle = col.stroke;
    ctx.lineWidth = isFocus ? 5 : 2.5;
    ctx.strokeRect(x,y,w,ht);

    const fs = Math.max(11, W*0.017);
    ctx.font = `bold ${fs}px Segoe UI,Arial,sans-serif`;
    const bw = ctx.measureText(String(h.id)).width+10, bh = fs+7;
    ctx.fillStyle = col.stroke;
    ctx.fillRect(x, Math.max(0,y-bh), bw, bh);
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = isDimmed ? 0.15 : 1;
    ctx.fillText(String(h.id), x+5, y-3);
    ctx.restore();
  });
};

const Badge = ({children,color}) => (
  <span style={{display:"inline-block",padding:"1px 7px",borderRadius:20,fontSize:10,fontWeight:700,background:SEV[color]?.badge||"#eee",color:SEV[color]?.label||"#333"}}>{children}</span>
);

const MultiDropZone = ({label,accept,files,onFiles,icon}) => {
  const ref=useRef(); const [drag,setDrag]=useState(false);
  const handle=(inc)=>{const arr=Array.from(inc);onFiles(p=>{const n=new Set(p.map(f=>f.name));return[...p,...arr.filter(f=>!n.has(f.name))];});};
  return(
    <div onClick={()=>ref.current.click()} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files);}}
      style={{border:`2px dashed ${drag||files.length?"#00c6c2":"#ccc"}`,borderRadius:8,padding:"14px 10px",textAlign:"center",cursor:"pointer",background:files.length||drag?"#f0fffe":"#fafafa",minHeight:88,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
      <input ref={ref} type="file" accept={accept} multiple style={{display:"none"}} onChange={e=>handle(e.target.files)}/>
      <div style={{fontSize:22}}>{icon}</div>
      <div style={{fontWeight:700,color:"#052831",fontSize:12}}>{label}</div>
      {files.length>0?<div style={{fontSize:10,color:"#00c6c2",fontWeight:600}}>✓ {files.length} file{files.length>1?"s":""} loaded</div>:<div style={{fontSize:10,color:"#888"}}>Click or drag — multiple allowed</div>}
    </div>
  );
};
const FileChip = ({name,onRemove}) => (
  <div style={{display:"flex",alignItems:"center",gap:5,background:"#f4fbfb",border:"1px solid #cde0e0",borderRadius:6,padding:"3px 8px",fontSize:11}}>
    <span style={{maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</span>
    <button onClick={e=>{e.stopPropagation();onRemove();}} style={{background:"none",border:"none",cursor:"pointer",color:"#aaa",fontSize:13,lineHeight:1,padding:0}}>×</button>
  </div>
);

const HCanvas = ({imgSrc,highlights,side,activeId,onHover,label,onZoom,diffMode,pinnedId}) => {
  const canvasRef=useRef(); const imgRef=useRef(null); const [ready,setReady]=useState(false);
  useEffect(()=>{
    if(!imgSrc)return;
    setReady(false);
    const img=new Image();
    img.crossOrigin="anonymous";
    img.onload=()=>{imgRef.current=img;setReady(true);};
    img.onerror=()=>console.warn("Image load error",imgSrc.slice(0,60));
    img.src=imgSrc;
  },[imgSrc]);
  useEffect(()=>{ if(ready)drawCanvas(canvasRef.current,imgRef.current,highlights,side,activeId,diffMode,pinnedId); },[ready,highlights,side,activeId,diffMode,pinnedId]);

  const onMove=(e)=>{
    if(!diffMode||!canvasRef.current)return;
    const rect=canvasRef.current.getBoundingClientRect();
    const px=((e.clientX-rect.left)/rect.width)*100, py=((e.clientY-rect.top)/rect.height)*100;
    const hit=highlights.find(h=>{const c=h[side];return c&&px>=c.x&&px<=c.x+c.w&&py>=c.y&&py<=c.y+c.h;});
    onHover(hit?hit.id:null);
  };
  return(
    <div style={{background:"#fff",borderRadius:8,border:diffMode?"2px solid rgba(100,100,100,0.2)":"1px solid #daeaea",overflow:"hidden"}}>
      <div style={{padding:"5px 9px",fontSize:10,fontWeight:700,background:diffMode?"#f2f2f2":"#f4fbfb",borderBottom:diffMode?"1px solid #ddd":"1px solid #daeaea",color:"#052831",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span>{label}</span>
        {imgSrc&&<button onClick={()=>onZoom({imgSrc,highlights,side,label,diffMode,pinnedId})} style={{background:"none",border:"1px solid #cde0e0",borderRadius:4,cursor:"pointer",fontSize:10,padding:"1px 6px",color:"#5a7a80"}}>⤢ Zoom</button>}
      </div>
      {imgSrc
        ?<canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={()=>diffMode&&onHover(null)} style={{width:"100%",height:"auto",display:"block",cursor:diffMode?"crosshair":"default"}}/>
        :<div style={{padding:20,textAlign:"center",color:"#bbb",fontSize:11}}>No image</div>}
    </div>
  );
};

const ZoomModal = ({panel,highlights,activeId,onHover,onClose,pinnedId}) => {
  const canvasRef=useRef(); const imgRef=useRef(null); const [ready,setReady]=useState(false);
  const [scale,setScale]=useState(1);
  useEffect(()=>{
    if(!panel?.imgSrc)return;
    setReady(false); setScale(1);
    const img=new Image();
    img.crossOrigin="anonymous";
    img.onload=()=>{imgRef.current=img;setReady(true);};
    img.src=panel.imgSrc;
  },[panel?.imgSrc]);
  useEffect(()=>{ if(ready)drawCanvas(canvasRef.current,imgRef.current,highlights,panel.side,activeId,panel.diffMode,pinnedId); },[ready,highlights,panel,activeId,pinnedId]);
  const onMove=(e)=>{
    if(!panel.diffMode||!canvasRef.current)return;
    const rect=canvasRef.current.getBoundingClientRect();
    const px=((e.clientX-rect.left)/rect.width)*100, py=((e.clientY-rect.top)/rect.height)*100;
    const hit=highlights.find(h=>{const c=h[panel.side];return c&&px>=c.x&&px<=c.x+c.w&&py>=c.y&&py<=c.y+c.h;});
    onHover(hit?hit.id:null);
  };
  if(!panel)return null;
  const zoomIn =()=>setScale(s=>Math.min(+(s+0.25).toFixed(2),4));
  const zoomOut=()=>setScale(s=>Math.max(+(s-0.25).toFixed(2),0.25));
  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(5,40,49,0.82)",zIndex:1000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:20}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:10,overflow:"hidden",width:"92vw",maxHeight:"90vh",display:"flex",flexDirection:"column",boxShadow:"0 12px 48px rgba(0,0,0,0.45)"}}>
        <div style={{padding:"8px 14px",background:"#f4fbfb",borderBottom:"1px solid #daeaea",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <span style={{fontSize:12,fontWeight:700,color:"#052831"}}>{panel.label}</span>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{display:"flex",alignItems:"center",gap:2,background:"#f0f0f0",borderRadius:6,padding:"2px 4px"}}>
              <button onClick={zoomOut} style={{background:"none",border:"none",cursor:"pointer",fontSize:18,fontWeight:700,color:"#052831",padding:"0 6px",lineHeight:1}}>−</button>
              <span onClick={()=>setScale(1)} style={{fontSize:11,fontWeight:700,color:"#052831",minWidth:40,textAlign:"center",cursor:"pointer",userSelect:"none"}}>{Math.round(scale*100)}%</span>
              <button onClick={zoomIn}  style={{background:"none",border:"none",cursor:"pointer",fontSize:18,fontWeight:700,color:"#052831",padding:"0 6px",lineHeight:1}}>+</button>
            </div>
            <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"#5a7a80",lineHeight:1,padding:"0 4px"}}>×</button>
          </div>
        </div>
        <div style={{overflow:"auto",flex:1,background:"#ccc",display:"flex",justifyContent:"flex-start",alignItems:"flex-start"}}>
          <div style={{transform:`scale(${scale})`,transformOrigin:"top left",lineHeight:0,transition:"transform 0.15s ease"}}>
            <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={()=>panel.diffMode&&onHover(null)} style={{display:"block",cursor:panel.diffMode?"crosshair":"default"}}/>
          </div>
        </div>
        <div style={{padding:"5px 14px",fontSize:10,color:"#aaa",background:"#fafafa",borderTop:"1px solid #eee",flexShrink:0}}>Scroll to pan · click % to reset zoom · click outside to close</div>
      </div>
    </div>
  );
};

const ReportRenderer = ({text}) => {
  const lines=text.split("\n");
  return(
    <div style={{fontSize:12,lineHeight:1.6,color:"#052831"}}>
      {lines.map((line,i)=>{
        if(line.startsWith("### "))return<h3 key={i} style={{fontWeight:700,marginTop:14,marginBottom:2,fontSize:13}}>{line.slice(4)}</h3>;
        if(line.startsWith("| ")&&line.includes(" | ")){
          const cells=line.split("|").filter(c=>c.trim());
          const isHdr=lines[i+1]?.startsWith("|---");
          if(line.includes("---"))return null;
          return(<div key={i} style={{display:"grid",gridTemplateColumns:"1.5em 1.4fr 1.1fr 1.3fr 1.3fr 0.7fr",gap:"0 4px",padding:"3px 5px",background:isHdr?"#f4f8f8":i%2?"#fafcfc":"#fff",borderBottom:"1px solid #e8ecec",fontSize:11}}>
            {cells.map((c,j)=><div key={j} style={{fontWeight:isHdr?700:400}}>{c.trim()==="High"?<Badge color="high">High</Badge>:c.trim()==="Medium"?<Badge color="medium">Medium</Badge>:c.trim()==="Low"?<Badge color="low">Low</Badge>:c.trim()}</div>)}
          </div>);
        }
        if(line.startsWith("- "))return<div key={i} style={{paddingLeft:12,margin:"1px 0"}}>• {line.slice(2)}</div>;
        if(line==="---")return<hr key={i} style={{border:"none",borderTop:"1px solid #e0eaea",margin:"7px 0"}}/>;
        if(!line.trim())return<div key={i} style={{height:3}}/>;
        return<p key={i} style={{margin:"1px 0"}} dangerouslySetInnerHTML={{__html:line.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")}}/>;
      })}
    </div>
  );
};

const STATUS={idle:"idle",running:"running",done:"done",error:"error"};

export default function App() {
  const [figmaFiles,setFigmaFiles]=useState([]);
  const [pdfFiles,setPdfFiles]=useState([]);
  const [pairs,setPairs]=useState([]);
  const [results,setResults]=useState({});
  const [activeResult,setActiveResult]=useState(null);
  const [activeTab,setActiveTab]=useState("compare");
  const [activeId,setActiveId]=useState(null);
  const [pinnedId,setPinnedId]=useState(null);   // clicked/searched highlight
  const [searchQ,setSearchQ]=useState("");        // legend search query
  const [running,setRunning]=useState(false);
  const [globalError,setGlobalError]=useState("");
  const [followUp,setFollowUp]=useState("");
  const [followUpLoading,setFollowUpLoading]=useState(false);
  const [zoomPanel,setZoomPanel]=useState(null);

  useEffect(()=>{
    if(!figmaFiles.length||!pdfFiles.length){setPairs([]);return;}
    setPairs(autoMatch(figmaFiles,pdfFiles));
  },[figmaFiles,pdfFiles]);

  const updatePair=(pdfName,val)=>{
    setPairs(prev=>prev.map(p=>{
      if(p.pdf.name!==pdfName)return p;
      const fig=figmaFiles.find(f=>f.name===val)||null;
      return{...p,figma:fig,score:fig?similarity(fig.name,pdfName):0,confident:true,manuallySet:true};
    }));
  };

  const runAll=useCallback(async()=>{
    const valid=pairs.filter(p=>p.figma);
    if(!valid.length){setGlobalError("No valid pairs to compare.");return;}
    setGlobalError(""); setRunning(true);
    const init={};
    valid.forEach(p=>{init[p.pdf.name]={status:STATUS.running,report:"",highlights:[],figmaSrc:null,actualSrc:null,history:[]};});
    setResults({...init});

    await Promise.all(valid.map(async pair=>{
      try{
        const [fb64,pb64,figmaSrc,actualSrc]=await Promise.all([toBase64(pair.figma),toBase64(pair.pdf),toDataURL(pair.figma),toDataURL(pair.pdf)]);
        const ftype=pair.figma.type||"image/png";
        const ptype=pair.pdf.type||"application/pdf";
        const userMsg={role:"user",content:[
          {type:"text",text:`Compare Figma PNG "${pair.figma.name}" against system screenshot "${pair.pdf.name}". Produce the full report then output HIGHLIGHTS_JSON with percentage coordinates for every difference.`},
          {type:"image",source:{type:"base64",media_type:ftype,data:fb64}},
          ...(ptype==="application/pdf"
            ?[{type:"document",source:{type:"base64",media_type:"application/pdf",data:pb64}}]
            :[{type:"image",source:{type:"base64",media_type:ptype,data:pb64}}]),
        ]};
        const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:SYSTEM_PROMPT,messages:[userMsg]})});
        const data=await res.json();
        const raw=data.content?.filter(b=>b.type==="text").map(b=>b.text).join("\n")||"No response.";
        setResults(prev=>({...prev,[pair.pdf.name]:{status:STATUS.done,report:stripH(raw),highlights:parseH(raw),figmaSrc,actualSrc,history:[userMsg,{role:"assistant",content:raw}]}}));
      }catch{
        setResults(prev=>({...prev,[pair.pdf.name]:{...prev[pair.pdf.name],status:STATUS.error,report:"Comparison failed."}}));
      }
    }));
    setRunning(false);
    const first=valid[0]?.pdf.name;
    if(first){setActiveResult(first);setActiveTab("compare");}
  },[pairs]);

  const sendFollowUp=useCallback(async()=>{
    if(!followUp.trim()||!activeResult)return;
    setFollowUpLoading(true);
    const cur=results[activeResult];
    const userMsg={role:"user",content:followUp};
    const history=[...(cur.history||[]),userMsg];
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:SYSTEM_PROMPT,messages:history})});
      const data=await res.json();
      const raw=data.content?.filter(b=>b.type==="text").map(b=>b.text).join("\n")||"";
      const nh=parseH(raw);
      setResults(prev=>({...prev,[activeResult]:{...cur,history:[...history,{role:"assistant",content:raw}],report:cur.report+"\n\n---\n\n**Follow-up:**\n"+stripH(raw),highlights:nh.length?nh:cur.highlights}}));
      setFollowUp("");
    }catch{/*silent*/}finally{setFollowUpLoading(false);}
  },[followUp,activeResult,results]);

  const reset=()=>{setFigmaFiles([]);setPdfFiles([]);setPairs([]);setResults({});setActiveResult(null);setGlobalError("");setFollowUp("");setActiveId(null);setPinnedId(null);setSearchQ("");setZoomPanel(null);};

  const cur=activeResult?results[activeResult]:null;
  const doneCount=Object.values(results).filter(r=>r.status===STATUS.done).length;
  const totalRun=Object.keys(results).length;
  const showSetup=!totalRun;
  const ts=(t)=>({padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",border:"none",borderBottom:activeTab===t?"2px solid #00c6c2":"2px solid transparent",background:"none",color:activeTab===t?"#00c6c2":"#5a7a80"});
  const matchLabel=(p)=>{
    if(!p.figma)return{text:"Unmatched",color:"#c0392b",bg:"#ffeaea"};
    if(p.manuallySet)return{text:"Manual",color:"#0a7c4e",bg:"#e8fdf5"};
    if(p.confident)return{text:`Auto (${Math.round(p.score*100)}%)`,color:"#0a7c4e",bg:"#e8fdf5"};
    return{text:`Low confidence (${Math.round(p.score*100)}%)`,color:"#b7770d",bg:"#fff8e1"};
  };

  // Legend filtering
  const filteredHighlights = cur?.highlights?.filter(h => {
    if(!searchQ.trim())return true;
    const q=searchQ.toLowerCase();
    return String(h.id)===q || h.label.toLowerCase().includes(q) || h.severity.startsWith(q);
  }) ?? [];

  // Effective focus: pinned overrides hover
  const focusId = pinnedId ?? activeId;

  return(
    <div style={{fontFamily:"'Segoe UI',Arial,sans-serif",maxWidth:960,margin:"0 auto",padding:"18px 12px",color:"#052831"}}>
      {zoomPanel&&<ZoomModal panel={zoomPanel} highlights={cur?.highlights||[]} activeId={activeId} onHover={setActiveId} onClose={()=>setZoomPanel(null)} pinnedId={pinnedId}/>}

      <div style={{borderLeft:"4px solid #00c6c2",paddingLeft:12,marginBottom:18}}>
        <div style={{fontSize:10,fontWeight:700,color:"#00c6c2",letterSpacing:1,textTransform:"uppercase"}}>Version 1</div>
        <h1 style={{margin:"2px 0",fontSize:19,fontWeight:700}}>OMS Visual Compare Agent</h1>
        <p style={{margin:0,fontSize:11,color:"#5a7a80"}}>Upload multiple Figma PNGs and system PDFs — agent auto-matches and compares all pairs</p>
      </div>

      {showSetup&&(
        <div style={{background:"#fff",borderRadius:8,border:"1px solid #daeaea",padding:18}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
            <div>
              <MultiDropZone label="Figma Design PNGs" accept="image/png,image/jpeg" files={figmaFiles} onFiles={setFigmaFiles} icon="🎨"/>
              {figmaFiles.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:7}}>{figmaFiles.map(f=><FileChip key={f.name} name={f.name} onRemove={()=>setFigmaFiles(p=>p.filter(x=>x.name!==f.name))}/>)}</div>}
            </div>
            <div>
              <MultiDropZone label="System Screenshot PDFs" accept="application/pdf,image/*" files={pdfFiles} onFiles={setPdfFiles} icon="📄"/>
              {pdfFiles.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:7}}>{pdfFiles.map(f=><FileChip key={f.name} name={f.name} onRemove={()=>setPdfFiles(p=>p.filter(x=>x.name!==f.name))}/>)}</div>}
            </div>
          </div>
          {pairs.length>0&&(
            <div style={{marginBottom:14}}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>File Pairings</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {pairs.map(p=>{
                  const ml=matchLabel(p);
                  return(<div key={p.pdf.name} style={{display:"grid",gridTemplateColumns:"1fr auto 1fr auto",gap:8,alignItems:"center",background:"#f9fefe",border:"1px solid #daeaea",borderRadius:6,padding:"7px 10px"}}>
                    <div style={{fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📄 {p.pdf.name}</div>
                    <div style={{fontSize:11,color:"#aaa"}}>↔</div>
                    <select value={p.figma?.name||""} onChange={e=>updatePair(p.pdf.name,e.target.value)} style={{fontSize:11,padding:"3px 6px",border:"1px solid #cde0e0",borderRadius:4,color:"#052831",background:"#fff"}}>
                      <option value="">— no match —</option>
                      {figmaFiles.map(f=><option key={f.name} value={f.name}>🎨 {f.name}</option>)}
                    </select>
                    <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:20,background:ml.bg,color:ml.color,whiteSpace:"nowrap"}}>{ml.text}</span>
                  </div>);
                })}
              </div>
              {pairs.some(p=>!p.confident&&!p.manuallySet&&p.figma)&&(
                <div style={{marginTop:8,background:"#fff8e1",border:"1px solid #ffe082",borderRadius:6,padding:"7px 10px",fontSize:11,color:"#7a5200"}}>⚠️ Some pairs have low confidence — review pairings above before running.</div>
              )}
            </div>
          )}
          {globalError&&<div style={{background:"#ffeaea",border:"1px solid #f5c6c6",borderRadius:6,padding:"7px 10px",color:"#c0392b",fontSize:11,marginBottom:10}}>{globalError}</div>}
          <button onClick={runAll} disabled={running||!pairs.some(p=>p.figma)}
            style={{width:"100%",padding:"10px",background:running||!pairs.some(p=>p.figma)?"#a8dedd":"#00c6c2",color:"#fff",border:"none",borderRadius:6,fontSize:13,fontWeight:700,cursor:running||!pairs.some(p=>p.figma)?"not-allowed":"pointer"}}>
            {running?"⏳ Running comparisons…":`Run All Comparisons (${pairs.filter(p=>p.figma).length} pair${pairs.filter(p=>p.figma).length!==1?"s":""}) →`}
          </button>
        </div>
      )}

      {!showSetup&&(
        <>
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
            <div style={{fontSize:12,color:"#5a7a80",marginRight:4}}>{running?`⏳ Running… ${doneCount}/${totalRun} complete`:`✓ ${doneCount}/${totalRun} complete`}</div>
            {Object.entries(results).map(([name,r])=>(
              <button key={name} onClick={()=>{setActiveResult(name);setActiveTab("compare");setActiveId(null);setPinnedId(null);setSearchQ("");setZoomPanel(null);}}
                style={{padding:"4px 11px",fontSize:11,fontWeight:600,borderRadius:20,cursor:"pointer",border:"1.5px solid",transition:"all 0.15s",borderColor:activeResult===name?"#00c6c2":"#daeaea",background:activeResult===name?"#f0fffe":"#fff",color:r.status===STATUS.error?"#c0392b":r.status===STATUS.running?"#b7770d":"#052831"}}>
                {r.status===STATUS.running?"⏳":r.status===STATUS.error?"⚠️":"✓"} {name.replace(/\.[^.]+$/,"")}
              </button>
            ))}
            <button onClick={reset} style={{marginLeft:"auto",background:"none",border:"1px solid #cde0e0",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11,color:"#052831"}}>New Comparison</button>
          </div>

          {cur&&(
            <>
              <div style={{display:"flex",borderBottom:"1px solid #daeaea",marginBottom:12}}>
                <button style={ts("compare")} onClick={()=>setActiveTab("compare")}>Visual Comparison</button>
                <button style={ts("report")} onClick={()=>setActiveTab("report")}>Differences Report</button>
              </div>

              {cur.status===STATUS.running&&(
                <div style={{textAlign:"center",padding:40,color:"#5a7a80",fontSize:13}}>
                  <div style={{fontSize:28,marginBottom:8}}>🔍</div>
                  <div style={{fontWeight:600}}>Comparing {activeResult}…</div>
                </div>
              )}
              {cur.status===STATUS.error&&<div style={{background:"#ffeaea",border:"1px solid #f5c6c6",borderRadius:8,padding:16,fontSize:12,color:"#c0392b"}}>⚠️ {cur.report}</div>}

              {cur.status===STATUS.done&&activeTab==="compare"&&(
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                    <HCanvas imgSrc={cur.figmaSrc}  highlights={cur.highlights} side="figma"   activeId={null}      onHover={()=>{}} label="🎨 Figma Design"    onZoom={setZoomPanel} diffMode={false} pinnedId={null}/>
                    <HCanvas imgSrc={cur.actualSrc} highlights={cur.highlights} side="actual"  activeId={null}      onHover={()=>{}} label="📄 Actual System"  onZoom={setZoomPanel} diffMode={false} pinnedId={null}/>
                    <HCanvas imgSrc={cur.actualSrc} highlights={cur.highlights} side="actual"  activeId={activeId}  onHover={setActiveId} label="🔍 Diff Highlights" onZoom={setZoomPanel} diffMode={true}  pinnedId={pinnedId}/>
                  </div>

                  {cur.highlights.length>0&&(
                    <div style={{marginTop:10,background:"#fff",borderRadius:8,border:"1px solid #daeaea",padding:11}}>
                      {/* Search bar */}
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:9}}>
                        <div style={{fontSize:11,fontWeight:700,color:"#052831",whiteSpace:"nowrap"}}>Legend</div>
                        <input
                          type="text" value={searchQ} onChange={e=>{setSearchQ(e.target.value);setPinnedId(null);}}
                          placeholder="Search by #, label or severity…"
                          style={{flex:1,padding:"4px 9px",border:"1px solid #cde0e0",borderRadius:6,fontSize:11,color:"#052831"}}
                        />
                        {(pinnedId||searchQ)&&(
                          <button onClick={()=>{setPinnedId(null);setSearchQ("");}} style={{background:"none",border:"1px solid #cde0e0",borderRadius:6,padding:"3px 9px",cursor:"pointer",fontSize:11,color:"#5a7a80",whiteSpace:"nowrap"}}>
                            Clear
                          </button>
                        )}
                      </div>
                      <div style={{fontSize:10,color:"#aaa",marginBottom:7}}>Click a chip to pin/isolate that highlight on the diff panel · hover to preview</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                        {(searchQ?filteredHighlights:cur.highlights).map(h=>{
                          const col=getCol(h.id);
                          const isPinned=pinnedId===h.id;
                          const isHover=activeId===h.id;
                          const isActive=isPinned||isHover;
                          return(
                            <div key={h.id}
                              onClick={()=>setPinnedId(isPinned?null:h.id)}
                              onMouseEnter={()=>!pinnedId&&setActiveId(h.id)}
                              onMouseLeave={()=>!pinnedId&&setActiveId(null)}
                              style={{display:"flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:20,cursor:"pointer",fontSize:11,
                                border:`2px solid ${isActive?col.stroke:col.hex+"55"}`,
                                background:isPinned?col.stroke:isHover?col.fill:col.hex+"18",
                                color:isPinned?"#fff":"#052831",
                                transition:"all 0.12s",
                                boxShadow:isPinned?`0 2px 8px ${col.hex}66`:"none",
                              }}>
                              <span style={{width:16,height:16,borderRadius:"50%",background:isPinned?"rgba(255,255,255,0.35)":col.stroke,color:"#fff",fontSize:9,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{h.id}</span>
                              <span>{h.label}</span>
                              <Badge color={h.severity}>{h.severity.charAt(0).toUpperCase()+h.severity.slice(1)}</Badge>
                              {isPinned&&<span style={{fontSize:9,opacity:0.8}}>📌</span>}
                            </div>
                          );
                        })}
                        {searchQ&&filteredHighlights.length===0&&<div style={{fontSize:11,color:"#aaa",padding:"4px 0"}}>No matches for "{searchQ}"</div>}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {cur.status===STATUS.done&&activeTab==="report"&&(
                <div style={{background:"#fff",borderRadius:8,border:"1px solid #daeaea",padding:16}}>
                  <ReportRenderer text={cur.report}/>
                </div>
              )}

              {cur.status===STATUS.done&&(
                <div style={{marginTop:10,background:"#f4fbfb",borderRadius:8,border:"1px solid #cde0e0",padding:11}}>
                  <div style={{fontSize:11,fontWeight:700,marginBottom:5}}>Follow-up question</div>
                  <div style={{display:"flex",gap:6}}>
                    <input type="text" value={followUp} onChange={e=>setFollowUp(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendFollowUp()}
                      placeholder="e.g. List only High severity items. Any accessibility concerns?"
                      style={{flex:1,padding:"6px 10px",border:"1px solid #cde0e0",borderRadius:6,fontSize:11,color:"#052831"}}/>
                    <button onClick={sendFollowUp} disabled={followUpLoading||!followUp.trim()}
                      style={{padding:"6px 12px",background:"#00c6c2",color:"#fff",border:"none",borderRadius:6,fontWeight:700,cursor:"pointer",fontSize:11}}>
                      {followUpLoading?"…":"Ask"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
      <div style={{marginTop:16,fontSize:10,color:"#aaa",textAlign:"center"}}>OMS Visual Compare Agent · Version 1 · Powered by Claude</div>
    </div>
  );
}
