(() => {
"use strict";
const $ = id => document.getElementById(id);
const CDN_ENGINE = "https://cdn.jsdelivr.net/npm/stockfish@19.0.1/bin/stockfish-19-lite-single.js";
const PIECES = {w:{k:"♔",q:"♕",r:"♖",b:"♗",n:"♘",p:"♙"},b:{k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"}};
let engine=null, engineReady=false, engineBusy=false, cancelled=false, searchResolve=null, searchInfo={score:null,depth:0,bestmove:null};
let games=[], currentGame=null, mistakes=[], selectedMistake=-1, boardGame=null, selectedSquare=null, flipped=false, lastMove=null, solved=new Set(), revealed=false;
const ChessCtor = window.Chess;
function setMessage(text, kind=""){const el=$("importMessage");el.textContent=text;el.className="message "+kind;}
function setEngineStatus(text,kind=""){const el=$("engineStatus");el.textContent=text;el.className="engine-pill "+kind;}
function parsePgnGames(pgn){
  const trimmed=pgn.trim(); if(!trimmed) throw new Error("Paste or choose a PGN file first.");
  const chunks=trimmed.split(/(?=^\s*\[Event\s)/m).map(x=>x.trim()).filter(Boolean);
  const candidates=chunks.length?chunks:[trimmed], out=[];
  for(let i=0;i<candidates.length;i++){
    const chess=new ChessCtor();
    try { const ok=chess.load_pgn(candidates[i],{sloppy:true}); if(ok===false) throw new Error("PGN could not be parsed"); }
    catch(e){throw new Error(`Could not read PGN game ${i+1}: ${e.message}. Check that the file contains valid PGN moves.`);}
    const history=chess.history({verbose:true});
    if(!history.length) continue;
    const headers=chess.header();
    out.push({id:out.length,headers,history,pgn:candidates[i],label:headers.Event||`Game ${out.length+1}`,white:headers.White||"White",black:headers.Black||"Black",result:headers.Result||"*"});
  }
  if(!out.length) throw new Error("No moves were found in the PGN.");
  return out;
}
function initEngine(){
  if(engine) return Promise.resolve();
  return new Promise((resolve,reject)=>{
    try {
      // Classic workers must generally be same-origin. A small Blob wrapper loads the
      // published engine script and explicitly points its WASM loader back to the CDN.
      const workerBootstrap = `self.Module = self.Module || {}; self.Module.locateFile = function(path) { return "https://cdn.jsdelivr.net/npm/stockfish@19.0.1/bin/" + path; }; importScripts("${CDN_ENGINE}");`;
      const workerUrl = URL.createObjectURL(new Blob([workerBootstrap], {type:"text/javascript"}));
      engine=new Worker(workerUrl);
      const timeout=setTimeout(()=>{if(!engineReady){setEngineStatus("Engine load timed out");reject(new Error("Stockfish did not start. Check your internet connection or try again."));}},45000);
      engine.onmessage=e=>{
        const line=typeof e.data==="string"?e.data:String(e.data);
        if(line==="uciok"){engine.postMessage("isready");return;}
        if(line==="readyok"){engineReady=true;clearTimeout(timeout);setEngineStatus("Stockfish ready","ready");resolve();return;}
        if(line.startsWith("info ")){
          const depthMatch=line.match(/\bdepth (\d+)/), cp=line.match(/\bscore cp (-?\d+)/), mate=line.match(/\bscore mate (-?\d+)/), pv=line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
          if(depthMatch)searchInfo.depth=Number(depthMatch[1]);
          if(cp)searchInfo.score={type:"cp",value:Number(cp[1])};
          if(mate)searchInfo.score={type:"mate",value:Number(mate[1])};
          if(pv)searchInfo.pv=pv[1];
          if(engineBusy && depthMatch && $("progressText")) $("progressText").textContent=`Analyzing position · depth ${depthMatch[1]}`;
        }
        if(line.startsWith("bestmove ")){
          searchInfo.bestmove=line.split(/\s+/)[1];
          if(searchResolve){const r=searchResolve;searchResolve=null;r({...searchInfo});}
        }
      };
      engine.onerror=()=>{setEngineStatus("Engine error");if(!engineReady)reject(new Error("The Stockfish engine failed to load. Check your connection and reload."));};
      engine.postMessage("uci");
    } catch(e){reject(e);}
  });
}
function scoreToWhite(score,fen){
  if(!score)return null;
  // UCI score is reported from the side-to-move perspective by Stockfish.
  const turn=fen.split(/\s+/)[1];
  const sign=turn==="w"?1:-1;
  if(score.type==="cp")return score.value*sign/100;
  return score.value===0?0:(score.value>0?1000:-1000)*sign;
}
function formatEval(v){if(v===null||!Number.isFinite(v))return "—";if(Math.abs(v)>=100)return v>0?"M+":"M−";return `${v>0?"+":""}${v.toFixed(2)}`;}
function uciToSan(chess,uci){
  if(!uci||uci==="(none)")return "—";
  try{const from=uci.slice(0,2),to=uci.slice(2,4),promotion=uci[4];const move=chess.move({from,to,promotion:promotion||undefined});if(!move)return uci;chess.undo();return move.san;}catch(_){return uci;}
}
function sendSearch(fen,depth){
  return new Promise((resolve,reject)=>{
    if(!engineReady){reject(new Error("Stockfish is not ready."));return;}
    searchInfo={score:null,depth:0,bestmove:null,pv:null};searchResolve=resolve;
    engine.postMessage("position fen "+fen);
    engine.postMessage("go depth "+depth);
  });
}
function stopSearch(){if(engine&&engineBusy){engine.postMessage("stop");} }
function setProgress(done,total,text){
  const pct=total?Math.round(done/total*100):0;$("progressWrap").classList.remove("hidden");$("progressBar").style.width=pct+"%";$("progressPercent").textContent=pct+"%";$("progressText").textContent=text||`Analyzed ${done} of ${total} moves`;
}
async function analyzeAll(){
  if(engineBusy)return;
  try{
    if(!games.length) games=parsePgnGames($("pgnText").value);
    await initEngine();
  }catch(e){setMessage(e.message,"error");return;}
  const depth=Number($("depth").value), threshold=Number($("threshold").value);
  mistakes=[];solved.clear();selectedMistake=-1;currentGame=null;cancelled=false;engineBusy=true;
  $("analyzeBtn").disabled=true;$("cancelBtn").classList.remove("hidden");setEngineStatus("Analyzing","busy");setMessage("");
  const total=games.reduce((n,g)=>n+g.history.length,0);let done=0;
  try{
    for(const game of games){
      const replay=new ChessCtor();
      for(let ply=0;ply<game.history.length;ply++){
        if(cancelled)break;
        const played=game.history[ply];
        const before=replay.fen();
        const mover=replay.turn();
        const best=await sendSearch(before,depth);
        if(cancelled)break;
        const bestWhite=scoreToWhite(best.score,before);
        replay.move(played);
        const after=replay.fen();
        const afterResult=await sendSearch(after,depth);
        if(cancelled)break;
        const afterWhite=scoreToWhite(afterResult.score,after);
        let loss=null;
        if(bestWhite!==null&&afterWhite!==null){
          // Convert both white-relative scores to the perspective of the player who made the move.
          const perspective=mover==="w"?1:-1;
          loss=Math.max(0,(bestWhite-afterWhite)*perspective);
          // Avoid treating forced mate scores as ordinary pawn losses.
        }
        const bestMove=best.bestmove;
        if(loss!==null&&loss>=threshold&&Math.abs(loss)<1000){
          const root=new ChessCtor();root.load(before);
          mistakes.push({gameId:game.id,ply,moveNumber:played.color==="w"?played.moveNumber:played.moveNumber,before,after,playedSan:played.san,playedUci:played.from+played.to+(played.promotion||""),bestUci:bestMove,bestSan:uciToSan(root,bestMove),loss,bestEval:bestWhite,afterEval:afterWhite,depth,fenAfter:after});
        }
        done++;setProgress(done,total,`Analyzing ${game.white} vs ${game.black} · move ${Math.floor(ply/2)+1}`);
      }
      if(cancelled)break;
    }
  }catch(e){setMessage("Analysis stopped: "+e.message,"error");}
  finally{
    engineBusy=false;$("analyzeBtn").disabled=false;$("cancelBtn").classList.add("hidden");setEngineStatus(engineReady?"Stockfish ready":"Engine not started",engineReady?"ready":"");
    if(cancelled)setMessage(`Analysis cancelled. ${mistakes.length} qualifying mistake(s) found so far.`);
    else setMessage(`Analysis complete. Found ${mistakes.length} position(s) with at least ${threshold.toFixed(2)} pawns of evaluation loss.`);
    renderMistakes();$("progressWrap").classList.add("hidden");
    if(mistakes.length)selectMistake(0);
  }
}
function renderMistakes(){
  const list=$("mistakeList");list.innerHTML="";
  $("gameMeta").textContent=games.length?`${games.length} game${games.length===1?"":"s"} loaded · ${games.reduce((n,g)=>n+g.history.length,0)} half-moves analyzed · threshold ${Number($("threshold").value).toFixed(2)} pawns`:"Upload a PGN to begin.";
  $("analysisSummary").classList.toggle("hidden",!games.length);$("analysisSummary").style.display=games.length?"grid":"";
  $("analysisSummary").innerHTML=`<div class="summary-stat"><strong>${games.length}</strong><span>GAMES</span></div><div class="summary-stat"><strong>${mistakes.length}</strong><span>MISTAKES</span></div><div class="summary-stat"><strong>${solved.size}</strong><span>SOLVED</span></div>`;
  if(!mistakes.length){list.innerHTML=games.length?'<div class="game-meta">No moves met this threshold at the selected search depth. Try a lower threshold or a deeper search.</div>':"";return;}
  mistakes.forEach((m,i)=>{
    const g=games.find(x=>x.id===m.gameId);
    const btn=document.createElement("button");btn.className="mistake-item"+(i===selectedMistake?" selected":"");btn.type="button";
    const fullmove=Math.floor(m.ply/2)+1, color=m.ply%2===0?"White":"Black";
    btn.innerHTML=`<span class="mistake-number">${String(i+1).padStart(2,"0")}</span><span class="mistake-details"><strong>${color} · ${fullmove}. ${escapeHtml(m.playedSan)} → ${escapeHtml(m.bestSan)}</strong><span>${escapeHtml(g?g.label:"Game")} · ${m.depth ? "Depth "+m.depth : ""}${solved.has(i)?" · ✓ Solved":""}</span></span><span class="loss-tag">−${m.loss.toFixed(2)}</span>`;
    btn.addEventListener("click",()=>selectMistake(i));list.appendChild(btn);
  });
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function selectMistake(i){
  if(i<0||i>=mistakes.length)return;
  selectedMistake=i;revealed=false;selectedSquare=null;
  const m=mistakes[i];currentGame=games.find(g=>g.id===m.gameId);
  boardGame=new ChessCtor();boardGame.load(m.before);lastMove=null;
  const history=currentGame.history.slice(0,m.ply);
  if(history.length)lastMove={from:history[history.length-1].from,to:history[history.length-1].to};
  $("positionTitle").textContent=`${m.ply%2===0?"White":"Black"} to move · Move ${Math.floor(m.ply/2)+1}`;
  $("positionSub").textContent=`${currentGame.white} vs ${currentGame.black} · Your move was ${m.playedSan}`;
  $("evalChip").textContent=`Loss −${m.loss.toFixed(2)}`;
  $("trainingMessage").className="training-message";
  $("trainingMessage").textContent=solved.has(i)?"You have solved this position before. Try it again from memory.":"Find the best move. Incorrect moves won't reveal the answer.";
  $("solutionBox").classList.add("hidden");$("revealBtn").disabled=false;
  renderBoard();renderHistory();renderMistakes();updateSummary();
}
function updateSummary(){const el=$("analysisSummary");if(games.length){el.innerHTML=`<div class="summary-stat"><strong>${games.length}</strong><span>GAMES</span></div><div class="summary-stat"><strong>${mistakes.length}</strong><span>MISTAKES</span></div><div class="summary-stat"><strong>${solved.size}</strong><span>SOLVED</span></div>`;}}
function renderBoard(){
  const el=$("board");el.innerHTML="";if(!boardGame)return;
  const board=boardGame.board();
  for(let visualRow=0;visualRow<8;visualRow++)for(let visualCol=0;visualCol<8;visualCol++){
    const row=flipped?7-visualRow:visualRow,col=flipped?7-visualCol:visualCol;
    const squareName="abcdefgh"[col]+(8-row),piece=board[row][col];
    const btn=document.createElement("button");btn.type="button";btn.className="square "+(((row+col)%2===0)?"light":"dark");
    btn.setAttribute("aria-label",`${squareName}${piece?` ${piece.color==="w"?"white":"black"} ${piece.type}`:" empty"}`);
    if(selectedSquare===squareName)btn.classList.add("selected");
    if(lastMove&&(lastMove.from===squareName||lastMove.to===squareName))btn.classList.add("lastmove");
    if(selectedSquare){const legal=boardGame.moves({square:selectedSquare,verbose:true}).some(m=>m.to===squareName);if(legal)btn.classList.add("legal",piece?"capture":"");}
    if(piece){const span=document.createElement("span");span.className="piece "+(piece.color==="w"?"white":"black");span.textContent=PIECES[piece.color][piece.type];btn.appendChild(span);}
    if((!flipped&&col===0)||(flipped&&col===7)){const c=document.createElement("span");c.className="coord";c.textContent=8-row;btn.appendChild(c);}
    if((!flipped&&row===7)||(flipped&&row===0)){const c=document.createElement("span");c.className="coord";c.style.left="auto";c.style.top="auto";c.style.right="4px";c.style.bottom="3px";c.textContent="abcdefgh"[col];btn.appendChild(c);}
    btn.addEventListener("click",()=>handleSquare(squareName));el.appendChild(btn);
  }
  updateEvalBar();
}
function updateEvalBar(){
  if(!boardGame)return;
  let score=0;
  if(selectedMistake>=0){const m=mistakes[selectedMistake];score=m.bestEval||0;}
  const pct=Math.max(5,Math.min(95,50+score*8));$("evalBarFill").style.height=pct+"%";
}
function handleSquare(square){
  if(!boardGame||revealed)return;
  const piece=boardGame.get(square);
  if(!selectedSquare){
    if(piece&&piece.color===boardGame.turn()){selectedSquare=square;renderBoard();}
    return;
  }
  if(piece&&piece.color===boardGame.turn()&&square!==selectedSquare){selectedSquare=square;renderBoard();return;}
  const legal=boardGame.moves({square:selectedSquare,verbose:true}).find(m=>m.to===square);
  if(!legal){selectedSquare=null;renderBoard();return;}
  const before=boardGame.fen();const move=boardGame.move({from:selectedSquare,to:square,promotion:"q"});selectedSquare=null;
  if(!move){renderBoard();return;}
  const m=mistakes[selectedMistake], attempted=move.from+move.to+(move.promotion||"");
  if(attempted===m.bestUci){
    solved.add(selectedMistake);revealed=true;
    $("trainingMessage").className="training-message good";$("trainingMessage").textContent=`Correct! ${move.san} is Stockfish's top move at the analyzed depth.`;
    showSolution(true);
  }else{
    boardGame.undo();
    $("trainingMessage").className="training-message bad";$("trainingMessage").textContent=`Not the engine's top move. Try again — the solution stays hidden.`;
  }
  renderBoard();renderMistakes();updateSummary();
}
function showSolution(solvedNow=false){
  if(selectedMistake<0)return;const m=mistakes[selectedMistake],box=$("solutionBox");
  box.classList.remove("hidden");
  box.innerHTML=`<strong>${solvedNow?"Solved!":"Solution revealed"}</strong><br>Best move: <strong>${escapeHtml(m.bestSan)}</strong><br>Your original move: ${escapeHtml(m.playedSan)}<br>Evaluation loss: <strong>${m.loss.toFixed(2)} pawns</strong><br>Search depth: ${m.depth}<br><span style="color:#bdc8b7">The engine's top move can vary with depth and engine version; this is the move found in this analysis.</span>`;
  $("revealBtn").disabled=true;
}
function renderHistory(){
  const el=$("moveHistory");if(!currentGame){el.textContent="No game loaded.";return;}
  el.innerHTML="";const m=selectedMistake>=0?mistakes[selectedMistake]:null;
  currentGame.history.forEach((move,idx)=>{
    if(move.color==="w"){const num=document.createElement("span");num.textContent=`${move.moveNumber}. `;el.appendChild(num);}
    const span=document.createElement("span");span.className="history-ply";
    if(m&&idx===m.ply)span.classList.add("current","mistake");
    span.textContent=move.san+" ";el.appendChild(span);
  });
  const result=document.createElement("span");result.textContent=" "+currentGame.result;el.appendChild(result);
}
function resetGuess(){
  if(selectedMistake<0)return;const m=mistakes[selectedMistake];boardGame=new ChessCtor();boardGame.load(m.before);revealed=false;selectedSquare=null;
  $("trainingMessage").className="training-message";$("trainingMessage").textContent="Find the best move. Incorrect moves won't reveal the answer.";
  $("solutionBox").classList.add("hidden");$("revealBtn").disabled=false;renderBoard();
}
$("pgnFile").addEventListener("change",async e=>{
  const file=e.target.files[0];if(!file)return;
  try{$("pgnText").value=await file.text();games=parsePgnGames($("pgnText").value);setMessage(`Loaded ${games.length} game(s) from ${file.name}.`);$("analyzeBtn").disabled=false;$("gameMeta").textContent=`${games.length} game(s) ready for analysis.`;renderMistakes();}
  catch(err){games=[];$("analyzeBtn").disabled=true;setMessage(err.message,"error");}
});
$("pgnText").addEventListener("input",()=>{
  try{games=parsePgnGames($("pgnText").value);$("analyzeBtn").disabled=false;setMessage(`${games.length} game(s) ready.`);}
  catch(_){games=[];$("analyzeBtn").disabled=true;}
});
$("analyzeBtn").addEventListener("click",analyzeAll);
$("cancelBtn").addEventListener("click",()=>{cancelled=true;stopSearch();});
$("flipBtn").addEventListener("click",()=>{flipped=!flipped;renderBoard();});
$("resetGuessBtn").addEventListener("click",resetGuess);
$("revealBtn").addEventListener("click",()=>{if(selectedMistake<0)return;revealed=true;showSolution(false);$("trainingMessage").className="training-message";$("trainingMessage").textContent="Solution revealed. Review the move, then select another mistake or reset this position.";renderBoard();});
$("engineStatus").addEventListener("click",async()=>{if(!engineReady){try{await initEngine();setMessage("Stockfish is ready.");}catch(e){setMessage(e.message,"error");}}});
window.addEventListener("beforeunload",()=>{if(engine)engine.terminate();});
})();