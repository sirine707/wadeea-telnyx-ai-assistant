import * as http from "node:http";

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url?.startsWith("/health/")) {
    res.writeHead(200); res.end(); return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "ok" }));
});

server.listen(process.env.PORT || 8080);
