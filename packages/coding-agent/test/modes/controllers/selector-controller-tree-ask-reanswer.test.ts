/**
 * `/tree`'s interactive selector must let the active leaf's `ask` toolResult
 * fall through to the re-answer flow instead of treating it as a plain
 * "already at this point" no-op (Codex review on #5895, posted as a
 * body-only review comment that predates this fix: the `agent-session.ts`
 * `allowAskReopen` gate is unreachable unless the interactive `/tree`
 * handler itself stops short-circuiting on `entryId === realLeafId` for
 * ask toolResults).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function askResultEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "ask",
			content: [{ type: "text", text: "User selected: staging" }],
			details: {
				question: "Which deploy target?",
				options: ["staging", "production"],
				multi: false,
				selectedOptions: ["staging"],
			},
			isError: false,
			timestamp: Date.now(),
		},
	} as unknown as SessionEntry;
}

function plainUserEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
	} as unknown as SessionEntry;
}

interface EditorSlot {
	children: unknown[];
	clear: () => void;
	addChild: Mock<(child: unknown) => void>;
}

function createEditorSlot(): EditorSlot {
	const children: unknown[] = [];
	return {
		children,
		clear: vi.fn(() => {
			children.length = 0;
		}),
		addChild: vi.fn((child: unknown) => {
			children.push(child);
		}),
	};
}

interface ReanswerOverrides {
	settings?: Settings;
	getToolUIContext?: () => ExtensionUIContext | undefined;
}

function createCtx(
	leafEntry: SessionEntry,
	navigateTreeResult: unknown = { cancelled: false },
	overrides: ReanswerOverrides = {},
) {
	const tree: SessionTreeNode[] = [{ entry: leafEntry, children: [] }];
	const navigateTree = vi.fn(async () => navigateTreeResult as never);
	const showStatus = vi.fn();
	const showError = vi.fn();
	const editorContainer = createEditorSlot();
	// Records the order of UI-rebuild vs agent-resume so a test can prove the
	// re-answer continuation is deferred until after the transcript rebuild
	// (issue #6483).
	const order: string[] = [];
	const renderInitialMessages = vi.fn(() => {
		order.push("render");
	});
	const reloadTodos = vi.fn(async () => {
		order.push("reloadTodos");
	});
	const resumeAfterAskReanswer = vi.fn(() => {
		order.push("resume");
	});
	const ctx = {
		editor: { id: "editor", getText: () => "", setText: vi.fn() },
		editorContainer,
		sessionManager: {
			getTree: () => tree,
			getLeafId: () => leafEntry.id,
			getEntry: (id: string) => (id === leafEntry.id ? leafEntry : undefined),
			getCwd: () => "/tmp",
			getSessionFile: () => undefined,
		},
		session: {
			navigateTree,
			resumeAfterAskReanswer,
			getPlanModeState: () => undefined,
			buildAskReanswerContext: (ui: ExtensionUIContext) => ({ ui, hasUI: true, abort: vi.fn() }),
		},
		ui: {
			setFocus: vi.fn(),
			getFocused: () => undefined,
			requestRender: vi.fn(),
			terminal: { rows: 24 },
		},
		renderInitialMessages,
		reloadTodos,
		showStatus,
		showError,
		// No UI context available in this unit test — forces `#reanswerAsk` to
		// bail out immediately via its own "Ask tool UI is not ready" path
		// instead of requiring a full AskTool/dialog harness. The point of
		// this test is proving `navigateTree` gets reached with
		// `allowAskReopen: true` at all, not exercising the re-answer dialog
		// itself (already covered at the session level).
		getToolUIContext: () => undefined,
		...overrides,
	} as unknown as InteractiveModeContext;
	return { ctx, editorContainer, navigateTree, showStatus, showError, resumeAfterAskReanswer, order };
}

/** Grabs the `TreeSelectorComponent` mounted by the most recent `showTreeSelector()` call and fires its onSelect as if the user pressed Enter on `entryId`. */
async function pickEntry(editorContainer: EditorSlot, entryId: string): Promise<void> {
	const mounted = editorContainer.addChild.mock.calls.at(-1)?.[0] as {
		getTreeList: () => { onSelect?: (id: string, options: { summarize: boolean }) => unknown };
	};
	await mounted.getTreeList().onSelect?.(entryId, { summarize: false });
}

