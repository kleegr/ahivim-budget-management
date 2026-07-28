import { WebSocketServer } from "ws";
import net from "node:net";

/**
 * WebSocket-to-TCP bridge for local development.
 *
 * The Neon serverless driver speaks the PostgreSQL wire protocol over a
 * WebSocket, so it cannot open a socket to a PostgreSQL running on your
 * machine. This bridge sits between them, which lets the real application —
 * the production build, the real route handlers, the real queries — run
 * against a local database.
 *
 *   createdb ahivim_dev
 *   npm run dev:ws-proxy
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5432/ahivim_dev \
 *   NEON_WS_PROXY=127.0.0.1:5480 npm run dev
 *
 * Development only. Nothing imports it, and NEON_WS_PROXY is unset in
 * production, where src/lib/db/index.ts ignores this path entirely.
 */

const port = Number(process.env.WS_PROXY_PORT ?? 5480);
const server = new WebSocketServer({ port });

server.on("connection", (socket, request) => {
  const address = new URL(request.url ?? "", "http://localhost").searchParams.get("address");
  const [host, tcpPort] = (address ?? "").split(":");
  if (!host || !tcpPort) {
    socket.close(1008, "Missing ?address=host:port");
    return;
  }

  const upstream = net.connect({ host, port: Number(tcpPort) });
  socket.on("message", (chunk) => upstream.write(chunk as Buffer));
  upstream.on("data", (chunk) => {
    if (socket.readyState === socket.OPEN) socket.send(chunk);
  });

  const close = () => {
    upstream.destroy();
    if (socket.readyState === socket.OPEN) socket.close();
  };
  socket.on("close", close);
  socket.on("error", close);
  upstream.on("close", close);
  upstream.on("error", close);
});

console.log(`ws-proxy listening on ${port}; point NEON_WS_PROXY at 127.0.0.1:${port}`);
