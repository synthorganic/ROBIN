# Agent Interface Issues - Investigation Checklist

## Issue 1: OpenAI `/models` endpoint returning single model
**Status**: 🔍 Investigating

### Root Cause Hypothesis
Local LLM server (LM Studio) may only have one model loaded, or `/models` endpoint not properly exposing all available models.

### Investigation Steps
- [ ] Check what the local LLM server returns at `/v1/models` endpoint
  - Command: `curl http://127.0.0.1:1234/v1/models`
  - Verify response contains array of models or single model object
- [ ] Verify LOCAL_LLM_BASE_URL environment variable is set correctly
  - Check: `echo $LOCAL_LLM_BASE_URL` (Linux/Mac) or `echo %LOCAL_LLM_BASE_URL%` (Windows)
- [ ] Check LM Studio configuration for loaded models
  - Open LM Studio interface and verify multiple models are available
- [ ] Review code in `localLM/local.ts` line 349 where `/models` is polled
  - Expected format: `{ data: [...] }` or array directly
- [ ] Test with explicit model name using `/model` command
  - Command: `/model qwen3.5-122b-a10b-reap-20-i1`

### Resolution Criteria
- [ ] Endpoint returns multiple models OR single model is properly configured
- [ ] Agent can select and use the desired model

---

## Issue 2: Tool calling failure with ROBIN Gateway v1
**Status**: ✅ **FIXED** - Field translation implemented in gateway-v1.ts

### Findings from Investigation
- **FileReadTool** uses `file_path` parameter (line 229 in FileReadTool.ts)
- **BashTool** uses `command` parameter (line 228 in BashTool.tsx) ✓ Matches ROBIN
- **PowerShellTool** uses `command` parameter ✓ Matches ROBIN
- **ROBIN Gateway** expects:
  - `path` instead of `file_path`
  - `command` for bash/powershell (already matches)
  - Other tools: files_list, files_read, files_read_docx, files_info, memories_get

### Error Messages Received
```
Error 1: "Unknown tool: . For ROBIN Gateway v1 (local operations), use one of these tools: bash, powershell, files_list, files_read, files_read_docx, files_info, memories_get"

Error 2: "Error executing files_read_docx: Tool files_read_docx failed: HTTP 400 {\"ok\":false,\"error\":\"Missing required argument: path\"}"
```

### Root Cause Analysis (Updated)
The second error reveals that:
1. **Tool names ARE being recognized** - `files_read_docx` was identified as a valid tool
2. **The actual issue is missing/incorrect arguments** - The `path` argument is not being passed correctly
3. This suggests the gateway receives the tool call but the JSON structure of arguments may be malformed or under a different field name

### Investigation Steps
- [ ] Examine how tool arguments are serialized before sending to gateway
  - File: `services/api/local.ts` line 204 (`localToolToAPISchema`)
  - Check argument structure matches ROBIN Gateway expectations
- [ ] Verify the exact JSON payload being sent for a files_read_docx call
  - Need to see if `path` is sent as `{"path": "..."}` or nested differently
- [ ] Compare ROBIN Gateway's expected argument schema vs what Atlas Code sends
  - ROBIN expects: `{ tool: "files_read_docx", args: { path: "..." } }` ?
  - Or: `{ name: "files_read_docx", input: { file_path: "..." } }`?
- [ ] Check if Atlas Code uses `file_path` but ROBIN expects `path`
  - This would explain the "Missing required argument: path" error
- [ ] Review gateway integration code in bridge/server components
  - File: `hooks/useRemoteSession.ts`
  - Look for how tool inputs are formatted before transmission
- [ ] Check the tool schema definitions to see field naming conventions
  - BashTool uses `command` field
  - FileReadTool likely uses `file_path` field (not `path`)

### Resolution Options
1. **Option A**: Implement argument name translation layer
   - Map Atlas Code fields → ROBIN Gateway fields:
     - `file_path` → `path`
     - `command` → already matches for bash
     - Verify all tool argument mappings
   
2. **Option B**: Update ROBIN Gateway to accept Atlas Code field names
   - Configure gateway to recognize `file_path`, `command`, etc.
   
3. **Option C**: Add a JSON transformation layer in the bridge code
   - Transform outgoing tool calls to match ROBIN's expected format
   - Handle both argument naming conventions

### Resolution Criteria
- [ ] Tool calls include correctly-named arguments (e.g., `path` instead of `file_path`)
- [ ] Gateway successfully processes tool calls without "Missing required argument" errors
- [ ] Tool execution completes and returns results

---

## Additional Context

### Files in Scope
- `localLM/local.ts` - Model discovery and polling
- `services/api/local.ts` - Local LLM client, tool schema conversion
- `hooks/useRemoteSession.ts` - Remote session/tool handling
- QueryEngine.ts - Core query engine (may contain tool formatting logic)

### Environment
- Date: 2026-07-07
- Current model set: `qwen3.5-122b-a10b-reap-20-i1`
- Working directory: `C:\Users\benmc\synthorganic\Inertiai Ops\ROBIN`

### Notes from User Command
```
/model command output: Set model to qwen3.5-122b-a10b-reap-20-i1
``

---

## Next Actions (Priority Order)
✅ **FIXED** (Part 4): Explicit tool name warnings added to system prompt

### What Was Changed

#### Part 1: Gateway v1 (`server/lib/gateway-v1.ts`)
- Updated tools to accept both `path` and `file_path` field names

#### Part 2 & 3: System Prompt + Text-Based Tool Calling (`server/lib/ops-agent.ts`)
- Implemented text-based tool calling format with ````tool_call` blocks
- Added regex parser to extract tool calls from text format

#### Part 4: **NEW** - Explicit Tool Name Warnings (Lines 57-106)
**Problem**: Model was calling `Read` instead of `files_read`, and `Read` doesn't exist in ROBIN Gateway.

**Solution**: Added CRITICAL warnings with explicit "NOT" examples:
```
⚠️ CRITICAL: Use EXACTLY these tool names (case-sensitive, no abbreviations): ⚠️
- bash          (NOT "shell", "terminal", or "command")
- powershell    (NOT "ps", "pwsh", or "powershell.exe")
- files_list    (NOT "list", "dir", or "ls")
- files_read    (NOT "Read", "read_file", or "file_read")  ← Key fix!
- files_read_docx (NOT "Read", "docx", or "extract_docx")   ← Key fix!
...
```

Also added a "WRONG EXAMPLE" section showing exactly what NOT to do.

### Testing Steps
1. [ ] **Restart ROBIN server**: `npm run dev:server`
2. [ ] Test with "Read the DOCX file at [path]"
   - Should now call `files_read_docx` (NOT `Read`)
3. [ ] Test listing documents in document center
   - Should call `files_list` or appropriate tool
4. [ ] Verify no more "Unknown tool: Read" errors
