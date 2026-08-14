// Simple relay server for the DIY remote desktop app.
// Two kinds of clients connect here:
//   - the Windows "agent" (sends screen frames, receives input commands)
//   - the web "viewer" (sends input commands, receives screen frames)
// The server just passes messages between them. It never looks at
// or stores the actual screen content.

const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// Rooms keyed by a 6-character room code. Each room can have at most
// one agent and one viewer.
const rooms = new Map(); // code -> { agent: ws|null, viewer: ws|null, password: string }

function makeRoomCode() {
  return crypto.randomBytes(3).toString("hex"); // e.g. "a1b2c3"
}

const server = http.createServer((req, res) => {
  if (req.url === "/create-room" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let password = "";
      try {
        password = JSON.parse(body || "{}").password || "";
      } catch (e) {}
      const code = makeRoomCode();
      rooms.set(code, { agent: null, viewer: null, password });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Remote desktop relay server is running.\n");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.role = null;
  ws.roomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    // First message from any client must be a "join" message.
    if (msg.type === "join") {
      let room = rooms.get(msg.code);

      if (!room) {
        // Auto-create the room. Agents can create a fresh room just by
        // picking a name. Viewers can only join a room that already
        // exists (i.e. the agent must connect first).
        if (msg.role === "agent") {
          room = { agent: null, viewer: null, password: msg.password || "" };
          rooms.set(msg.code, room);
        } else {
          ws.send(JSON.stringify({ type: "error", message: "PC not connected yet. Start the agent on your PC first." }));
          return;
        }
      }

      if (room.password && room.password !== msg.password) {
        ws.send(JSON.stringify({ type: "error", message: "Wrong password" }));
        return;
      }
      if (msg.role !== "agent" && msg.role !== "viewer") {
        ws.send(JSON.stringify({ type: "error", message: "Invalid role" }));
        return;
      }
      if (room[msg.role]) {
        ws.send(JSON.stringify({ type: "error", message: `A ${msg.role} is already connected to this room` }));
        return;
      }

      room[msg.role] = ws;
      ws.role = msg.role;
      ws.roomCode = msg.code;
      ws.send(JSON.stringify({ type: "joined", role: msg.role }));

      // Let the other side know someone connected.
      const other = msg.role === "agent" ? room.viewer : room.agent;
      if (other) {
        other.send(JSON.stringify({ type: "peer-connected" }));
        ws.send(JSON.stringify({ type: "peer-connected" }));
      }
      return;
    }

    // Any other message just gets relayed to the other side of the room.
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const other = ws.role === "agent" ? room.viewer : room.agent;
    if (other && other.readyState === WebSocket.OPEN) {
      // Forward as a text frame (not binary) so browsers parse it correctly.
      other.send(typeof raw === "string" ? raw : raw.toString("utf8"));
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.role === "agent") room.agent = null;
    if (ws.role === "viewer") room.viewer = null;
    const other = ws.role === "agent" ? room.viewer : room.agent;
    if (other) other.send(JSON.stringify({ type: "peer-disconnected" }));
    // Clean up empty rooms
    if (!room.agent && !room.viewer) rooms.delete(ws.roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
