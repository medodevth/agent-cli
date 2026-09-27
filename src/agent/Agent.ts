import { EventEmitter } from 'events';
import {
  AgentState, ChatMessage, ContentBlock, ToolCall, ToolExecution, ToolResult,
  Config, AgentError, PermissionManager, ToolContext,
} from '../types/index.js';
import { AIProvider } from '../providers/AIProvider.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { ToolCallValidator } from './ToolCallValidator.js';
import { ErrorRecoverySystem } from './ErrorRecoverySystem.js';
import { ToolPerformanceMonitor } from './ToolPerformanceMonitor.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { ToolRouter } from './ToolRouter.js';
import { ToolQueue } from './ToolQueue.js';
import { ProjectMemoryTool } from '../tools/ProjectMemoryTool.js';
import { createSecurityPipeline, SecurityPipeline } from '../security/SecurityPipeline.js';
import { TaskPriorityEngine, TaskTier } from './TaskPriorityEngine.js';
import { CompletionRouter } from './CompletionRouter.js';
import { BrainstormEngine } from './BrainstormEngine.js';
import { PlanningSystem, FullPlan } from './PlanningSystem.js';
import { SpecialtyRouter, renderActiveSpecialties, SpecialtyContext } from './SpecialtyPrompts.js';
import { MemoryHub } from '../memory/MemoryHub.js';
import { LearningEngine, ReinforcementLearner } from '../memory/LearningEngine.js';
import { SearchCodeMemoryTool, ImpactOfTool } from '../tools/MemoryHubTools.js';
import { buildAgentSystemPrompt, buildBootInstructions } from './SystemPrompt.js';
import { ContextCompressor } from './ContextCompressor.js';
import { NoteSystem } from '../memory/NoteSystem.js';

export class Agent extends EventEmitter {
  private state: AgentState;
  private provider: AIProvider;
  private toolRegistry: ToolRegistry;
  private permissions: PermissionManager;
  private config: Config;
  private toolCache = new Map<string, { result: ToolResult; timestamp: number }>();
  private validator = new ToolCallValidator();
  private errorRecovery = new ErrorRecoverySystem();
  private performanceMonitor = new ToolPerformanceMonitor();
  private circuitBreaker = new CircuitBreaker();
  private activeTimers = new Set<NodeJS.Timeout>();
  private readonly toolRouter: ToolRouter;
  private readonly toolQueue: ToolQueue;
  /** Facts loaded from .agent/memory at boot and injected into the system prompt. */
  private memoryContext = '';
  /** True for the first model call of a run, which carries boot instructions. */
  private awaitingBoot = false;
  private readonly compressor: ContextCompressor;
  private readonly notes = new NoteSystem();
  /** Four-layer defense: L1 guard → L2 human → L3 sandbox → L4 output check. */
  readonly security: SecurityPipeline;
  /** Three-tier work queue: critical / normal / background. */
  readonly taskQueue: TaskPriorityEngine;
  /** Routes tiny code-completion chores to a fast model (when configured). */
  readonly completionRouter: CompletionRouter;
  /** Multi-perspective ideation engine. */
  readonly brainstorm: BrainstormEngine;
  /** Real-time specialty prompt router (burst modules in/out per iteration). */
  private readonly specialtyRouter = new SpecialtyRouter();
  private lastUserText = '';
  /** Three-store memory: rules + code vectors + knowledge graph. */
  readonly memory = new MemoryHub();
  /** Self-learning: supervised + unsupervised + reinforcement + in-context. */
  readonly learning = new LearningEngine();
  private runStartedAt = 0;

  private static readonly READ_ONLY_TOOLS = new Set(['list_files','read_file','search_code','git_status','git_diff','git_log','project_map']);

