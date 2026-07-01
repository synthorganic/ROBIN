const path = require('node:path'); function normalizeWindowsPath(p) { let normalized = p.replace(/%2F/g, '\'); if (normalized.length >= 2 && normalized[1] === ':') { normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1); } return normalized; } const docDir = path.join(require('node:os').homedir(), '.robin', 'inertiai-ops', 'documents'); console.log('Doc dir:', docDir);

