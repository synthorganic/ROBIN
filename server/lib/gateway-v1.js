"use strict";
/**
 * ROBIN Gateway v1 - Local-first gateway server.
 *
 * A lightweight HTTP server providing tool execution endpoints without OpenClaw.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGatewayApp = createGatewayApp;
exports.startGatewayServer = startGatewayServer;
var hono_1 = require("hono");
var logger_1 = require("hono/logger");
var node_server_1 = require("@hono/node-server");
var node_fs_1 = require("node:fs");
var node_path_1 = require("node:path");
var node_os_1 = require("node:os");
var node_crypto_1 = require("node:crypto");
var gateway_execution_js_1 = require("./gateway-execution.js");
var gateway_files_js_1 = require("./gateway-files.js");
var HOME = process.env.HOME || node_os_1.default.homedir();
var ROBIN_DIR = node_path_1.default.join(HOME, '.robin');
var GATEWAY_CONFIG_PATH = node_path_1.default.join(ROBIN_DIR, 'gateway.json');
function loadGatewayConfig() {
    if (!(0, node_fs_1.existsSync)(GATEWAY_CONFIG_PATH)) {
        return { gateway: { port: 18789, bind: '127.0.0.1' } };
    }
    try {
        var raw = (0, node_fs_1.readFileSync)(GATEWAY_CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch (err) {
        console.warn('[gateway] Failed to load config:', err.message);
        return { gateway: { port: 18789, bind: '127.0.0.1' } };
    }
}
function saveGatewayConfig(cfg) {
    (0, node_fs_1.mkdirSync)(ROBIN_DIR, { recursive: true });
    (0, node_fs_1.writeFileSync)(GATEWAY_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
function getCommand(body) {
    if (body && typeof body === 'object') {
        var r = body;
        // Direct command field
        if ('command' in r && typeof r.command === 'string')
            return r.command;
        // Tool args format
        if (r.args && typeof r.args === 'object' && 'command' in r.args) {
            var argsCmd = r.args.command;
            if (typeof argsCmd === 'string')
                return argsCmd;
        }
    }
    throw new Error('Missing required field: command');
}
function createGatewayApp() {
    var _this = this;
    var app = new hono_1.Hono();
    app.use('*', (0, logger_1.logger)());
    // Health check
    app.get('/health', function (c) { return c.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
    }); });
    // Token management
    app.post('/init', function (c) { return __awaiter(_this, void 0, void 0, function () {
        var body, cfg, sec, token, err_1;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, c.req.json()];
                case 1:
                    body = _c.sent();
                    cfg = loadGatewayConfig();
                    if (!cfg.gateway)
                        cfg.gateway = { port: 18789, bind: '127.0.0.1' };
                    sec = body.security || 'token';
                    // Ensure gateway and auth exist
                    if (!cfg.gateway) {
                        cfg.gateway = { port: 18789, bind: '127.0.0.1' };
                    }
                    if (sec === 'none') {
                        delete cfg.gateway.auth;
                    }
                    else if (!cfg.gateway.auth) {
                        cfg.gateway.auth = { mode: 'token', token: '' };
                    }
                    // Safe access since we checked auth exists above
                    if (cfg.gateway.auth) {
                        cfg.gateway.auth.token = node_crypto_1.default.randomBytes(32).toString('base64url');
                    }
                    saveGatewayConfig(cfg);
                    token = (_b = (_a = cfg.gateway) === null || _a === void 0 ? void 0 : _a.auth) === null || _b === void 0 ? void 0 : _b.token;
                    return [2 /*return*/, c.json({
                            ok: true,
                            message: 'Gateway initialized',
                            configPath: GATEWAY_CONFIG_PATH,
                            authEnabled: sec !== 'none',
                            tokenHint: "Use GATEWAY_TOKEN=".concat(token, " in .env"),
                        })];
                case 2:
                    err_1 = _c.sent();
                    return [2 /*return*/, c.json({ ok: false, error: err_1.message }, 500)];
                case 3: return [2 /*return*/];
            }
        });
    }); });
    app.get('/config', function (c) {
        var cfg = loadGatewayConfig();
        return c.json({ ok: true, gateway: cfg.gateway });
    });
    // Execute routes - direct local execution
    app.post('/execute/bash', function (c) { return __awaiter(_this, void 0, void 0, function () {
        var body, result, err_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, c.req.json()];
                case 1:
                    body = _a.sent();
                    if (!body || !body.command) {
                        return [2 /*return*/, c.json({ ok: false, error: 'Missing command' }, 400)];
                    }
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, (0, gateway_execution_js_1.executeBash)(body.command, {
                            timeoutMs: body.timeoutMs || 30000,
                            cwd: process.cwd(),
                        })];
                case 3:
                    result = _a.sent();
                    return [2 /*return*/, c.json({ ok: true, result: result })];
                case 4:
                    err_2 = _a.sent();
                    return [2 /*return*/, c.json({ ok: false, error: err_2.message }, 500)];
                case 5: return [2 /*return*/];
            }
        });
    }); });
    app.post('/execute/powershell', function (c) { return __awaiter(_this, void 0, void 0, function () {
        var body, result, err_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, c.req.json()];
                case 1:
                    body = _a.sent();
                    if (!body || !body.command) {
                        return [2 /*return*/, c.json({ ok: false, error: 'Missing command' }, 400)];
                    }
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, (0, gateway_execution_js_1.executePowerShell)(body.command, {
                            timeoutMs: body.timeoutMs || 60000,
                            cwd: process.cwd(),
                        })];
                case 3:
                    result = _a.sent();
                    return [2 /*return*/, c.json({ ok: true, result: result })];
                case 4:
                    err_3 = _a.sent();
                    return [2 /*return*/, c.json({ ok: false, error: err_3.message }, 500)];
                case 5: return [2 /*return*/];
            }
        });
    }); });
    // Tools invoke for compatibility
    app.post('/tools/invoke', function (c) { return __awaiter(_this, void 0, void 0, function () {
        var body, tool, cmd, result, _a, err_4;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, c.req.json()];
                case 1:
                    body = _d.sent();
                    tool = String((body === null || body === void 0 ? void 0 : body.tool) || '');
                    _d.label = 2;
                case 2:
                    _d.trys.push([2, 9, , 10]);
                    cmd = getCommand(body.args);
                    result = void 0;
                    _a = tool;
                    switch (_a) {
                        case 'bash': return [3 /*break*/, 3];
                        case 'powershell': return [3 /*break*/, 5];
                    }
                    return [3 /*break*/, 7];
                case 3: return [4 /*yield*/, (0, gateway_execution_js_1.executeBash)(cmd, {
                        timeoutMs: Number((_b = body.args) === null || _b === void 0 ? void 0 : _b.timeoutMs) || 30000,
                        cwd: process.cwd(),
                    })];
                case 4:
                    result = _d.sent();
                    return [3 /*break*/, 8];
                case 5: return [4 /*yield*/, (0, gateway_execution_js_1.executePowerShell)(cmd, {
                        timeoutMs: Number((_c = body.args) === null || _c === void 0 ? void 0 : _c.timeoutMs) || 60000,
                        cwd: process.cwd(),
                    })];
                case 6:
                    result = _d.sent();
                    return [3 /*break*/, 8];
                case 7: return [2 /*return*/, c.json({ ok: false, error: "Unknown tool: ".concat(tool) }, 400)];
                case 8: return [2 /*return*/, c.json({ ok: true, result: result })];
                case 9:
                    err_4 = _d.sent();
                    return [2 /*return*/, c.json({ ok: false, error: err_4.message }, 500)];
                case 10: return [2 /*return*/];
            }
        });
    }); });
    // File system tools
    app.post('/files/list', function (c) { return __awaiter(_this, void 0, void 0, function () {
        var body, result, err_5;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, c.req.json()];
                case 1:
                    body = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, (0, gateway_files_js_1.listFiles)(body.directory, body.pattern)];
                case 3:
                    result = _a.sent();
                    return [2 /*return*/, c.json({ ok: result.success, result: result })];
                case 4:
                    err_5 = _a.sent();
                    return [2 /*return*/, c.json({ ok: false, error: err_5.message }, 500)];
                case 5: return [2 /*return*/];
            }
        });
    }); });
    app.post('/files/read', function (c) { return __awaiter(_this, void 0, void 0, function () {
        var body, result, err_6;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, c.req.json()];
                case 1:
                    body = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    if (!body.path) {
                        return [2 /*return*/, c.json({ ok: false, error: 'Missing required field: path' }, 400)];
                    }
                    return [4 /*yield*/, (0, gateway_files_js_1.readFile)(body.path)];
                case 3:
                    result = _a.sent();
                    return [2 /*return*/, c.json({ ok: result.success, content: result.content, error: result.error })];
                case 4:
                    err_6 = _a.sent();
                    return [2 /*return*/, c.json({ ok: false, error: err_6.message }, 500)];
                case 5: return [2 /*return*/];
            }
        });
    }); });
    app.post('/files/info', function (c) { return __awaiter(_this, void 0, void 0, function () {
        var body, result, err_7;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, c.req.json()];
                case 1:
                    body = _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    if (!body.path) {
                        return [2 /*return*/, c.json({ ok: false, error: 'Missing required field: path' }, 400)];
                    }
                    return [4 /*yield*/, (0, gateway_files_js_1.fileInfo)(body.path)];
                case 3:
                    result = _a.sent();
                    return [2 /*return*/, c.json({ ok: result.success, info: result.info, error: result.error })];
                case 4:
                    err_7 = _a.sent();
                    return [2 /*return*/, c.json({ ok: false, error: err_7.message }, 500)];
                case 5: return [2 /*return*/];
            }
        });
    }); });
    return app;
}
if (typeof require === 'undefined' || typeof require.main === 'undefined' || require.main === module) {
    // Run as standalone script: `tsx gateway-v1.ts` or `node gateway-v1.js`
    var port = parseInt(process.env.PORT || '18789', 10);
    var host = process.env.HOST || '127.0.0.1';
    startGatewayServer(port, host).catch(function (err) {
        console.error('Failed to start gateway:', err);
        process.exit(1);
    });
}
function startGatewayServer() {
    return __awaiter(this, arguments, void 0, function (port, host) {
        var app, server, cleanup;
        if (port === void 0) { port = 18789; }
        if (host === void 0) { host = '127.0.0.1'; }
        return __generator(this, function (_a) {
            app = createGatewayApp();
            console.log("\n\u001B[36mROBIN Gateway v1\u001B[0m");
            console.log("  Listening on: http://".concat(host, ":").concat(port));
            console.log("  Config path: ".concat(GATEWAY_CONFIG_PATH, "\n"));
            server = (0, node_server_1.serve)({
                fetch: app.fetch,
                port: port,
                hostname: host,
            }, function (info) {
                console.log("\u001B[32m\u2713 Gateway ready\u001B[0m");
                console.log("  HTTP: http://".concat(host, ":").concat(info.port, "\n"));
            });
            cleanup = function () {
                console.log('\n[Gateway] Shutting down...');
                server.close(function () { return process.exit(0); });
            };
            process.on('SIGTERM', cleanup);
            process.on('SIGINT', cleanup);
            return [2 /*return*/, new Promise(function (resolve, reject) {
                    server.on('error', function (err) { return reject(err); });
                })];
        });
    });
}
