import { cancel } from "@clack/prompts";
import { validateSessionsResolveResult as validateHandoffSessionResolveResult } from "../../packages/gateway-protocol/src/session-result-validators.js";
import { selectStyled } from "../../packages/terminal-core/src/prompt-select-styled.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { decodeResumeHandoff } from "../shared/resume-handoff.js";
import {
  buildSessionChoices,
  loadRecentSessions,
  resolveResumeSession,
  type SessionPickerChoice,
} from "../tui/tui-session-picker.js";
import type { ResumeCliOptions } from "./resume-cli.js";
import { registerSignalExitGate } from "./signal-exit-barrier.js";
import { isTerminalInteractive } from "./terminal-interactivity.js";

const RESUME_INTERACTIVE_TERMINAL_GUIDANCE =
  "Attaching to a session requires an interactive terminal. Re-run `openclaw resume [query]` from an interactive terminal.";
const RESUME_HANDOFF_UNRESOLVED =
  "Could not resolve the session handoff. Copy a fresh command from the Control UI.";

async function formatResumeConnectionError(error: unknown): Promise<Error> {
  const [{ formatTuiErrorMessage }, { resolveGatewayDisconnectState }] = await Promise.all([
    import("../tui/tui-formatters.js"),
    import("../tui/tui.js"),
  ]);
  const details =
    error && typeof error === "object" && "details" in error ? error.details : undefined;
  const state = resolveGatewayDisconnectState({
    reason: formatTuiErrorMessage(error),
    details,
  });
  return new Error(
    [
      state.connectionStatus,
      state.remediation ??
        "Check that the Gateway is running and your --url/--token/--password are correct.",
    ].join("\n"),
    { cause: error },
  );
}

type ResumePreflightClient = { stop: () => Promise<void> };
/** Cancels the private preflight client; the root CLI still owns the signal exit code. */
type ResumePreflight = {
  signal: AbortSignal;
  track: (client: ResumePreflightClient) => void;
  release: () => Promise<void>;
};

class ResumePreflightInterruptedError extends Error {
  constructor() {
    super("Resume preflight was interrupted.");
  }
}

function beginResumePreflight(): ResumePreflight {
  const controller = new AbortController();
  const finished = createDeferredCore();
  // A failed outcome matters only while a signal exit drains this gate.
  void finished.promise.catch(() => undefined);
  let client: ResumePreflightClient | undefined;
  const unregister = registerSignalExitGate(finished.promise, () => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort();
    // Join the transport before the root CLI releases the interruption exit code.
    void Promise.resolve(client?.stop())
      .catch(() => undefined)
      .then(() => finished.resolve());
  });
  return {
    signal: controller.signal,
    track(next) {
      client = next;
    },
    async release() {
      unregister();
      client = undefined;
      finished.resolve();
    },
  };
}

async function connectResumeGateway(
  opts: ResumeCliOptions,
  handoffTarget: boolean,
  preflight: ResumePreflight,
) {
  const { GatewayChatClient } = await import("../tui/gateway-chat.js");
  const client = await GatewayChatClient.connect({
    ...opts,
    ...(handoffTarget
      ? { allowConfiguredAuthForExactTarget: true, suppressEnvAuthFallback: true }
      : {}),
  });
  preflight.track(client);
  if (preflight.signal.aborted) {
    await client.stop();
    throw new ResumePreflightInterruptedError();
  }
  try {
    await new Promise<void>((resolve, reject) => {
      client.onConnected = resolve;
      client.onConnectError = reject;
      client.onDisconnected = (reason) => reject(new Error(reason || "Gateway connection closed"));
      client.start();
    });
    return client;
  } catch (error) {
    await client.stop();
    if (preflight.signal.aborted) {
      throw new ResumePreflightInterruptedError();
    }
    throw await formatResumeConnectionError(error);
  }
}

function formatResumeCandidate(candidate: SessionPickerChoice): string {
  const label = sanitizeTerminalText(candidate.label);
  const key = sanitizeTerminalText(candidate.value);
  return label === key ? key : `${label} [${key}]`;
}

