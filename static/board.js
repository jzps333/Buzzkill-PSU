// Buzzkill board: lobby, start button, live leaderboard. Open /board on a laptop or TV.

const $ = (s) => document.querySelector(s);
let ws = null;

$("#url").textContent = location.origin + "/";

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/board`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "error") $("#error").textContent = msg.message;
    if (msg.type === "state") render(msg);
  };
  ws.onclose = () => setTimeout(connect, 1000);
}

$("#startBtn").onclick = () => {
  $("#error").textContent = "";
  send({ type: "start", minutes: Number($("#minutes").value) || 25 });
};
$("#resetBtn").onclick = () => send({ type: "reset" });
$("#voiceBtn").onclick = () => send({ type: "test-voice" });

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function render(state) {
  for (const id of ["lobby", "running", "ended"]) $("#" + id).classList.toggle("hidden", id !== state.phase);

  const ready = state.players.filter((p) => p.ready && p.connected).length;
  $("#readyCount").textContent = `${ready} / ${state.minPlayers} players ready`;
  $("#startBtn").disabled = ready < state.minPlayers;

  const m = Math.floor(state.remaining / 60), s = String(state.remaining % 60).padStart(2, "0");
  $("#timer").textContent = `${m}:${s}`;
  if (state.players[0]) $("#winner").textContent = `${state.players[0].name} wins with ${state.players[0].score} points!`;

  $("#rows").innerHTML = state.players.map((p, i) => {
    let phone = "Not ready";
    if (!p.connected) phone = "Left";
    else if (p.roasting) phone = "BEING ROASTED";
    else if (p.ready) phone = p.down ? "Face-down" : "Phone up";
    return `<tr class="${p.roasting ? "roasted" : ""}">
      <td>${i + 1}</td><td>${esc(p.name)}</td><td>${phone}</td>
      <td class="num">${p.pickups}</td><td class="num">${p.score}</td></tr>`;
  }).join("");
}

connect();
