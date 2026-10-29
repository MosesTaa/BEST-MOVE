"use strict";

const $ = id => document.getElementById(id);

const ENGINE_BASE =
  "https://cdn.jsdelivr.net/npm/stockfish@19.0.1/bin/";

const ENGINE_JS = ENGINE_BASE + "stockfish-19-lite-single.js";

const PIECES = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" }
};

let engine = null;
let engineReady = false;
let engineBusy = false;
let cancelled = false;
let searchResolve = null;
let engineTimeout = null;

let searchInfo = {};
let games = [];
let mistakes = [];
let selectedMistake = -1;
let currentGame = null;
let boardGame = null;
let selectedSquare = null;
let lastMove = null;
let flipped = false;
let revealed = false;

const solved = new Set();

/* ----------------------------------
   MESSAGES AND DISPLAY HELPERS
---------------------------------- */

function setMessage(text, kind = "") {
  const el = $("importMessage");
  el.textContent = text;
  el.className = "message " + kind;
}

function setEngineStatus(text, kind = "") {
  const el = $("engineStatus");
  el.textContent = text;
  el.className = "engine-pill " + kind;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

/* ----------------------------------
   PGN IMPORT
---------------------------------- */

function parsePgnGames(pgn) {
  if (typeof Chess !== "function") {
    throw new Error("The chess rules library failed to load.");
  }

  const text = pgn.trim();

  if (!text) {
    throw new Error("Please upload or paste a PGN first.");
  }

  const chunks = text
    .split(/(?=^\s*\[Event\s)/m)
    .map(part => part.trim())
    .filter(Boolean);

  const candidates = chunks.length ? chunks : [text];
  const result = [];

  for (let i = 0; i < candidates.length; i++) {
    const chess = new Chess();

    try {
      const loaded = chess.load_pgn(candidates[i], {
        sloppy: true
      });

      if (loaded === false) {
        throw new Error("Invalid PGN.");
      }
    } catch (error) {
      throw new Error(
        `Could not read game ${i + 1}: ${error.message}`
      );
    }

    const history = chess.history({ verbose: true });

    if (!history.length) continue;

    const headers = chess.header();

    result.push({
      id: result.length,
      headers,
      history,
      pgn: candidates[i],
      label: headers.Event || `Game ${result.length + 1}`,
      white: headers.White || "White",
      black: headers.Black || "Black",
      result: headers.Result || "*"
    });
  }

  if (!result.length) {
    throw new Error("No chess moves were found in this PGN.");
  }

  return result;
}

/* ----------------------------------
   STOCKFISH ENGINE
---------------------------------- */

/*
  A Blob worker imports Stockfish from the CDN.
  The explicit locateFile setting directs the engine
  to its matching WebAssembly file.
*/

function initEngine() {
  if (engineReady) return Promise.resolve();

  if (engine) {
    engine.terminate();
    engine = null;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let workerUrl = null;

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(engineTimeout);
      setEngineStatus("Engine failed");
      reject(error);
    }

    try {
      const bootstrap = `
        self.Module = {
          locateFile: function(path) {
            return "${ENGINE_BASE}" + path;
          }
        };
        importScripts("${ENGINE_JS}");
      `;

      const blob = new Blob(
        [bootstrap],
        { type: "application/javascript" }
      );

      workerUrl = URL.createObjectURL(blob);
      engine = new Worker(workerUrl);

      engine.onmessage = event => {
        const line = String(event.data);

        if (line === "uciok") {
          engine.postMessage("isready");
          return;
        }

        if (line === "readyok") {
          engineReady = true;
          settled = true;

          clearTimeout(engineTimeout);
          setEngineStatus("Stockfish ready", "ready");

          resolve();
          return;
        }

        if (line.startsWith("info ")) {
          const depthMatch = line.match(/\bdepth (\d+)/);
          const cpMatch = line.match(/\bscore cp (-?\d+)/);
          const mateMatch = line.match(/\bscore mate (-?\d+)/);
          const pvMatch = line.match(
            /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/
          );

          if (depthMatch) {
            searchInfo.depth = Number(depthMatch[1]);

            $("progressText").textContent =
              `Stockfish searching at depth ${depthMatch[1]}…`;
          }

          /*
            Ignore bounded scores for the final evaluation.
            A later unbounded score may replace this value.
          */

          if (cpMatch &&
              !/\b(?:lowerbound|upperbound)\b/.test(line)) {
            searchInfo.score = {
              type: "cp",
              value: Number(cpMatch[1])
            };
          }

          if (mateMatch &&
              !/\b(?:lowerbound|upperbound)\b/.test(line)) {
            searchInfo.score = {
              type: "mate",
              value: Number(mateMatch[1])
            };
          }

          if (pvMatch) {
            searchInfo.pv = pvMatch[1];
          }
        }

        if (line.startsWith("bestmove ")) {
          searchInfo.bestmove = line.split(/\s+/)[1];

          if (searchResolve) {
            const callback = searchResolve;
            searchResolve = null;
            callback({ ...searchInfo });
          }
        }
      };

      engine.onerror = () => {
        fail(new Error(
          "Stockfish could not load. Check your internet connection " +
          "and verify that the engine files are accessible."
        ));
      };

      engine.postMessage("uci");

      engineTimeout = setTimeout(() => {
        fail(new Error(
          "Stockfish took too long to initialize. Reload the page " +
          "and check your connection."
        ));
      }, 90000);

    } catch (error) {
      fail(error);
    }
  });
}

