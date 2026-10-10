import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container, ScrollView, Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { TranscriptDocument, TranscriptNavigation } from "../src/modes/interactive/transcript-navigation.ts";

function fixture() {
	const session = SessionManager.inMemory();
	const chat = new Container();
	const observed = vi.fn();
	const document = new TranscriptDocument(chat, observed);
	document.addChild(new Text("header\nresources", 0, 0));
	document.addChild(chat);
	const scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar: "hidden" });
	const requestRender = vi.fn();
	let supported = true;
	const onError = vi.fn();
	const navigation = new TranscriptNavigation({
		document,
		getBranch: () => session.getBranch(),
		getScrollView: () => (supported ? scroll : undefined),
		requestRender,
		onError,
	});
	function add(text: string, persist = true) {
		const message: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
		const component = new Text(text, 0, 0);
		chat.addChild(component);
		document.bind(component, message);
		const id = persist ? session.appendMessage(message) : undefined;
		return { id, message, component };
	}
	function frame(width = 20, height = 4) {
		renderLayoutFrame(scroll, width, height, requestRender);
		navigation.observeFrame();
	}
	return {
		session,
		chat,
		document,
		scroll,
		navigation,
		requestRender,
		onError,
		observed,
		add,
		frame,
		disable: () => {
			supported = false;
		},
	};
}

