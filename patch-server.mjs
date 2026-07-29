// Legacy entrypoint kept only so an old Railway custom start command
// (`node patch-server.mjs`) still boots. The runtime patch it used to apply
// is baked into server.js now.
import "./server.js";