function sendSearch(fen, depth) {
  return new Promise((resolve, reject) => {
    if (!engineReady || !engine) {
      reject(new Error("Stockfish is not ready."));
      return;
    }

    if (searchResolve) {
      reject(new Error("Another engine search is still running."));
      return;
    }

    searchInfo = {
      score: null,
      depth: 0,
      bestmove: null,
      pv: null
    };

    searchResolve = resolve;

    engine.postMessage("position fen " + fen);
    engine.postMessage("go depth " + depth);
  });
}

function stopSearch() {
  if (engine && engineBusy) {
    engine.postMessage("stop");
  }
}

/*
  Stockfish UCI scores are converted to White's perspective.
  Mate scores are kept separate from ordinary pawn scores.
*/

function scoreToWhite(score, fen) {
  if (!score) return null;

  const turn = fen.split(/\s+/)[1];
  const sign = turn === "w" ? 1 : -1;

  if (score.type === "cp") {
    return score.value * sign / 100;
  }

  if (score.type === "mate") {
    if (score.value === 0) return 0;

    return score.value > 0
      ? 1000 * sign
      : -1000 * sign;
  }

  return null;
}

/* ----------------------------------
   CHESS NOTATION
---------------------------------- */

function uciToSan(chess, uci) {
  if (!uci || uci === "(none)" || uci === "0000") {
    return "—";
  }

  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci[4];

  try {
    const move = chess.move({
      from,
      to,
      promotion: promotion || "q"
    });

    if (!move) return uci;

    chess.undo();
    return move.san;
  } catch (_) {
    return uci;
  }
}

/* ----------------------------------
   ANALYSIS PROGRESS
---------------------------------- */

function setProgress(done, total, text) {
  const percent = total
    ? Math.round(done / total * 100)
    : 0;

  $("progressWrap").classList.remove("hidden");
  $("progressBar").style.width = percent + "%";
  $("progressPercent").textContent = percent + "%";
  $("progressText").textContent =
    text || `Analyzed ${done} of ${total} moves`;
}

/* ----------------------------------
   ANALYZE ALL GAMES
---------------------------------- */