export async function runResumeCommand(query: string | undefined, opts: ResumeCliOptions) {
  const { handoff: encodedHandoff, ...connectionOptions } = opts;
  if (encodedHandoff !== undefined && (query !== undefined || opts.url !== undefined)) {
    throw new Error("--handoff cannot be combined with a positional query or --url.");
  }
  const handoff = encodedHandoff === undefined ? undefined : decodeResumeHandoff(encodedHandoff);
  if (!isTerminalInteractive()) {
    throw new Error(RESUME_INTERACTIVE_TERMINAL_GUIDANCE);
  }
  const resolvedQuery = query?.trim();
  const parsedQuery = parseAgentSessionKey(resolvedQuery);
  const explicitGlobalSession = parsedQuery?.rest === "global" ? parsedQuery : undefined;
  let connection: Awaited<ReturnType<typeof connectResumeGateway>>["connection"] | undefined;
  let sessionKey: string | null = null;
  let sessions: Awaited<ReturnType<typeof loadRecentSessions>> = [];
  // The preflight client never joins the TUI's cancellation owner: release it
  // before runTui starts so interruption has exactly one owner at a time.
  const preflight = beginResumePreflight();
  try {
    if (handoff) {
      const parsed = parseAgentSessionKey(handoff.sessionKey)!;
      const client = await connectResumeGateway(
        { ...connectionOptions, url: handoff.gatewayUrl },
        true,
        preflight,
      );
      try {
        let result: unknown;
        try {
          result = await client.resolveSession({
            key: handoff.sessionKey,
            agentId: parsed.agentId,
            includeGlobal: true,
            allowMissing: true,
          });
        } catch {
          throw new Error(RESUME_HANDOFF_UNRESOLVED);
        }
        if (!validateHandoffSessionResolveResult(result) || !result.ok) {
          throw new Error(RESUME_HANDOFF_UNRESOLVED);
        }
        const canonicalKeyOwner = parseAgentSessionKey(result.key)?.agentId;
        if (result.agentId !== parsed.agentId || canonicalKeyOwner !== result.agentId) {
          throw new Error(RESUME_HANDOFF_UNRESOLVED);
        }
        connection = client.connection;
        sessionKey = result.key;
      } finally {
        await client.stop();
      }
    } else {
      const client = await connectResumeGateway(connectionOptions, false, preflight);
      try {
        connection = client.connection;
        sessions = await loadRecentSessions(
          client,
          explicitGlobalSession
            ? { agentId: explicitGlobalSession.agentId, includeGlobal: true }
            : undefined,
        );
      } catch (error) {
        if (preflight.signal.aborted) {
          throw error;
        }
        throw await formatResumeConnectionError(error);
      } finally {
        await client.stop();
      }
    }
  } catch (error) {
    // The root CLI signal owner already claimed 130/143; interruption must not
    // surface a second failure or launch the TUI.
    if (preflight.signal.aborted) {
      return;
    }
    throw error;
  } finally {
    await preflight.release();
  }
  // A drain can interrupt after a read settled; never continue into the picker or TUI.
  if (preflight.signal.aborted) {
    return;
  }
  if (explicitGlobalSession) {
    sessionKey = `agent:${explicitGlobalSession.agentId}:global`;
  } else if (!handoff && resolvedQuery) {
    const resolution = resolveResumeSession(sessions, resolvedQuery);
    if (resolution.kind !== "match") {
      if (resolution.kind === "ambiguous") {
        defaultRuntime.error(
          `Session query ${JSON.stringify(resolvedQuery)} is ambiguous. Candidates:`,
        );
        for (const candidate of resolution.candidates) {
          defaultRuntime.error(`  ${formatResumeCandidate(candidate)}`);
        }
        defaultRuntime.error("Use a longer name or the exact session key.");
      } else {
        defaultRuntime.error(`No recent session matched ${JSON.stringify(resolvedQuery)}.`);
        defaultRuntime.error(
          "Run `openclaw resume` to choose from recent sessions or `openclaw sessions` to inspect all sessions.",
        );
      }
      defaultRuntime.exit(1);
      return;
    }
    sessionKey = resolution.session.value;
  } else if (!handoff) {
    const choices = buildSessionChoices(sessions);
    if (choices.length === 0) {
      throw new Error(
        "No recent sessions found. Run `openclaw sessions` to inspect sessions or `openclaw tui` to start one.",
      );
    }
    const selected = await selectStyled({
      message: "Resume a session",
      options: choices.map((choice) => ({
        value: choice.value,
        label: formatResumeCandidate(choice),
        hint: choice.description ? sanitizeTerminalText(choice.description) : undefined,
      })),
    });
    if (typeof selected === "symbol") {
      cancel("Cancelled.");
      return;
    }
    sessionKey = selected;
  }
  if (!connection || !sessionKey) {
    return;
  }
  const { runTui } = await import("../tui/tui.js");
  await runTui({
    boundGateway: {
      url: handoff?.gatewayUrl ?? connection.url,
      ...(connection.token ? { token: connection.token } : {}),
      ...(connection.password ? { password: connection.password } : {}),
      ...(connection.tlsFingerprint ? { tlsFingerprint: connection.tlsFingerprint } : {}),
    },
    session: sessionKey,
  });
}
