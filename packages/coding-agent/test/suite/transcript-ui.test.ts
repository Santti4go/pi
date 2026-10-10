import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI, TranscriptViewport } from "../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, createTestUiContext } from "./harness.ts";

async function flush(terminal: VirtualTerminal): Promise<void> {
	await terminal.waitForRender();
	await terminal.waitForRender();
}

describe("public fullscreen transcript capability", () => {
	test("persisted IDs, visual-only jumps, viewport notifications, resize, and display modes", async () => {
		const snapshots: TranscriptViewport[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_start", (_event, ctx) => {
						ctx.ui.transcript?.onViewportChange((viewport) => snapshots.push(viewport));
					});
				},
			],
			settings: { quietStartup: true, tuiMode: "fullscreen", compaction: { enabled: false } },
		});
		const terminal = new VirtualTerminal(100, 30);
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("This test must not replace the session");
			},
		);
		const mode = new InteractiveMode(runtime, { terminal, tuiMode: "fullscreen" });
		try {
			await mode.init();
			for (let turn = 1; turn <= 3; turn++) {
				harness.setResponses([
					fauxAssistantMessage(
						`ANSWER ${turn}\n\n${Array.from({ length: 20 }, (_, i) => `Detail ${turn}.${i + 1}`).join("\n")}`,
					),
				]);
				await harness.session.prompt(`Question ${turn}`);
			}
			await flush(terminal);
			const ui = harness.session.extensionRunner.getUIContext();
			const entries = ui.transcript!.getEntries();
			expect(entries.map((entry) => entry.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			expect(snapshots.at(-1)?.entries).toEqual(entries);
			expect(snapshots.at(-1)?.contentWidth).toBe(100);
			const leaf = harness.sessionManager.getLeafId();
			const context = [...harness.session.messages];
			expect(ui.transcript!.scrollToEntry(entries[0]!.id)).toBe(true);
			await flush(terminal);
			expect(terminal.getViewport().slice(0, 4).join("\n")).toContain("Question 1");
			expect(ui.transcript!.getActiveEntryId()).toBe(entries[0]!.id);
			expect(snapshots.at(-1)?.followingEnd).toBe(false);
			expect(harness.sessionManager.getLeafId()).toBe(leaf);
			expect(harness.session.messages).toEqual(context);

			ui.transcript!.scrollToEntry(entries[1]!.id);
			await flush(terminal);
			expect(ui.transcript!.getActiveEntryId()).toBe(entries[1]!.id);
			terminal.sendInput("\x1b[1;6A");
			await flush(terminal);
			expect(ui.transcript!.getActiveEntryId()).toBe(entries[0]!.id);
			terminal.sendInput("\x1b[1;6B");
			await flush(terminal);
			expect(ui.transcript!.getActiveEntryId()).toBe(entries[1]!.id);
			const beforeWheel = snapshots.at(-1)!.scrollTop;
			terminal.sendInput("\x1b[<65;1;1M");
			await flush(terminal);
			expect(snapshots.at(-1)!.scrollTop).toBeGreaterThan(beforeWheel);
			terminal.resize(45, 24);
			await flush(terminal);
			expect(snapshots.at(-1)?.contentWidth).toBe(45);
			expect(ui.transcript!.getEntries()).toEqual(entries);

			const switchMode = Reflect.get(mode, "switchTuiMode") as (
				display: "regular" | "fullscreen",
				restoreProgress: boolean,
			) => boolean;
			expect(switchMode.call(mode, "regular", false)).toBe(true);
			await flush(terminal);
			expect(ui.transcript).toBeUndefined();
			expect(switchMode.call(mode, "fullscreen", false)).toBe(true);
			await flush(terminal);
			expect(ui.transcript!.getEntries()).toEqual(entries);
		} finally {
			const count = snapshots.length;
			mode.stop("resume-hint");
			await Promise.resolve();
			expect(snapshots).toHaveLength(count);
			harness.cleanup();
		}
	});

	test("UI wrapping preserves a dynamic fullscreen capability", async () => {
		const harness = await createHarness();
		try {
			const ui = createTestUiContext();
			let fullscreen = false;
			const transcript = {
				getEntries: () => [],
				getActiveEntryId: () => undefined,
				scrollToEntry: () => false,
				onViewportChange: () => () => {},
			};
			Object.defineProperty(ui, "transcript", {
				enumerable: true,
				get: () => (fullscreen ? transcript : undefined),
			});
			harness.session.extensionRunner.setUIContext(ui, "tui");
			const wrapped = harness.session.extensionRunner.getUIContext();
			expect(wrapped.transcript).toBeUndefined();
			fullscreen = true;
			expect(wrapped.transcript).toBe(transcript);
			fullscreen = false;
			expect(wrapped.transcript).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