async function analyzeAll() {
  if (engineBusy) return;

  try {
    games = parsePgnGames($("pgnText").value);
    await initEngine();
  } catch (error) {
    setMessage(error.message, "error");
    return;
  }

  const depth = Number($("depth").value);
  const threshold = Number($("threshold").value);

  mistakes = [];
  solved.clear();
  selectedMistake = -1;
  currentGame = null;
  boardGame = null;
  cancelled = false;
  engineBusy = true;

  $("analyzeBtn").disabled = true;
  $("cancelBtn").classList.remove("hidden");

  setEngineStatus("Analyzing", "busy");
  setMessage("");

  const total = games.reduce(
    (count, game) => count + game.history.length,
    0
  );

  let done = 0;

  try {
    for (const game of games) {
      const replay = new Chess();

      for (let ply = 0; ply < game.history.length; ply++) {
        if (cancelled) break;

        const played = game.history[ply];
        const before = replay.fen();
        const mover = replay.turn();

        /*
          Analyze the position before the played move.
          The engine's best move is the reference move.
        */

        const best = await sendSearch(before, depth);

        if (cancelled) break;

        if (!best.bestmove || best.bestmove === "0000") {
          replay.move(played);
          done++;
          continue;
        }

        const bestWhite = scoreToWhite(best.score, before);

        /*
          Apply the player's actual move, then analyze
          the resulting position with the opponent to move.
        */

        replay.move(played);

        const after = replay.fen();
        const afterResult = await sendSearch(after, depth);

        if (cancelled) break;

        const afterWhite = scoreToWhite(
          afterResult.score,
          after
        );

        let loss = null;

        if (bestWhite !== null && afterWhite !== null) {
          const perspective = mover === "w" ? 1 : -1;

          loss = Math.max(
            0,
            (bestWhite - afterWhite) * perspective
          );
        }

        if (
          loss !== null &&
          loss >= threshold &&
          loss < 1000
        ) {
          const root = new Chess();
          root.load(before);

          mistakes.push({
            gameId: game.id,
            ply,
            before,
            after,
            playedSan: played.san,
            playedUci:
              played.from + played.to + (played.promotion || ""),
            bestUci: best.bestmove,
            bestSan: uciToSan(root, best.bestmove),
            loss,
            bestEval: bestWhite,
            afterEval: afterWhite,
            depth,
            fenAfter: after
          });
        }

        done++;

        setProgress(
          done,
          total,
          `Analyzing ${game.white} vs ${game.black} · move ${Math.floor(ply / 2) + 1}`
        );
      }

      if (cancelled) break;
    }

  } catch (error) {
    setMessage("Analysis stopped: " + error.message, "error");

  } finally {
    engineBusy = false;

    $("analyzeBtn").disabled = false;
    $("cancelBtn").classList.add("hidden");

    setEngineStatus(
      engineReady ? "Stockfish ready" : "Engine not started",
      engineReady ? "ready" : ""
    );

    $("progressWrap").classList.add("hidden");

    if (cancelled) {
      setMessage(
        `Analysis cancelled. ${mistakes.length} qualifying mistake(s) found.`
      );
    } else {
      setMessage(
        `Analysis complete. Found ${mistakes.length} position(s) ` +
        `with at least ${threshold.toFixed(2)} pawns of evaluation loss.`
      );
    }

    renderMistakes();

    if (mistakes.length) {
      selectMistake(0);
    } else {
      $("positionTitle").textContent = "No qualifying mistakes";
      $("positionSub").textContent =
        "Try a lower threshold or a different search depth.";
    }
  }
}

/* ----------------------------------
   MISTAKE LIST
---------------------------------- */

