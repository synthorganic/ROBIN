"use strict";
/**
 * File system operations for ROBIN Gateway.
 *
 * Provides safe file system access through controlled endpoints.
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
exports.listFiles = listFiles;
exports.readFile = readFile;
exports.fileInfo = fileInfo;
var fs = require("node:fs");
var path = require("node:path");
/**
 * Get a safe absolute path from a potentially relative or unsafe path.
 */
function sanitizePath(userPath, baseDir) {
    // Resolve the user path
    var resolved = path.resolve(baseDir, userPath);
    // Ensure it's within the allowed base directory (prevents path traversal)
    var normalizedBase = path.resolve(baseDir);
    if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
        throw new Error('Access denied: path outside allowed directory');
    }
    return resolved;
}
/**
 * List files in a directory with optional pattern filtering.
 */
function listFiles(directory, pattern) {
    return __awaiter(this, void 0, void 0, function () {
        var baseDir, targetDir, Dirent, files, _i, _a, dirent, fullPath, stats, filteredFiles, regex_1, err_1;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 5, , 6]);
                    baseDir = process.cwd();
                    targetDir = directory ? sanitizePath(directory, baseDir) : baseDir;
                    if (!fs.existsSync(targetDir)) {
                        return [2 /*return*/, { success: false, files: [], error: "Directory not found: ".concat(targetDir) }];
                    }
                    Dirent = fs.promises.readdir(targetDir, { withFileTypes: true });
                    files = [];
                    _i = 0;
                    return [4 /*yield*/, Dirent];
                case 1:
                    _a = _b.sent();
                    _b.label = 2;
                case 2:
                    if (!(_i < _a.length)) return [3 /*break*/, 4];
                    dirent = _a[_i];
                    fullPath = path.join(targetDir, dirent.name);
                    stats = fs.statSync(fullPath);
                    files.push({
                        name: dirent.name,
                        path: fullPath,
                        size: stats.size,
                        isFile: dirent.isFile(),
                        isDirectory: dirent.isDirectory(),
                        mtime: new Date(stats.mtime).toISOString(),
                    });
                    _b.label = 3;
                case 3:
                    _i++;
                    return [3 /*break*/, 2];
                case 4:
                    filteredFiles = files;
                    if (pattern) {
                        regex_1 = new RegExp(pattern);
                        filteredFiles = files.filter(function (f) { return regex_1.test(f.name); });
                    }
                    return [2 /*return*/, { success: true, files: filteredFiles }];
                case 5:
                    err_1 = _b.sent();
                    return [2 /*return*/, { success: false, files: [], error: err_1.message }];
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Read file content.
 */
function readFile(userPath) {
    return __awaiter(this, void 0, void 0, function () {
        var baseDir, fullPath, stats, buffer, content;
        return __generator(this, function (_a) {
            try {
                baseDir = process.cwd();
                fullPath = sanitizePath(userPath, baseDir);
                if (!fs.existsSync(fullPath)) {
                    return [2 /*return*/, { success: false, content: null, error: "File not found: ".concat(fullPath) }];
                }
                stats = fs.statSync(fullPath);
                if (stats.size > 10 * 1024 * 1024) {
                    return [2 /*return*/, { success: false, content: null, error: 'File too large (>10MB)' }];
                }
                buffer = fs.readFileSync(fullPath);
                content = void 0;
                try {
                    content = buffer.toString('utf-8');
                }
                catch (_b) {
                    return [2 /*return*/, { success: false, content: null, error: 'File appears to be binary' }];
                }
                return [2 /*return*/, { success: true, content: content }];
            }
            catch (err) {
                return [2 /*return*/, { success: false, content: null, error: err.message }];
            }
            return [2 /*return*/];
        });
    });
}
/**
 * Get file info without reading content.
 */
function fileInfo(userPath) {
    return __awaiter(this, void 0, void 0, function () {
        var baseDir, fullPath, stats;
        return __generator(this, function (_a) {
            try {
                baseDir = process.cwd();
                fullPath = sanitizePath(userPath, baseDir);
                if (!fs.existsSync(fullPath)) {
                    return [2 /*return*/, { success: false, error: "File not found: ".concat(fullPath) }];
                }
                stats = fs.statSync(fullPath);
                return [2 /*return*/, {
                        success: true,
                        info: {
                            name: path.basename(fullPath),
                            path: fullPath,
                            size: stats.size,
                            isFile: stats.isFile(),
                            isDirectory: stats.isDirectory(),
                            mtime: new Date(stats.mtime).toISOString(),
                        },
                    }];
            }
            catch (err) {
                return [2 /*return*/, { success: false, error: err.message }];
            }
            return [2 /*return*/];
        });
    });
}
