import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container, type ScrollView } from "@earendil-works/pi-tui";
import type { ExtensionTranscriptContext, TranscriptEntry, TranscriptViewport } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";

interface Anchor {
	message: AgentMessage;
	start: number;
	end: number;
}

/** Index the actual rendered document, including headers, spacing, and tool output. */
export class TranscriptDocument extends Container {
	private readonly chat: Container;
	private readonly onFrame: (() => void) | undefined;
	private sources = new WeakMap<Component, AgentMessage>();
	private entryIds = new WeakMap<AgentMessage, string>();
	private anchors: Anchor[] = [];
	contentWidth = 0;
	contentHeight = 0;

	constructor(chat: Container, onFrame?: () => void) {
		super();
		this.chat = chat;
		this.onFrame = onFrame;
	}

	bind(component: Component, message: AgentMessage): void {
		this.sources.set(component, message);
	}

	identify(message: AgentMessage, entryId: string): void {
		this.entryIds.set(message, entryId);
	}

	getAnchors(branch: readonly SessionEntry[]): Array<TranscriptEntry & { start: number; end: number }> {
		// Live message_end is dispatched before persistence. Resolve its ID lazily, after the frame.
		const liveIds = new Map<AgentMessage, string>();
		const branchIds = new Set<string>();
		for (const entry of branch) {
			branchIds.add(entry.id);
			if (entry.type === "message") liveIds.set(entry.message, entry.id);
		}
		const result: Array<TranscriptEntry & { start: number; end: number }> = [];
		const seen = new Set<string>();
		for (const anchor of this.anchors) {
			const { message } = anchor;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const id = this.entryIds.get(message) ?? liveIds.get(message);
			if (!id || !branchIds.has(id) || seen.has(id)) continue;
			seen.add(id);
			result.push({ id, role: message.role, start: anchor.start, end: anchor.end });
		}
		return result;
	}

	override render(width: number, observe = true): string[] {
		const lines = super.render(width);
		const anchors: Anchor[] = [];
		let offset = 0;
		for (const child of this.children) {
			if (child === this.chat) {
				for (const component of this.chat.children) {
					const height = component.render(width).length;
					const message = this.sources.get(component);
					if (message && height > 0) anchors.push({ message, start: offset, end: offset + height });
					offset += height;
				}
			} else {
				offset += child.render(width).length;
			}
		}
		this.anchors = anchors;
		this.contentWidth = width;
		this.contentHeight = lines.length;
		if (observe) this.onFrame?.();
		return lines;
	}
}

/** Visual-only navigation; never changes the session leaf or model context. */
export class TranscriptNavigation implements ExtensionTranscriptContext {
	private readonly document: TranscriptDocument;
	private readonly getBranch: () => readonly SessionEntry[];
	private readonly getScrollView: () => ScrollView | undefined;
	private readonly requestRender: () => void;
	private readonly onError: (error: unknown) => void;
	private listeners = new Set<(viewport: TranscriptViewport) => void>();
	private previousSignature = "";
	private scheduled = false;
	private generation = 0;

	constructor(options: {
		document: TranscriptDocument;
		getBranch: () => readonly SessionEntry[];
		getScrollView: () => ScrollView | undefined;
		requestRender: () => void;
		onError: (error: unknown) => void;
	}) {
		this.document = options.document;
		this.getBranch = options.getBranch;
		this.getScrollView = options.getScrollView;
		this.requestRender = options.requestRender;
		this.onError = options.onError;
	}

	getEntries(): readonly TranscriptEntry[] {
		if (!this.getScrollView()) return [];
		return this.document.getAnchors(this.getBranch()).map(({ id, role }) => ({ id, role }));
	}

	getActiveEntryId(): string | undefined {
		const scrollView = this.getScrollView();
		if (!scrollView) return undefined;
		return this.document.getAnchors(this.getBranch()).findLast((entry) => entry.start <= scrollView.scrollTop)?.id;
	}

	scrollToEntry(entryId: string): boolean {
		const scrollView = this.getScrollView();
		if (!scrollView || !this.document.contentWidth) return false;
		// Remeasure at the last effective chat width, which can exclude a scrollbar.
		this.document.render(this.document.contentWidth, false);
		const entry = this.document.getAnchors(this.getBranch()).find((anchor) => anchor.id === entryId);
		if (!entry) return false;
		scrollView.updateLayout(this.document.contentHeight, scrollView.viewportHeight, this.requestRender);
		scrollView.scrollTo(entry.start, { disableFollow: true });
		this.requestRender();
		return true;
	}

	onViewportChange(handler: (viewport: TranscriptViewport) => void): () => void {
		this.listeners.add(handler);
		this.previousSignature = "";
		this.requestRender();
		return () => this.listeners.delete(handler);
	}

	/** Scheduled by document rendering; deliver snapshots after the completed frame. */
	observeFrame(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		const generation = this.generation;
		queueMicrotask(() => {
			if (generation !== this.generation) return;
			this.scheduled = false;
			const scrollView = this.getScrollView();
			const viewport: TranscriptViewport = {
				entries: this.getEntries(),
				activeEntryId: this.getActiveEntryId(),
				scrollTop: scrollView?.scrollTop ?? 0,
				viewportHeight: scrollView?.viewportHeight ?? 0,
				contentWidth: this.document.contentWidth,
				contentHeight: this.document.contentHeight,
				followingEnd: scrollView?.isFollowingEnd ?? false,
			};
			const signature = JSON.stringify(viewport);
			if (signature === this.previousSignature) return;
			this.previousSignature = signature;
			for (const handler of [...this.listeners]) {
				try {
					handler(viewport);
				} catch (error) {
					// A failing listener must not create a notify/render/error loop.
					this.listeners.delete(handler);
					this.onError(error);
				}
			}
		});
	}

	reset(): void {
		this.generation++;
		this.scheduled = false;
		this.listeners.clear();
		this.previousSignature = "";
	}
}