function renderMistakes() {
  const list = $("mistakeList");
  list.innerHTML = "";

  const totalPlies = games.reduce(
    (count, game) => count + game.history.length,
    0
  );

  $("gameMeta").textContent = games.length
    ? `${games.length} game(s) loaded · ${totalPlies} half-moves · ` +
      `threshold ${Number($("threshold").value).toFixed(2)} pawns`
    : "Upload a PGN to begin.";

  const summary = $("analysisSummary");

  summary.classList.toggle("hidden", !games.length);
  summary.style.display = games.length ? "grid" : "";

  updateSummary();

  if (!mistakes.length) {
    if (games.length) {
      list.innerHTML =
        '<div class="game-meta">No moves met this threshold at the ' +
        'selected search depth. Try a lower threshold or a deeper search.</div>';
    }

    return;
  }

  mistakes.forEach((mistake, index) => {
    const game = games.find(g => g.id === mistake.gameId);

    const fullmove = Math.floor(mistake.ply / 2) + 1;
    const color = mistake.ply % 2 === 0 ? "White" : "Black";

    const button = document.createElement("button");

    button.type = "button";
    button.className =
      "mistake-item" +
      (index === selectedMistake ? " selected" : "");

    const solvedText = solved.has(index) ? " · ✓ Solved" : "";

    button.innerHTML = `
      <span class="mistake-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="mistake-details">
        <strong>${color} · ${fullmove}. ${escapeHtml(mistake.playedSan)}
        → ${escapeHtml(mistake.bestSan)}</strong>
        <span>${escapeHtml(game ? game.label : "Game")} ·
        Depth ${mistake.depth}${solvedText}</span>
      </span>
      <span class="loss-tag">−${mistake.loss.toFixed(2)}</span>
    `;

    button.addEventListener("click", () => selectMistake(index));

    list.appendChild(button);
  });
}

function updateSummary() {
  $("analysisSummary").innerHTML = `
    <div class="summary-stat">
      <strong>${games.length}</strong><span>GAMES</span>
    </div>
    <div class="summary-stat">
      <strong>${mistakes.length}</strong><span>MISTAKES</span>
    </div>
    <div class="summary-stat">
      <strong>${solved.size}</strong><span>SOLVED</span>
    </div>
  `;
}

/* ----------------------------------
   LOAD A MISTAKE FOR TRAINING
---------------------------------- */

function selectMistake(index) {
  if (index < 0 || index >= mistakes.length) return;

  selectedMistake = index;
  revealed = false;
  selectedSquare = null;

  const mistake = mistakes[index];

  currentGame = games.find(
    game => game.id === mistake.gameId
  );

  boardGame = new Chess();
  boardGame.load(mistake.before);

  lastMove = null;

  const history = currentGame.history.slice(0, mistake.ply);

  if (history.length) {
    const previous = history[history.length - 1];

    lastMove = {
      from: previous.from,
      to: previous.to
    };
  }

  $("positionTitle").textContent =
    `${mistake.ply % 2 === 0 ? "White" : "Black"} to move · ` +
    `Move ${Math.floor(mistake.ply / 2) + 1}`;

  $("positionSub").textContent =
    `${currentGame.white} vs ${currentGame.black} · ` +
    `Your move was ${mistake.playedSan}`;

  $("evalChip").textContent =
    `Loss −${mistake.loss.toFixed(2)}`;

  $("trainingMessage").className = "training-message";
  $("trainingMessage").textContent = solved.has(index)
    ? "You have solved this position before. Try it again from memory."
    : "Find the best move. Incorrect guesses won't reveal the answer.";

  $("solutionBox").classList.add("hidden");
  $("revealBtn").disabled = false;

  renderBoard();
  renderHistory();
  renderMistakes();
}

/* ----------------------------------
   INTERACTIVE CHESSBOARD
---------------------------------- */