describe("transcript navigation", () => {
	test("jumps by persisted ID including header/tool offsets, without changing the branch", () => {
		const f = fixture();
		const first = f.add("first\nline\nline");
		f.chat.addChild(new Text("tool\noutput\noutput", 0, 0));
		const second = f.add("second\nline\nline\nline\nline");
		f.frame();
		const branch = f.session.getBranch();
		const leaf = f.session.getLeafId();
		expect(f.navigation.getEntries().map((entry) => entry.id)).toEqual([first.id, second.id]);
		expect(f.navigation.scrollToEntry(second.id!)).toBe(true);
		expect(f.scroll.scrollTop).toBe(8);
		expect(f.navigation.getActiveEntryId()).toBe(second.id);
		expect(f.navigation.scrollToEntry(first.id!)).toBe(true);
		expect(f.scroll.scrollTop).toBe(2);
		expect(f.session.getLeafId()).toBe(leaf);
		expect(f.session.getBranch()).toEqual(branch);
		expect(f.navigation.scrollToEntry("missing")).toBe(false);
	});

	test("resolves live messages after persistence rather than guessing by text or timestamp", async () => {
		const f = fixture();
		const pending = f.add("duplicate", false);
		f.frame();
		expect(f.navigation.getEntries()).toEqual([]);
		const id = f.session.appendMessage(pending.message);
		expect(f.navigation.getEntries()).toEqual([{ id, role: "user" }]);
		f.add("duplicate");
		f.frame();
		expect(f.navigation.getEntries()).toHaveLength(2);
		await Promise.resolve();
	});

	test("remeasures wrapping at the effective chat width and after content changes", () => {
		const f = fixture();
		const first = f.add("界界界界界界界界界界");
		const second = f.add("second\nline\nline\nline\nline");
		f.frame(20);
		f.navigation.scrollToEntry(second.id!);
		const wideOffset = f.scroll.scrollTop;
		f.frame(8);
		f.navigation.scrollToEntry(second.id!);
		expect(f.scroll.scrollTop).toBeGreaterThan(wideOffset);
		first.component.setText("expanded\nexpanded\nexpanded\nexpanded\nexpanded");
		f.navigation.scrollToEntry(second.id!);
		expect(f.scroll.scrollTop).toBe(8); // Header wraps to three rows at width 8.
	});

	test("short final messages clamp safely and do not resume automatic following", () => {
		const f = fixture();
		f.add("one\ntwo\nthree\nfour\nfive\nsix");
		const last = f.add("last");
		f.frame(20, 4);
		expect(f.navigation.scrollToEntry(last.id!)).toBe(true);
		expect(f.scroll.scrollTop).toBe(5);
		expect(f.scroll.isFollowingEnd).toBe(false);
	});

	test("excludes removed, invisible, and other-branch entries", () => {
		const f = fixture();
		const first = f.add("first");
		const abandoned = f.add("abandoned");
		f.session.branch(first.id!);
		f.frame();
		expect(f.navigation.getEntries().map((entry) => entry.id)).toEqual([first.id]);
		expect(f.navigation.scrollToEntry(abandoned.id!)).toBe(false);
		f.chat.clear();
		f.frame();
		expect(f.navigation.getEntries()).toEqual([]);
	});

	test("reports every kind of viewport change after the frame, without render loops", async () => {
		const f = fixture();
		f.add("one\ntwo\nthree\nfour\nfive\nsix");
		const listener = vi.fn();
		const unsubscribe = f.navigation.onViewportChange(listener);
		f.frame();
		expect(listener).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(1);
		f.frame();
		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(1);
		f.scroll.scrollBy(-1);
		f.frame();
		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(2);
		f.frame(12, 3);
		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(3);
		unsubscribe();
		f.frame(10, 2);
		await Promise.resolve();
		expect(listener).toHaveBeenCalledTimes(3);
	});

	test("reload cancels stale notifications and listener errors are isolated", async () => {
		const f = fixture();
		f.add("one");
		const old = vi.fn();
		f.navigation.onViewportChange(old);
		f.frame();
		f.navigation.reset();
		await Promise.resolve();
		expect(old).not.toHaveBeenCalled();
		f.navigation.onViewportChange(() => {
			throw new Error("extension failure");
		});
		const healthy = vi.fn();
		f.navigation.onViewportChange(healthy);
		f.frame();
		await Promise.resolve();
		expect(f.onError).toHaveBeenCalledTimes(1);
		expect(healthy).toHaveBeenCalledTimes(1);
	});

	test("indexes assistant text alongside tool calls without relying on OSC prompt markers", () => {
		initTheme("dark");
		const f = fixture();
		const message = fauxAssistantMessage([
			{ type: "text", text: "Inspecting the project" },
			{ type: "toolCall", id: "call1", name: "read", arguments: { path: "README.md" } },
		]);
		const id = f.session.appendMessage(message);
		const component = new AssistantMessageComponent(message);
		f.chat.addChild(component);
		f.document.bind(component, message);
		f.add("last\nline\nline\nline\nline");
		f.frame();
		expect(component.render(20).join("\n")).not.toContain("\x1b]133;A");
		expect(f.navigation.getEntries()[0]).toEqual({ id, role: "assistant" });
		expect(f.navigation.scrollToEntry(id)).toBe(true);
	});

	test("retains entry IDs for reconstructed/projected messages", () => {
		const f = fixture();
		const original = f.add("original");
		const projected: AgentMessage = { role: "user", content: "projected", timestamp: 1 };
		f.document.bind(original.component, projected);
		f.document.identify(projected, original.id!);
		f.frame();
		expect(f.navigation.getEntries()).toEqual([{ id: original.id, role: "user" }]);
	});

	test("remeasurement for a jump does not notify until an actual frame renders", () => {
		const f = fixture();
		const entry = f.add("one\ntwo\nthree\nfour\nfive");
		f.frame();
		const before = f.observed.mock.calls.length;
		f.navigation.scrollToEntry(entry.id!);
		expect(f.observed).toHaveBeenCalledTimes(before);
		f.frame();
		expect(f.observed.mock.calls.length).toBeGreaterThan(before);
	});

	test("navigation is unavailable outside fullscreen", () => {
		const f = fixture();
		const first = f.add("first");
		f.frame();
		f.disable();
		expect(f.navigation.getEntries()).toEqual([]);
		expect(f.navigation.getActiveEntryId()).toBeUndefined();
		expect(f.navigation.scrollToEntry(first.id!)).toBe(false);
	});
});