  constructor(provider: AIProvider, toolRegistry: ToolRegistry, permissions: PermissionManager, config: Config) {
    super();
    // Register memory-hub tools so the agent can query its own memory.
    if (!toolRegistry.has('search_code_memory')) {
      toolRegistry.register(new SearchCodeMemoryTool(this.memory));
      toolRegistry.register(new ImpactOfTool(this.memory));
    }
    this.provider = provider;
    this.toolRegistry = toolRegistry;
    this.permissions = permissions;
    this.config = {
      ...config, enableToolRetry: config.enableToolRetry ?? true, maxToolRetries: config.maxToolRetries ?? 3,
      enableToolCache: config.enableToolCache ?? true, toolTimeout: config.toolTimeout ?? 30000,
      validateToolInputs: config.validateToolInputs ?? true, autoRecovery: config.autoRecovery ?? true,
      strictToolCalling: config.strictToolCalling ?? true,
    };
    this.toolRouter = new ToolRouter(this.config.toolRouterMaxTools ?? 20);
    this.toolQueue = new ToolQueue(this.config.toolQueueConcurrency ?? 1);
    this.compressor = new ContextCompressor({ keepRecent: this.config.compressorKeepRecent });
    this.security = createSecurityPipeline({
      approver: this.config.securityApprover ?? null,
      approvalTimeoutMs: this.config.approvalTimeoutMs,
      autoApproveBelow: this.config.securityAutoApproveBelow,
      docker: {
        image: this.config.sandboxDockerImage,
        memoryMb: this.config.sandboxMemoryMb,
        profile: this.config.sandboxDockerProfile,
        user: this.config.sandboxDockerUser,
        tmpfsMb: this.config.sandboxTmpfsMb,
        requireIsolation: this.config.sandboxRequireIsolation,
      },
      local: {
        cpuSeconds: this.config.sandboxLocalCpuSeconds,
        maxMemoryKb: this.config.sandboxLocalMemoryKb,
        maxFileKb: this.config.sandboxLocalFileKb,
        maxProcesses: this.config.sandboxLocalMaxProcesses,
        demoteUser: this.config.sandboxLocalDemoteUser,
        isolateNetwork: this.config.sandboxLocalIsolateNetwork,
        allowOutsideWorkspace: this.config.sandboxLocalAllowOutsideWorkspace,
      },
    });
    this.taskQueue = new TaskPriorityEngine({ maxBackgroundPerRun: this.config.maxBackgroundTasksPerRun });
    this.completionRouter = new CompletionRouter({ completer: this.config.miniCompleter ?? null });
    this.brainstorm = new BrainstormEngine({ advisor: this.config.brainstormAdvisor ?? null });
    for (const tool of toolRegistry.list()) {
      if (tool instanceof ProjectMemoryTool) tool.noteSink = this.notes;
    }
    this.state = { status: 'idle', history: [], conversationMessages: [], iterationCount: 0, metadata: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } };
  }

  /** Queues a follow-on task into the three-tier engine (critical/normal/background). */
  queueTask(description: string, run: () => Promise<string>, tier?: TaskTier): string {
    const task = this.taskQueue.add(description, run, tier);
    this.emit('taskQueued', { id: task.id, tier: task.tier, description });
    return task.id;
  }

  /** Drains queued work after the main task, highest tier first. */
  private async drainTaskQueue(): Promise<string[]> {
    const results: string[] = [];
    while (this.taskQueue.hasWork()) {
      const task = this.taskQueue.next();
      if (!task) break;
      this.emit('taskStarted', { id: task.id, tier: task.tier, description: task.description });
      try {
        const result = await task.run();
        results.push(`[${task.tier}] ${task.description} → ${result.slice(0, 200)}`);
      } catch (error) {
        results.push(`[${task.tier}] ${task.description} → FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return results;
  }

  /** Runs a structured brainstorm round and returns the merged recommendation. */
  async ideate(topic: string) {
    return this.brainstorm.brainstorm(topic);
  }

  /** Validates and renders a three-tier plan coming from the model or user. */
  renderPlan(plan: FullPlan): string {
    const issues = PlanningSystem.validate(plan);
    if (issues.length) throw new Error(`Invalid plan: ${issues.join('; ')}`);
    return PlanningSystem.render(plan);
  }

  // Kill-switch — aborts the current run at the next loop
  // boundary and rejects all further tool executions.
  private killSwitch = false;
  private abortController: AbortController | null = null;

  /** Immediately stop the agent (idempotent). */
  kill(reason = 'kill switch engaged'): void {
    this.killSwitch = true;
    this.abortController?.abort(reason);
    this.setStatus('cancelled');
    this.security.audit.log({ time: new Date().toISOString(), layer: 'L1-guard', tool: 'agent', decision: 'KILL', detail: reason });
    this.emit('killed', { reason });
  }

  get killed(): boolean {
    return this.killSwitch;
  }

  /** Clear the kill switch (new session / explicit user action). */
  revive(): void {
    this.killSwitch = false;
  }

  async run(userMessage: string, attachments: ContentBlock[] = []): Promise<string> {
    if (this.killSwitch) throw new AgentError('Agent is killed — call revive() to start a new session', 'AGENT_KILLED');
    this.killSwitch = false;
    this.abortController = new AbortController();
    this.setStatus('thinking'); this.state.currentTask = userMessage; this.state.iterationCount = 0;
    this.cleanupOldCache(); this.trimConversationHistory();
    this.taskQueue.startRun(false);
    this.runStartedAt = Date.now();
    await this.loadMemoryContext();
    this.notes.startRun();
    this.lastUserText = userMessage;
    this.specialtyRouter.reset();
    // Stability: clear stale boot state from any aborted run.
    this.awaitingBoot = true;
    // Every run starts from a clean conversation — durable facts live in
    // state.history (audit), notes, and the rolling digest, never in a
    // leftover conversation array inherited from a previous failed run.
    this.state.conversationMessages = [];
    this.addMessage({
      role: 'user',
      content: attachments.length ? [{ type: 'text', text: buildBootInstructions(userMessage) }, ...attachments] : buildBootInstructions(userMessage),
      timestamp: new Date(),
    });
    let finalResponse = '';
    const providerRetries = Math.max(0, this.config.providerRetries ?? 3);
    let completed = false;
    try {        while (this.state.iterationCount < this.config.maxIterations) {
        this.state.iterationCount++;
        this.emit('iteration', this.state.iterationCount, this.config.maxIterations);

        // Kill-switch check at every loop boundary.
        if (this.killSwitch || this.abortController?.signal.aborted) {
          throw new AgentError('Run aborted by kill switch', 'AGENT_KILLED');
        }

        // Compression pipe: fold old turns into a rolling digest before the
        // context window fills, so long runs never degrade.
        const budget = Math.max(1000, (this.config.contextWindowTokens ?? 100000) * 0.6);
        if (this.compressor.shouldCompress(this.state.conversationMessages, budget)) {
          const { messages, stats } = this.compressor.compress(this.state.conversationMessages);
          this.state.conversationMessages = messages;
          this.emit('contextCompressed', stats);
        }

        // Real-time specialty prompts: match situational cards against the
        // user text + recent tool activity, inject the active set into the
        // system prompt, and emit entries/exits for the UI.
        const recentActivity = this.state.history.slice(-6)
          .map(e => `${e.tool} ${e.result?.error ?? e.result?.output ?? ''}`.slice(0, 160))
          .join('\n');
        const specialtyCtx: SpecialtyContext = { userText: this.lastUserText, recentActivity };
        const specialtyDiff = this.specialtyRouter.route(specialtyCtx);
        if (specialtyDiff.entered.length || specialtyDiff.exited.length) {
          this.emit('specialtyRouted', {
            entered: specialtyDiff.entered,
            exited: specialtyDiff.exited,
            active: specialtyDiff.active.map(m => ({ id: m.card.id, title: m.card.title, category: m.card.category })),
          });
        }
        const specialtySection = renderActiveSpecialties(specialtyDiff);

        const response = await this.chatWithRetry({
          messages: this.state.conversationMessages, temperature: this.config.temperature, maxTokens: 8192,
          thinkingLevel: this.config.thinkingLevel,
          systemPrompt: this.buildSystemPrompt() + specialtySection,
          tools: this.toolRouter.select(userMessage, this.toolRegistry.getSchemas()), toolChoice: 'auto',
        }, providerRetries);
        if (response.usage) {
          const previous = (this.state.metadata.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined) ?? {};
          this.state.metadata.usage = {
            inputTokens: (previous.inputTokens ?? 0) + response.usage.inputTokens,
            outputTokens: (previous.outputTokens ?? 0) + response.usage.outputTokens,
            totalTokens: (previous.totalTokens ?? 0) + response.usage.totalTokens,
          };
          this.emit('tokenUsage', response.usage);
        }
        if (response.content) finalResponse = response.content;
        if (response.toolCalls?.length) {
          this.setStatus('executing');
          this.awaitingBoot = false;
          this.addMessage({ role: 'assistant', content: response.content || '', toolCalls: response.toolCalls, timestamp: new Date() });
          const toolResults: ContentBlock[] = [];
          const results = await Promise.all(response.toolCalls.map(async (toolCall) => {
            this.emit('toolStart', { id: toolCall.id, name: toolCall.name, input: toolCall.input });
            const result = await this.toolQueue.enqueue({
              priority: Agent.READ_ONLY_TOOLS.has(toolCall.name) ? 10 : 0,
              run: () => this.executeToolWithRetry(toolCall),
            });
            return { toolCall, result };
          }));
          for (const { toolCall, result } of results) {
            const execution: ToolExecution = { tool: toolCall.name, input: toolCall.input, result, timestamp: new Date() };
            this.state.history.push(execution); this.performanceMonitor.record(execution); this.emit('toolEnd', execution);
            this.notes.observe(execution);
            if (!result.success) {
              this.notes.observeBug(toolCall.name, result.error ?? 'unknown error');
            } else if (toolCall.name === 'edit_file' || toolCall.name === 'write_file') {
              const target = String((toolCall.input as Record<string, unknown>)?.path ?? '?');
              const meta = (result.metadata ?? {}) as Record<string, unknown>;
              const detail = meta.addedLines !== undefined ? `+${meta.addedLines}/-${meta.removedLines} lines` : 'written';
              this.notes.observeChange(toolCall.name, target, detail);
            }
            toolResults.push({ type: 'tool_result', tool_use_id: toolCall.id, content: result.success ? result.output || 'Success' : `Error: ${result.error}`, is_error: !result.success });
          }
          this.addMessage({ role: 'user', content: toolResults, timestamp: new Date() });
          continue;
        }
        this.addMessage({ role: 'assistant', content: response.content, timestamp: new Date() });
        this.awaitingBoot = false;
        this.setStatus('completed'); completed = true; break;
      }
      if (!completed) throw new AgentError(`Maximum iterations (${this.config.maxIterations}) reached`, 'MAX_ITERATIONS');

      // Self-learning pass: mine patterns + reward strategies from this run.
      try {
        const retries = this.state.history.filter(h => h.result && h.result.success === false).length;
        const result = await this.learning.learnFromRun(this.config.workspaceRoot, {
          toolSequence: this.state.history.map(h => h.tool),
          success: true,
          durationMs: Date.now() - this.runStartedAt,
          retryCount: retries,
          usedStrategies: ReinforcementLearner.detectStrategies(this.state.history),
        });
        this.emit('learnedFromRun', { patterns: result.patterns.length, strategies: result.rewarded });
        await this.memory.rememberTurn(this.config.workspaceRoot, 'assistant', `completed: ${this.state.currentTask ?? ''}`.slice(0, 200));
      } catch { /* learning is best-effort */ }

      // Drain queued follow-on work (critical → normal → background).
      if (this.taskQueue.hasWork()) {
        const drained = await this.drainTaskQueue();
        if (drained.length) {
          finalResponse += '\n\nQUEUED WORK COMPLETED:\n' + drained.join('\n');
        }
      }

      await this.flushNotes();
      await this.security.audit.flush(this.config.workspaceRoot);
      return finalResponse;
    } catch (error) {
      this.setStatus('error_recovery');
      // Stability: persist observations even when the run dies — the bug log
      // and pending notes feed the next boot's memory snapshot.
      const message = error instanceof Error ? error.message : String(error);
      try { this.notes.observeBug('agent.run', message, 'unresolved'); } catch { /* best-effort */ }
      await this.flushNotes().catch(() => undefined);
      await this.security.audit.flush(this.config.workspaceRoot).catch(() => undefined);
      throw error;
    }
  }

  /**
   * One provider call with bounded exponential-backoff retries. A single
   * failed call (rate limit, network blip, 5xx) must not kill the run.
   */
  private async chatWithRetry(params: Parameters<AIProvider['chat']>[0], maxRetries: number): Promise<ReturnType<AIProvider['chat']>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.provider.chat(params);
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        const waitMs = Math.min(1000 * 2 ** attempt, 8000);
        this.emit('providerRetry', { attempt: attempt + 1, maxRetries, waitMs, error: error instanceof Error ? error.message : String(error) });
        await new Promise(resolve => { const t = setTimeout(resolve, waitMs); t.unref(); });
      }
    }
  }

  private async executeToolWithRetry(toolCall: ToolCall): Promise<ToolResult> {
    const startTime = Date.now(); let current = toolCall; let lastError: { error?: string; message?: string } | null = null;
    const maxRetries = this.config.enableToolRetry ? this.config.maxToolRetries! : 1;
    if (this.circuitBreaker.isOpen(toolCall.name)) return { success: false, error: `Tool '${toolCall.name}' is temporarily unavailable`, isError: true, retryable: false, executionTime: 0 };
    if (this.isCacheable(toolCall.name)) { const cached = this.toolCache.get(this.getCacheKey(toolCall)); if (cached && Date.now() - cached.timestamp < 60000) return { ...cached.result, cached: true }; }
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.executeToolWithTimeout(current); result.executionTime = Date.now() - startTime;
        if (result.success) {
          this.circuitBreaker.recordSuccess(current.name);
          if (this.isCacheable(current.name)) this.toolCache.set(this.getCacheKey(current), { result, timestamp: Date.now() });
          else this.toolCache.clear();
          return result;
        }
        lastError = result;
        if (this.config.autoRecovery && attempt < maxRetries - 1) {
          const recovery = this.errorRecovery.recover(result.error || 'Unknown error', current, this.state, attempt + 1);
          if (recovery.action === 'abort') break;
          if (recovery.action === 'modify_input' && recovery.modifiedToolCall) current = recovery.modifiedToolCall;
          if (recovery.action === 'use_alternative' && recovery.alternativeTool) current = { ...current, name: recovery.alternativeTool };
        }
        if (attempt < maxRetries - 1) await this.sleep(Math.min(1000 * 2 ** attempt, 5000));
      } catch (error) {
        lastError = { message: error instanceof Error ? error.message : String(error) };
        if (attempt < maxRetries - 1) await this.sleep(Math.min(1000 * 2 ** attempt, 5000));
      }
    }
    this.circuitBreaker.recordFailure(current.name);
    const errorMsg = lastError?.error || lastError?.message || 'Unknown error';
    return { success: false, error: `Tool execution failed after ${maxRetries} attempt${maxRetries > 1 ? 's' : ''}: ${errorMsg}`, isError: true, retryable: this.errorRecovery.isRecoverable(errorMsg), executionTime: Date.now() - startTime };
  }

  private async executeToolWithTimeout(toolCall: ToolCall): Promise<ToolResult> {
    const timeout = this.config.toolTimeout!; const controller = new AbortController(); let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`Tool execution timeout after ${timeout}ms`)); }, timeout); this.activeTimers.add(timer); });
    return Promise.race([this.executeTool(toolCall, controller.signal), timeoutPromise]).finally(() => { clearTimeout(timer!); this.activeTimers.delete(timer!); });
  }

  private async executeTool(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const tool = this.toolRegistry.get(toolCall.name);
    if (!tool) return { success: false, error: `Tool '${toolCall.name}' not found`, isError: true, retryable: false };
    if (this.config.validateToolInputs && tool.inputSchema) {
      const validation = ToolCallValidator.validate(toolCall, tool.inputSchema as never);
      if (!validation.valid) return { success: false, error: `Invalid input for tool '${toolCall.name}': ${validation.errors.join(', ')}`, isError: true, retryable: false };
      if (validation.sanitizedInput !== undefined) toolCall = { ...toolCall, input: validation.sanitizedInput };
    }
    if (this.config.strictToolCalling) { const safety = ToolCallValidator.checkSafety(toolCall); if (!safety.safe) return { success: false, error: `Safety check failed: ${safety.issues.join(', ')}`, isError: true, retryable: false }; }

    // ---- Security Pipeline (L1 → L2 → L3) -------------------------------
    // A killed agent executes nothing.
    if (this.killSwitch) {
      return { success: false, error: 'Agent killed — tool execution refused', isError: true, retryable: false };
    }

    const guard = this.security.guard.guard(toolCall);
    if (guard.action === 'reject') {
      // Bounce back to the AI: the reason instructs it to rethink.
      this.security.audit.log({ time: new Date().toISOString(), layer: 'L1-guard', tool: toolCall.name, decision: 'REJECT', detail: guard.matched.join('; ') });
      // Out-of-bounds attempts surface as an alert event.
      this.emit('securityAlert', { kind: 'guard-reject', tool: toolCall.name, matched: guard.matched });
      return { success: false, error: guard.reason, isError: true, retryable: false };
    }
    this.security.audit.log({ time: new Date().toISOString(), layer: 'L1-guard', tool: toolCall.name, decision: 'allow', detail: `risk=${guard.risk}` });

    const human = await this.security.humanGate.check(toolCall, guard.risk);
    this.security.audit.log({ time: new Date().toISOString(), layer: 'L2-human', tool: toolCall.name, decision: human.action === 'allow' ? 'allow' : 'DENY', detail: human.reason });
    if (human.action === 'deny') {
      return { success: false, error: human.reason, isError: true, retryable: false };
    }

    // L3: shell commands run inside an isolated container when Docker is
    // available. When it is not, sandboxRequireIsolation=true fails the call
    // closed (no silent local fallback); otherwise the command still runs
    // locally but wrapped by the LocalSandbox (ulimit caps, optional network
    // namespace, optional root demotion) + the path-escape check.
    let sandboxed = false;
    if (toolCall.name === 'shell' && this.config.sandboxDockerEnabled) {
      let dockerUsable = false;
      try {
        dockerUsable = await this.security.sandbox.isDockerAvailable();
      } catch {
        dockerUsable = false;
      }
      if (dockerUsable) {
        try {
          const command = String((toolCall.input as Record<string, unknown>)?.command ?? '');
          const r = await this.security.sandbox.runIsolated(command, this.config.workspaceRoot);
          sandboxed = true;
          this.security.audit.log({ time: new Date().toISOString(), layer: 'L3-sandbox', tool: 'shell', decision: `docker exit=${r.exitCode}`, detail: command.slice(0, 120) });
          const checked = this.security.outputChecker.check([r.stdout, r.stderr].filter(Boolean).join('\n'), 'shell');
          if (checked.redactions.length) this.security.audit.log({ time: new Date().toISOString(), layer: 'L4-output', tool: 'shell', decision: 'redacted', detail: checked.redactions.join(',') });
          return { success: r.exitCode === 0, output: checked.output || undefined, error: r.exitCode === 0 ? undefined : `Command failed with exit code ${r.exitCode}`, metadata: { command, exitCode: r.exitCode, sandboxed: 'docker' } };
        } catch (error) {
          // Sandbox failure must not silently bypass: report and stop.
          this.security.audit.log({ time: new Date().toISOString(), layer: 'L3-sandbox', tool: 'shell', decision: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
          return { success: false, error: `Sandboxed execution failed: ${error instanceof Error ? error.message : String(error)}`, isError: true, retryable: false };
        }
      }
      // Docker unavailable: fail-closed policy.
      if (this.config.sandboxRequireIsolation) {
        this.security.audit.log({ time: new Date().toISOString(), layer: 'L3-sandbox', tool: 'shell', decision: 'DENY', detail: 'docker unavailable and sandboxRequireIsolation=true (fail closed)' });
        return { success: false, error: 'Shell execution requires an isolated sandbox (Docker) but none is available on this machine. Enable Docker or set sandboxRequireIsolation=false to allow guarded local execution.', isError: true, retryable: false };
      }
    }
    if (toolCall.name === 'shell') {
      this.security.audit.log({ time: new Date().toISOString(), layer: 'L3-sandbox', tool: 'shell', decision: sandboxed ? 'docker' : 'local-guarded', detail: sandboxed ? '' : 'docker unavailable → local execution with LocalSandbox guards' });
    }

    try {
      const context: ToolContext = { workspaceRoot: this.config.workspaceRoot, permissions: this.permissions, currentState: this.state, signal };
      const result = await tool.execute(toolCall.input, context);
      // ---- L4: output check before the result reaches the model --------
      const rawOutput = result.output ?? result.error ?? '';
      if (rawOutput) {
        const checked = this.security.outputChecker.check(rawOutput, toolCall.name);
        if (checked.redactions.length) {
          this.security.audit.log({ time: new Date().toISOString(), layer: 'L4-output', tool: toolCall.name, decision: 'redacted', detail: checked.redactions.join(',') });
        }
        if (result.output !== undefined) result.output = checked.output;
        if (result.error !== undefined && result.success === false) result.error = checked.output;
      }
      return result;
    }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error), isError: true, retryable: true }; }
  }

  private isCacheable(toolName: string): boolean { return this.config.enableToolCache === true && Agent.READ_ONLY_TOOLS.has(toolName); }
  private getCacheKey(toolCall: ToolCall): string { return `${toolCall.name}:${JSON.stringify(toolCall.input)}`; }
  private sleep(ms: number): Promise<void> { return new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref(); }); }
  private cleanupOldCache(): void { if (this.toolCache.size > 1000) { const sorted = Array.from(this.toolCache.entries()).sort((a,b) => a[1].timestamp-b[1].timestamp); for (const [key] of sorted.slice(0,500)) this.toolCache.delete(key); } }
  private trimConversationHistory(): void { const max = 50; if (this.state.conversationMessages.length > max) this.state.conversationMessages = this.state.conversationMessages.slice(-max); }
  private buildSystemPrompt(): string {
    const tools = this.toolRegistry.getSchemas();
    return buildAgentSystemPrompt({
      workspaceRoot: this.config.workspaceRoot,
      permissionMode: this.config.permissionMode,
      iteration: this.state.iterationCount,
      maxIterations: this.config.maxIterations,
      tools,
      subagentsEnabled: this.toolRegistry.has('delegate_task'),
      memoryContext: this.memoryContext,
    });
  }

  /** Reads every memory layer (4 note kinds + global) for the boot snapshot. */
  private async loadMemoryContext(): Promise<void> {
    try {
      // Three-store memory hub: rules/guardrails + code vectors + graph.
      await this.memory.boot(this.config.workspaceRoot);
      await this.memory.indexWorkspace(this.config.workspaceRoot).catch(() => undefined);
      const hubContext = await this.memory.contextForPrompt(this.config.workspaceRoot);
      const learned = await this.learning.renderForPrompt(this.config.workspaceRoot, this.state.currentTask ?? '');
      const noteContext = await this.notes.readForBoot(this.config.workspaceRoot);
      this.memoryContext = [noteContext, hubContext, learned].filter(Boolean).join('\n\n').slice(0, 7000);
    } catch { this.memoryContext = ''; }
  }

  /** Writes pending notes and auto-facts at the end of a run. */
  private async flushNotes(): Promise<void> {
    try {
      this.notes.endRun();
      const written = await this.notes.flush(this.config.workspaceRoot);
      if (written.length) this.emit('notesWritten', written);
    } catch { /* best-effort */ }
  }
  private addMessage(message: ChatMessage): void { this.state.conversationMessages.push(message); this.emit('message', message); }
  private setStatus(status: AgentState['status']): void { this.state.status = status; this.emit('status', status); }
  updateConfig(partial: Partial<Config>): void { this.config = { ...this.config, ...partial }; this.provider.setModel?.(this.config.model); }
  getUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return this.state.metadata.usage as { inputTokens: number; outputTokens: number; totalTokens: number } || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  getState(): AgentState { return structuredClone(this.state); }
  getToolRegistry(): ToolRegistry { return this.toolRegistry; }
  getPerformanceMonitor(): ToolPerformanceMonitor { return this.performanceMonitor; }
  getErrorRecovery(): ErrorRecoverySystem { return this.errorRecovery; }
  exportPerformanceData(): string { return this.performanceMonitor.export(); }
  reset(): void { for (const timer of this.activeTimers) clearTimeout(timer); this.activeTimers.clear(); this.toolCache.clear(); this.state = { status: 'idle', history: [], conversationMessages: [], iterationCount: 0, metadata: {} }; this.memoryContext = ''; this.awaitingBoot = false; this.specialtyRouter.reset(); this.emit('status', 'idle'); }
}