function renderBoard() {
  const el = $("board");
  el.innerHTML = "";

  if (!boardGame) return;

  const board = boardGame.board();

  for (let visualRow = 0; visualRow < 8; visualRow++) {
    for (let visualCol = 0; visualCol < 8; visualCol++) {
      const row = flipped ? 7 - visualRow : visualRow;
      const col = flipped ? 7 - visualCol : visualCol;

      const squareName = "abcdefgh"[col] + (8 - row);
      const piece = board[row][col];

      const button = document.createElement("button");

      button.type = "button";
      button.className =
        "square " + ((row + col) % 2 === 0 ? "light" : "dark");

      button.setAttribute(
        "aria-label",
        `${squareName}${piece
          ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}`
          : " empty"}`
      );

      if (selectedSquare === squareName) {
        button.classList.add("selected");
      }

      if (
        lastMove &&
        (lastMove.from === squareName || lastMove.to === squareName)
      ) {
        button.classList.add("lastmove");
      }

      if (selectedSquare) {
        const legal = boardGame
          .moves({ square: selectedSquare, verbose: true })
          .some(move => move.to === squareName);

        if (legal) {
          button.classList.add("legal");

          if (piece) {
            button.classList.add("capture");
          }
        }
      }

      if (piece) {
        const span = document.createElement("span");

        span.className =
          "piece " + (piece.color === "w" ? "white" : "black");

        span.textContent = PIECES[piece.color][piece.type];

        button.appendChild(span);
      }

      if ((!flipped && col === 0) || (flipped && col === 7)) {
        const coordinate = document.createElement("span");

        coordinate.className = "coord";
        coordinate.textContent = 8 - row;

        button.appendChild(coordinate);
      }

      if ((!flipped && row === 7) || (flipped && row === 0)) {
        const coordinate = document.createElement("span");

        coordinate.className = "coord";
        coordinate.style.left = "auto";
        coordinate.style.top = "auto";
        coordinate.style.right = "4px";
        coordinate.style.bottom = "3px";
        coordinate.textContent = "abcdefgh"[col];

        button.appendChild(coordinate);
      }

      button.addEventListener(
        "click",
        () => handleSquare(squareName)
      );

      el.appendChild(button);
    }
  }

  updateEvalBar();
}

function updateEvalBar() {
  if (!boardGame) return;

  const mistake = mistakes[selectedMistake];

  if (!mistake || mistake.bestEval === null) return;

  /*
    Display is a simple visual indicator, not an exact
    conversion of engine evaluation into win probability.
  */

  const score = Math.max(-6, Math.min(6, mistake.bestEval));
  const percent = Math.max(5, Math.min(95, 50 + score * 7));

  $("evalBarFill").style.height = percent + "%";
}

/* ----------------------------------
   GUESS THE BEST MOVE
---------------------------------- */

function handleSquare(square) {
  if (!boardGame || revealed || selectedMistake < 0) return;

  const piece = boardGame.get(square);

  if (!selectedSquare) {
    if (piece && piece.color === boardGame.turn()) {
      selectedSquare = square;
      renderBoard();
    }

    return;
  }

  if (
    piece &&
    piece.color === boardGame.turn() &&
    square !== selectedSquare
  ) {
    selectedSquare = square;
    renderBoard();
    return;
  }

  const legalMove = boardGame
    .moves({ square: selectedSquare, verbose: true })
    .find(move => move.to === square);

  if (!legalMove) {
    selectedSquare = null;
    renderBoard();
    return;
  }

  /*
    This version promotes to a queen by default.
    A promotion chooser can be added as a later enhancement.
  */

  const move = boardGame.move({
    from: selectedSquare,
    to: square,
    promotion: "q"
  });

  selectedSquare = null;

  if (!move) {
    renderBoard();
    return;
  }

  const mistake = mistakes[selectedMistake];

  const attemptedUci =
    move.from + move.to + (move.promotion || "");

  if (attemptedUci === mistake.bestUci) {
    solved.add(selectedMistake);
    revealed = true;

    $("trainingMessage").className = "training-message good";
    $("trainingMessage").textContent =
      `Correct! ${move.san} is Stockfish's top move at the analyzed depth.`;

    showSolution(true);

  } else {
    boardGame.undo();

    $("trainingMessage").className = "training-message bad";
    $("trainingMessage").textContent =
      "Not the engine's top move. Try again — the solution stays hidden.";
  }

  renderBoard();
  renderMistakes();
  updateSummary();
}

/* ----------------------------------
   SOLUTION REVIEW
---------------------------------- */

function showSolution(solvedNow = false) {
  if (selectedMistake < 0) return;

  const mistake = mistakes[selectedMistake];
  const box = $("solutionBox");

  box.classList.remove("hidden");

  box.innerHTML = `
    <strong>${solvedNow ? "Solved!" : "Solution revealed"}</strong><br>
    Best move: <strong>${escapeHtml(mistake.bestSan)}</strong><br>
    Your original move: ${escapeHtml(mistake.playedSan)}<br>
    Evaluation loss: <strong>${mistake.loss.toFixed(2)} pawns</strong><br>
    Search depth: ${mistake.depth}<br>
    <span style="color:#bdc8b7">
      The recommended move is based on the engine search used for this analysis.
    </span>
  `;

  $("revealBtn").disabled = true;
}

function resetGuess() {
  if (selectedMistake < 0) return;

  const mistake = mistakes[selectedMistake];

  boardGame = new Chess();
  boardGame.load(mistake.before);

  revealed = false;
  selectedSquare = null;

  $("trainingMessage").className = "training-message";
  $("trainingMessage").textContent =
    "Find the best move. Incorrect guesses won't reveal the answer.";

  $("solutionBox").classList.add("hidden");
  $("revealBtn").disabled = false;

  renderBoard();
}

/* ----------------------------------
   GAME MOVE HISTORY
---------------------------------- */

function renderHistory() {
  const el = $("moveHistory");
  el.innerHTML = "";

  if (!currentGame) {
    el.textContent = "No game loaded.";
    return;
  }

  const mistake = mistakes[selectedMistake];

  currentGame.history.forEach((move, index) => {
    if (move.color === "w") {
      const number = document.createElement("span");

      number.textContent = `${Math.floor(index / 2) + 1}. `;
      el.appendChild(number);
    }

    const span = document.createElement("span");

    span.className = "history-ply";

    if (mistake && index === mistake.ply) {
      span.classList.add("current", "mistake");
    }

    span.textContent = move.san + " ";
    el.appendChild(span);
  });

  const result = document.createElement("span");

  result.textContent = " " + currentGame.result;
  el.appendChild(result);
}

/* ----------------------------------
   BUTTONS AND FILE INPUT
---------------------------------- */

$("pgnFile").addEventListener("change", async event => {
  const file = event.target.files[0];

  if (!file) return;

  try {
    const text = await file.text();

    $("pgnText").value = text;
    games = parsePgnGames(text);

    mistakes = [];
    solved.clear();
    selectedMistake = -1;
    boardGame = null;

    setMessage(`Loaded ${games.length} game(s) from ${file.name}.`);
    $("analyzeBtn").disabled = false;

    renderMistakes();

  } catch (error) {
    games = [];
    $("analyzeBtn").disabled = true;
    setMessage(error.message, "error");
  }
});

$("pgnText").addEventListener("input", () => {
  try {
    games = parsePgnGames($("pgnText").value);

    mistakes = [];
    solved.clear();
    selectedMistake = -1;
    boardGame = null;

    $("analyzeBtn").disabled = false;
    setMessage(`${games.length} game(s) ready for analysis.`);

    renderMistakes();

  } catch (_) {
    games = [];
    $("analyzeBtn").disabled = true;
  }
});

$("analyzeBtn").addEventListener("click", analyzeAll);

$("cancelBtn").addEventListener("click", () => {
  cancelled = true;
  stopSearch();
});

$("flipBtn").addEventListener("click", () => {
  flipped = !flipped;
  renderBoard();
});

$("resetGuessBtn").addEventListener("click", resetGuess);

$("revealBtn").addEventListener("click", () => {
  if (selectedMistake < 0) return;

  revealed = true;
  showSolution(false);

  $("trainingMessage").className = "training-message";
  $("trainingMessage").textContent =
    "Solution revealed. Review the move, then select another mistake or reset this position.";

  renderBoard();
});

$("engineStatus").addEventListener("click", async () => {
  if (!engineReady) {
    try {
      await initEngine();
      setMessage("Stockfish is ready.");
    } catch (error) {
      setMessage(error.message, "error");
    }
  }
});

window.addEventListener("beforeunload", () => {
  if (engine) engine.terminate();
});