describe("SelectorController.showTreeSelector re-answering the active ask leaf", () => {
	it("keeps the plain no-op for a non-ask current leaf", async () => {
		const entry = plainUserEntry("leaf-user");
		const { ctx, editorContainer, navigateTree, showStatus } = createCtx(entry);
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		await pickEntry(editorContainer, "leaf-user");

		expect(showStatus).toHaveBeenCalledWith("Already at this point");
		expect(navigateTree).not.toHaveBeenCalled();
	});

	it("falls through to navigateTree with allowAskReopen when the active leaf is an ask toolResult", async () => {
		const entry = askResultEntry("leaf-ask");
		const reopenQuestions = [
			{
				id: "deploy_target",
				question: "Which deploy target?",
				options: [{ label: "staging" }, { label: "production" }],
			},
		];
		const { ctx, editorContainer, navigateTree, showStatus, showError } = createCtx(entry, {
			reopenAsk: { questions: reopenQuestions },
		});
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		await pickEntry(editorContainer, "leaf-ask");

		// The no-op short-circuit must not fire for the current-leaf ask result:
		// navigateTree gets called with `allowAskReopen: true`, and the result's
		// `reopenAsk` is genuinely handled (routed into `#reanswerAsk`, which
		// reports "Ask tool UI is not ready" via `showError` in this harness,
		// then "Re-answer cancelled" — never the old plain no-op message).
		expect(showStatus).not.toHaveBeenCalledWith("Already at this point");
		expect(navigateTree).toHaveBeenCalledWith("leaf-ask", expect.objectContaining({ allowAskReopen: true }));
		expect(showError).toHaveBeenCalledWith("Ask tool UI is not ready");
		expect(showStatus).toHaveBeenCalledWith("Re-answer cancelled");
	});

	it("resumes the agent only after rebuilding the transcript when navigateTree reports a committed re-answer", async () => {
		const entry = plainUserEntry("leaf-user");
		const { ctx, editorContainer, showStatus, resumeAfterAskReanswer, order } = createCtx(entry, {
			cancelled: false,
			askReanswerCommitted: true,
		});
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		// A non-current target skips the no-op short-circuit and lands straight on
		// the success path (navigateTree here returns a committed re-answer).
		await pickEntry(editorContainer, "some-other-entry");

		expect(showStatus).toHaveBeenCalledWith("Navigated to selected point");
		expect(resumeAfterAskReanswer).toHaveBeenCalledTimes(1);
		// The resume must be deferred until after the transcript rebuild so the
		// resumed turn never renders against the stale pre-rebuild UI (issue #6483).
		expect(order.indexOf("render")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("resume")).toBeGreaterThan(order.indexOf("render"));
	});

	it("does not resume the agent for a plain navigation without a committed re-answer", async () => {
		const entry = plainUserEntry("leaf-user");
		const { ctx, editorContainer, resumeAfterAskReanswer } = createCtx(entry, { cancelled: false });
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		await pickEntry(editorContainer, "some-other-entry");

		expect(resumeAfterAskReanswer).not.toHaveBeenCalled();
	});

	it("re-opens the ask dialog without Chat about this even when ask.chatOption is on", async () => {
		// A chat redirect has no turn to continue in a standalone re-answer, so
		// the host dialog must not offer a choice that can only error.
		const settings = Settings.isolated({ "ask.chatOption": true, "ask.notify": "off" });
		// The host focuses the dialog once it is mounted.
		const mounted = Promise.withResolvers<AskDialogComponent>();
		const host = new ExtensionUiController({
			settings,
			editor: new CustomEditor(getEditorTheme()),
			editorContainer: new Container(),
			ui: {
				requestRender: vi.fn(),
				setFocus: (component: unknown) => {
					if (component instanceof AskDialogComponent) mounted.resolve(component);
				},
				terminal: { rows: 40, columns: 120 },
			},
		} as unknown as InteractiveModeContext);
		const uiContext = {
			askDialog: (questions, dialogOptions) => host.showAskDialog(questions, dialogOptions),
		} as Partial<ExtensionUIContext> as ExtensionUIContext;
		const entry = askResultEntry("leaf-ask");
		const reopenQuestions = [
			{
				id: "deploy_target",
				question: "Which deploy target?",
				options: [{ label: "staging" }, { label: "production" }],
			},
		];
		const { ctx, editorContainer, showStatus } = createCtx(
			entry,
			{ reopenAsk: { questions: reopenQuestions } },
			{ settings, getToolUIContext: () => uiContext },
		);
		const controller = new SelectorController(ctx);

		controller.showTreeSelector();
		const picked = pickEntry(editorContainer, "leaf-ask");
		const ask = await mounted.promise;
		const rendered = ask.render(120).join("\n");
		expect(rendered).toContain("Which deploy target?");
		expect(rendered).not.toContain("Chat about this");

		ask.handleInput("\x1b");
		await picked;
		expect(showStatus).toHaveBeenCalledWith("Re-answer cancelled");
	});
});
