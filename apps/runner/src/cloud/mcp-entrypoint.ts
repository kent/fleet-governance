import { createServer } from "node:http";
import { handleMcpRequest } from "./mcp-server.js";
createServer(handleMcpRequest).listen(Number(process.env.PORT ?? "8080"), "0.0.0.0", () => console.log("Fleet MCP ready."));
