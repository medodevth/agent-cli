// Core type definitions for the agent system
/** Reasoning effort requested from providers that support extended thinking. */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string | ContentBlock[]; timestamp?: Date; toolCalls?: ToolCall[]; }
export interface ContentBlock { type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'file'; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string; is_error?: boolean; source?: { type: 'base64'; media_type: string; data: string }; fileName?: string; mimeType?: string; }
export interface ToolSchema { name: string; description: string; input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; [key: string]: unknown; }; }
export interface ChatRequest { messages: ChatMessage[]; temperature?: number; maxTokens?: number; systemPrompt?: string; tools?: ToolSchema[]; toolChoice?: 'auto' | 'any' | 'none' | { type: 'tool'; name: string }; thinkingLevel?: ThinkingLevel; }
export interface ChatResponse { content: string; toolCalls?: ToolCall[]; finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error'; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; rawResponse?: unknown; }
export interface ChatChunk { delta: string; toolCalls?: Partial<ToolCall>[]; }
export interface ToolCall { id: string; name: string; input: unknown; }
export interface ToolResult { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown>; isError?: boolean; retryable?: boolean; executionTime?: number; cached?: boolean; }
export interface ToolContext { workspaceRoot: string; permissions: PermissionManager; currentState: AgentState; signal?: AbortSignal; spawnSubagent?: (task: string, options?: { maxIterations?: number }) => Promise<string>; }
export interface Tool { name: string; description: string; inputSchema: JSONSchema; execute(input: unknown, context: ToolContext): Promise<ToolResult>; }
export interface JSONSchema { type: string; properties?: Record<string, unknown>; required?: string[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; items?: JSONSchema; [key: string]: unknown; }
export interface AgentState { status: AgentStatus; currentTask?: string; plan?: Plan; history: ToolExecution[]; conversationMessages: ChatMessage[]; iterationCount: number; metadata: Record<string, unknown>; }
export type AgentStatus = 'idle' | 'thinking' | 'planning' | 'executing' | 'waiting_approval' | 'verifying' | 'error_recovery' | 'completed' | 'cancelled';
export interface Plan { goal: string; steps: PlanStep[]; dependencies?: Record<string, string[]>; validationCriteria?: string[]; }
export interface PlanStep { id: string; description: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'; tool?: string; result?: ToolResult; }
export interface ToolExecution { tool: string; input: unknown; result: ToolResult; timestamp: Date; retryCount?: number; duration?: number; }
export interface PermissionManager { check(action: Action): PermissionResult; requestApproval(action: Action): Promise<boolean>; }
export interface Action { type: ActionType; description: string; target?: string; risk: RiskLevel; command?: string; }
export type ActionType = 'read_file' | 'write_file' | 'delete_file' | 'execute_command' | 'git_operation' | 'network_request';
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';
export type PermissionResult = { allowed: true } | { allowed: false; reason: string };
export type PermissionMode = 'safe' | 'normal' | 'auto' | 'dangerous';
export interface Config { provider: string; model: string; apiKey?: string; baseUrl?: string; permissionMode: PermissionMode; maxIterations: number; temperature: number; workspaceRoot: string; sessionDir?: string; debug: boolean; enableToolRetry?: boolean; maxToolRetries?: number; enableToolCache?: boolean;  toolTimeout?: number;
  /** Reasoning effort: 'off' sends no thinking parameters, the others map to a token budget. */
  thinkingLevel?: ThinkingLevel;
  /** Approximate model context window (tokens) used to trigger conversation compression (default 100000). */
  contextWindowTokens?: number;
  /** Recent messages kept verbatim by the context compressor (default 12). */
  compressorKeepRecent?: number;
  /** Bounded retries for a failed model call (rate limit / network blip / 5xx). Default 3. */
  providerRetries?: number;
  /** Require human approval before applying sandboxed writes to the real workspace (default true). */
  /** Async approval callback for the security pipeline's human gate (high-risk actions). */
  securityApprover?: import('../security/SecurityPipeline.js').HumanApprover | null;
  /** Risk level at/under which no human approval is required (default: low). */
  securityAutoApproveBelow?: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  /** Human approval timeout in ms (default 120000). */
  approvalTimeoutMs?: number;
  /** Execute shell commands inside a Docker sandbox when available (default true). */
  sandboxDockerEnabled?: boolean;
  /** Docker image for the execution sandbox (default node:20-alpine). */
  sandboxDockerImage?: string;
  /** Docker sandbox memory limit in MB (default 512). */
  sandboxMemoryMb?: number;
  /** Docker sandbox OS/toolchain profile (default node = Node 20 on Alpine). */
  sandboxDockerProfile?: 'alpine' | 'node' | 'python' | 'ubuntu';
  /** Non-root user inside the Docker sandbox (default "nobody"). Empty string disables. */
  sandboxDockerUser?: string;
  /** Disk quota (MB) for the sandbox /tmp tmpfs + fsize ulimit (default 256). */
  sandboxTmpfsMb?: number;
  /** Fail closed when Docker is unavailable instead of falling back to local execution (default false). */
  sandboxRequireIsolation?: boolean;
  /** Local-sandbox CPU seconds per command via ulimit -t (default 30). */
  sandboxLocalCpuSeconds?: number;
  /** Local-sandbox address-space cap in KB via ulimit -v (default 1 GB). */
  sandboxLocalMemoryKb?: number;
  /** Local-sandbox per-file size cap in KB via ulimit -f (default 256 MB). */
  sandboxLocalFileKb?: number;
  /** Local-sandbox process cap via ulimit -u (default 128). */
  sandboxLocalMaxProcesses?: number;
  /** Local sandbox: demote root via setpriv when possible (default true). */
  sandboxLocalDemoteUser?: boolean;
  /** Local sandbox: isolate network namespace via unshare -n (default auto = on when available). */
  sandboxLocalIsolateNetwork?: boolean | 'auto';
  /** Local sandbox: allow commands referencing paths outside the workspace (default false). */
  sandboxLocalAllowOutsideWorkspace?: boolean;
  /** Max background-tier tasks processed per run (default 3). */
  maxBackgroundTasksPerRun?: number;
  /** Fast-model callback for tiny completion chores (optional). */
  miniCompleter?: import('../agent/CompletionRouter.js').MiniCompleter | null;
  /** Advisor callback for brainstorm rounds (optional). */
  brainstormAdvisor?: import('../agent/BrainstormEngine.js').Advisor | null; validateToolInputs?: boolean; autoRecovery?: boolean; strictToolCalling?: boolean; toolRouterMaxTools?: number; toolQueueConcurrency?: number; serverApiKey?: string; enableSubagents?: boolean; subagentMaxIterations?: number; }
export interface Session { id: string; timestamp: Date; workspace: string; messages: ChatMessage[]; toolCalls: ToolExecution[]; plan?: Plan; state: Record<string, unknown>; }
export class AgentError extends Error { constructor(message: string, public code: string, public details?: unknown) { super(message); this.name = 'AgentError'; } }
export class ToolError extends AgentError { constructor(message: string, details?: unknown) { super(message, 'TOOL_ERROR', details); this.name = 'ToolError'; } }
export class ProviderError extends AgentError { constructor(message: string, details?: unknown) { super(message, 'PROVIDER_ERROR', details); this.name = 'ProviderError'; } }
export class PermissionError extends AgentError { constructor(message: string, details?: unknown) { super(message, 'PERMISSION_ERROR', details); this.name = 'PermissionError'; } }
export class WorkspaceError extends AgentError { constructor(message: string, details?: unknown) { super(message, 'WORKSPACE_ERROR', details); this.name = 'WorkspaceError'; } }
export class ValidationError extends AgentError { constructor(message: string, details?: unknown) { super(message, 'VALIDATION_ERROR', details); this.name = 'ValidationError'; } }
